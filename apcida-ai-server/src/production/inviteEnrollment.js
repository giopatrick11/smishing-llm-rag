const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { issueInstallationCredential } = require('./security');
const { validateLabel } = require('./enrollment');

const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DAY_MS = 86400000;

function hashInvite(code) {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw new TypeError('Invalid invite code');
  return createHash('sha256').update(code, 'ascii').digest('hex');
}

function createInviteRepository(pool) {
  if (!pool?.query || !pool?.connect) throw new TypeError('Database pool required');
  return {
    async issue({ hash, label, expiresAt }) {
      await pool.query(`INSERT INTO production_enrollment_invites (invite_hash, label, expires_at)
        VALUES ($1, $2, $3)`, [hash, label, new Date(expiresAt)]);
    },
    async claim(hash, claimId) {
      const result = await pool.query(`UPDATE production_enrollment_invites
        SET claimed_by = $2, claim_until = now() + interval '90 seconds'
        WHERE invite_hash = $1 AND expires_at > now() AND used_at IS NULL AND canceled_at IS NULL
          AND (claimed_by IS NULL OR claim_until <= now())
        RETURNING label`, [hash, claimId]);
      return result.rows[0] || null;
    },
    async release(hash, claimId) {
      await pool.query(`UPDATE production_enrollment_invites
        SET claimed_by = NULL, claim_until = NULL
        WHERE invite_hash = $1 AND claimed_by = $2 AND used_at IS NULL`, [hash, claimId]);
    },
    async finish({ hash, claimId, installationId, label, tokenHash, expiresAt, cfTokenId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const invite = await client.query(`SELECT label FROM production_enrollment_invites
          WHERE invite_hash = $1 AND claimed_by = $2 AND claim_until > now()
            AND used_at IS NULL AND canceled_at IS NULL AND expires_at > now() FOR UPDATE`, [hash, claimId]);
        if (invite.rowCount !== 1 || invite.rows[0].label !== label) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(`INSERT INTO production_installations
          (installation_id, label, token_hash, expires_at, cf_service_token_id)
          VALUES ($1, $2, $3, $4, $5)`,
        [installationId, label, tokenHash, new Date(expiresAt), cfTokenId]);
        await client.query(`UPDATE production_enrollment_invites
          SET used_at = now(), installation_id = $3, claimed_by = NULL, claim_until = NULL
          WHERE invite_hash = $1 AND claimed_by = $2`, [hash, claimId, installationId]);
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async purge() {
      await pool.query(`DELETE FROM production_enrollment_invites
        WHERE expires_at <= now() - interval '1 day'`);
    },
    async pendingCloudflareTokens() {
      const result = await pool.query(`SELECT installation_id AS "installationId",
        cf_service_token_id AS "cfTokenId" FROM production_installations
        WHERE cf_service_token_id IS NOT NULL
          AND (revoked_at IS NOT NULL OR expires_at <= now())
        ORDER BY issued_at LIMIT 20`);
      return result.rows;
    },
    async markCloudflareTokenRemoved(installationId, cfTokenId) {
      await pool.query(`UPDATE production_installations SET cf_service_token_id = NULL
        WHERE installation_id = $1 AND cf_service_token_id = $2`, [installationId, cfTokenId]);
    },
  };
}

async function issueInvite(repository, { label, now = Date.now } = {}) {
  validateLabel(label);
  const code = randomBytes(32).toString('base64url');
  const expiresAt = now() + DAY_MS;
  await repository.issue({ hash: hashInvite(code), label, expiresAt });
  return { code, expiresAt };
}

function createCloudflareTokenClient({ accountId, apiToken, fetchImpl = fetch }) {
  if (!/^[0-9a-f]{32}$/iu.test(accountId || '') ||
    typeof apiToken !== 'string' || apiToken.length < 20) {
    throw new TypeError('Cloudflare provisioning configuration required');
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens`;
  async function request(path, options) {
    const response = await fetchImpl(`${url}${path}`, {
      ...options, headers: { authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    });
    if (options.method === 'DELETE' && response.status === 404) return null;
    if (!response.ok) throw new Error('Cloudflare provisioning unavailable');
    if (response.status === 204) return null;
    const body = await response.json();
    if (body?.success !== true) throw new Error('Cloudflare provisioning unavailable');
    return body;
  }
  return {
    async create(installationId) {
      const body = await request('', { method: 'POST', body: JSON.stringify({
        name: `apcida-${installationId}`, duration: '720h', enabled: true,
      }) });
      const token = body?.result;
      if (!/^[A-Za-z0-9_-]{1,80}$/u.test(token?.id || '') ||
        !/^[A-Za-z0-9_-]{1,120}\.access(?:\.[A-Za-z0-9.-]{1,100})?$/u.test(token?.client_id || '') ||
        !/^[A-Za-z0-9_-]{32,256}$/u.test(token?.client_secret || '')) {
        throw new Error('Cloudflare provisioning unavailable');
      }
      return { id: token.id, clientId: token.client_id, clientSecret: token.client_secret };
    },
    async remove(id) {
      if (!/^[A-Za-z0-9_-]{1,80}$/u.test(id)) throw new TypeError('Invalid Cloudflare token ID');
      await request(`/${id}`, { method: 'DELETE' });
    },
    async refresh(id) {
      if (!/^[A-Za-z0-9_-]{1,80}$/u.test(id)) throw new TypeError('Invalid Cloudflare token ID');
      const body = await request(`/${id}/refresh`, { method: 'POST' });
      const token = body?.result;
      const expiresAt = Date.parse(token?.expires_at);
      if (token?.id !== id || token?.enabled === false || !Number.isFinite(expiresAt)) {
        throw new Error('Cloudflare service token refresh unavailable');
      }
      return { expiresAt };
    },
  };
}

/** Extend the existing phone credentials before either of them expires. */
async function renewInstallation(repository, cloudflare, installationId, { now = Date.now } = {}) {
  const current = await repository.renewalCandidate(installationId);
  if (!current || !current.cfTokenId || !Number.isFinite(current.expiresAt) ||
      current.expiresAt <= now()) return null;
  if (current.expiresAt - now() > 7 * DAY_MS) return current.expiresAt;
  const refreshed = await cloudflare.refresh(current.cfTokenId);
  // The backend expires a day before Cloudflare, as it does at enrollment.
  const expiresAt = Math.min(now() + 29 * DAY_MS, refreshed.expiresAt - DAY_MS);
  if (!Number.isFinite(expiresAt) || expiresAt <= current.expiresAt ||
      expiresAt <= now() + 7 * DAY_MS) {
    throw new Error('Cloudflare renewal did not extend the phone lifetime');
  }
  return repository.extendExpiry(installationId, current.cfTokenId, expiresAt);
}

async function redeemInvite(repository, cloudflare, code, { now = Date.now } = {}) {
  let hash;
  try { hash = hashInvite(code); } catch { return null; }
  const claimId = randomUUID();
  const invite = await repository.claim(hash, claimId);
  if (!invite) return null;
  const installationId = randomUUID();
  let cfToken;
  try {
    cfToken = await cloudflare.create(installationId);
    const { token, tokenHash } = issueInstallationCredential();
    // CF token lasts 30 days. The backend credential expires first.
    const expiresAt = now() + 29 * DAY_MS;
    const saved = await repository.finish({ hash, claimId, installationId, label: invite.label,
      tokenHash, expiresAt, cfTokenId: cfToken.id });
    if (!saved) throw new Error('Invite claim expired');
    return { installationId, installationToken: token, clientId: cfToken.clientId,
      clientSecret: cfToken.clientSecret, expiresAt };
  } catch (error) {
    if (cfToken) await cloudflare.remove(cfToken.id).catch(() => {});
    await repository.release(hash, claimId).catch(() => {});
    throw error;
  }
}

async function cleanupCloudflareTokens(repository, cloudflare) {
  let removed = 0;
  for (const row of await repository.pendingCloudflareTokens()) {
    try {
      await cloudflare.remove(row.cfTokenId);
      await repository.markCloudflareTokenRemoved(row.installationId, row.cfTokenId);
      removed++;
    } catch { /* Retain the ID for the next cleanup pass. */ }
  }
  return removed;
}

module.exports = { hashInvite, createInviteRepository, issueInvite,
  createCloudflareTokenClient, redeemInvite, renewInstallation, cleanupCloudflareTokens };
