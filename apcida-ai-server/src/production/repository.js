const { timingSafeEqual } = require('node:crypto');

function matchingHmac(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    /^[0-9a-f]{64}$/u.test(a) && /^[0-9a-f]{64}$/u.test(b) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function createProductionRepository(pool) {
  if (!pool?.query) throw new TypeError('Production database pool is required');
  return {
    async createInstallation({ installationId, label, tokenHash, expiresAt }) {
      await pool.query(`INSERT INTO production_installations
        (installation_id, label, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [installationId, label, tokenHash, new Date(expiresAt)]);
      return installationId;
    },
    async findByTokenHash(tokenHash) {
      const result = await pool.query(`SELECT installation_id AS "installationId",
        (EXTRACT(EPOCH FROM expires_at) * 1000)::double precision AS "expiresAt",
        revoked_at AS "revokedAt" FROM production_installations
        WHERE token_hash = $1 LIMIT 1`, [tokenHash]);
      return result.rows[0] || null;
    },
    async isActive(installationId) {
      const result = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM production_installations WHERE installation_id = $1
          AND revoked_at IS NULL AND expires_at > now()) AS active`, [installationId]);
      return result.rows[0]?.active === true;
    },
    async revoke(installationId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE production_installations SET revoked_at = now()
          WHERE installation_id = $1 AND revoked_at IS NULL RETURNING installation_id`, [installationId]);
        if (result.rowCount === 1) {
          const reportSchema = await client.query("SELECT to_regclass('public.production_reports') AS table_name");
          if (reportSchema.rows[0]?.table_name) {
            await client.query(`DELETE FROM production_reports WHERE installation_id = $1`, [installationId]);
          }
          await client.query(`DELETE FROM production_inference_requests WHERE installation_id = $1`, [installationId]);
          await client.query(`DELETE FROM production_rate_windows WHERE installation_id = $1`, [installationId]);
        }
        await client.query('COMMIT');
        return result.rowCount === 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async status(installationId) {
      const result = await pool.query(`SELECT installation_id AS "installationId", label,
        issued_at AS "issuedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"
        FROM production_installations WHERE installation_id = $1`, [installationId]);
      return result.rows[0] || null;
    },
    async renewalCandidate(installationId) {
      const result = await pool.query(`SELECT cf_service_token_id AS "cfTokenId",
        (EXTRACT(EPOCH FROM expires_at) * 1000)::double precision AS "expiresAt"
        FROM production_installations WHERE installation_id = $1
          AND revoked_at IS NULL AND expires_at > now()`, [installationId]);
      return result.rows[0] || null;
    },
    async extendExpiry(installationId, cfTokenId, expiresAt) {
      const result = await pool.query(`UPDATE production_installations
        SET expires_at = GREATEST(expires_at, $3::timestamptz)
        WHERE installation_id = $1 AND cf_service_token_id = $2
          AND revoked_at IS NULL AND expires_at > now()
        RETURNING (EXTRACT(EPOCH FROM expires_at) * 1000)::double precision AS "expiresAt"`,
      [installationId, cfTokenId, new Date(expiresAt)]);
      return result.rows[0]?.expiresAt || null;
    },
    async countRequest(installationId, limit) {
      const result = await pool.query(`INSERT INTO production_rate_windows
        (installation_id, window_start, request_count)
        VALUES ($1, date_trunc('minute', now()), 1)
        ON CONFLICT (installation_id, window_start)
        DO UPDATE SET request_count = production_rate_windows.request_count + 1
        RETURNING request_count`, [installationId]);
      return result.rows[0].request_count <= limit;
    },
    async submitReport({ installationId, clientReportId, contentHmac, encrypted }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize submissions and revocation for this installation.
        const active = await client.query(`SELECT installation_id FROM production_installations
          WHERE installation_id = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [installationId]);
        if (!active.rowCount) { await client.query('ROLLBACK'); return 'UNAUTHORIZED'; }
        const existing = await client.query(`SELECT content_hmac AS "contentHmac" FROM production_reports
          WHERE installation_id = $1 AND client_report_id = $2`, [installationId, clientReportId]);
        if (existing.rowCount) {
          await client.query('COMMIT');
          return matchingHmac(existing.rows[0].contentHmac, contentHmac) ? 'REPLAY' : 'CONFLICT';
        }
        const daily = await client.query(`SELECT count(*)::integer AS total FROM production_reports
          WHERE installation_id = $1 AND created_at >= now() - interval '24 hours'`, [installationId]);
        if (daily.rows[0].total >= 20) { await client.query('COMMIT'); return 'RATE_LIMITED'; }
        await client.query(`INSERT INTO production_reports
          (installation_id, client_report_id, content_hmac, content_encrypted)
          VALUES ($1, $2, $3, $4)`, [installationId, clientReportId, contentHmac, encrypted]);
        await client.query('COMMIT');
        return 'CREATED';
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async acquireSlot(leaseOwner, leaseSeconds) {
      const result = await pool.query(`UPDATE production_inference_slot
        SET lease_owner = $1, lease_until = now() + $2::integer * interval '1 second'
        WHERE slot_id = 1 AND (lease_owner IS NULL OR lease_until <= now())
        RETURNING slot_id`, [leaseOwner, leaseSeconds]);
      return result.rowCount === 1;
    },
    async releaseSlot(leaseOwner) {
      await pool.query(`UPDATE production_inference_slot SET lease_owner = NULL, lease_until = NULL
        WHERE slot_id = 1 AND lease_owner = $1`, [leaseOwner]);
    },
    async claim({ installationId, messageId, requestHmac, leaseOwner, leaseSeconds, retentionSeconds }) {
      await pool.query(`DELETE FROM production_inference_requests
        WHERE installation_id = $1 AND message_id = $2 AND expires_at <= now()`,
      [installationId, messageId]);
      const values = [installationId, messageId, requestHmac, leaseOwner, leaseSeconds, retentionSeconds];
      const inserted = await pool.query(`INSERT INTO production_inference_requests
        (installation_id, message_id, request_hmac, status, lease_owner, lease_until, expires_at)
        VALUES ($1, $2, $3, 'PROCESSING', $4,
          now() + $5::integer * interval '1 second', now() + $6::integer * interval '1 second')
        ON CONFLICT DO NOTHING RETURNING message_id`, values);
      if (inserted.rowCount === 1) return { kind: 'CLAIMED' };
      const existing = await pool.query(`SELECT request_hmac AS "requestHmac", status,
        response_encrypted AS "responseEncrypted",
        (lease_until <= now()) AS "leaseExpired"
        FROM production_inference_requests WHERE installation_id = $1 AND message_id = $2`,
      [installationId, messageId]);
      const row = existing.rows[0];
      if (!row) return { kind: 'BUSY' };
      if (row.requestHmac !== requestHmac) return { kind: 'CONFLICT' };
      if (row.status === 'COMPLETED') return { kind: 'REPLAY', encrypted: row.responseEncrypted };
      if (!row.leaseExpired) return { kind: 'BUSY' };
      const recovered = await pool.query(`UPDATE production_inference_requests
        SET lease_owner = $4, lease_until = now() + $5::integer * interval '1 second'
        WHERE installation_id = $1 AND message_id = $2 AND request_hmac = $3
          AND status = 'PROCESSING' AND lease_until <= now()
        RETURNING message_id`, values.slice(0, 5));
      return recovered.rowCount === 1 ? { kind: 'CLAIMED' } : { kind: 'BUSY' };
    },
    async complete({ installationId, messageId, leaseOwner, encrypted }) {
      const result = await pool.query(`UPDATE production_inference_requests
        SET status = 'COMPLETED', response_encrypted = $4,
          completed_at = now(), lease_until = now()
        WHERE installation_id = $1 AND message_id = $2 AND lease_owner = $3
          AND status = 'PROCESSING' RETURNING message_id`,
      [installationId, messageId, leaseOwner, encrypted]);
      return result.rowCount === 1;
    },
    async release({ installationId, messageId, leaseOwner }) {
      await pool.query(`DELETE FROM production_inference_requests
        WHERE installation_id = $1 AND message_id = $2 AND lease_owner = $3
          AND status = 'PROCESSING'`, [installationId, messageId, leaseOwner]);
    },
    async purge(retentionSeconds) {
      const reportSchema = await pool.query("SELECT to_regclass('public.production_reports') AS table_name");
      const reports = reportSchema.rows[0]?.table_name
        ? await pool.query(`DELETE FROM production_reports WHERE expires_at <= now()`)
        : { rowCount: 0 };
      const requests = await pool.query(`DELETE FROM production_inference_requests WHERE expires_at <= now()`);
      const rates = await pool.query(`DELETE FROM production_rate_windows
        WHERE window_start < now() - $1::integer * interval '1 second'`, [retentionSeconds]);
      return { reports: reports.rowCount, requests: requests.rowCount, rates: rates.rowCount };
    },
    async purgeInactiveInstallations(retentionDays) {
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
        throw new TypeError('Identity retention must be 1-3650 days');
      }
      // FK cascades clear any remaining inference/cache rows for these identities.
      const result = await pool.query(`DELETE FROM production_installations
        WHERE (revoked_at IS NOT NULL AND revoked_at <= now() - $1::integer * interval '1 day')
           OR expires_at <= now() - $1::integer * interval '1 day'`, [retentionDays]);
      return result.rowCount;
    },
  };
}

async function checkProductionRepository(pool) {
  const result = await pool.query(`SELECT
    to_regclass('public.production_installations') IS NOT NULL AS installations,
    to_regclass('public.production_inference_requests') IS NOT NULL AS requests,
    to_regclass('public.production_rate_windows') IS NOT NULL AS rates,
    to_regclass('public.production_inference_slot') IS NOT NULL AS slot`);
  if (!result.rows[0]?.installations || !result.rows[0]?.requests ||
    !result.rows[0]?.rates || !result.rows[0]?.slot) {
    throw new Error('Production schema unavailable; run migrations after approval');
  }
}

module.exports = { createProductionRepository, checkProductionRepository };
