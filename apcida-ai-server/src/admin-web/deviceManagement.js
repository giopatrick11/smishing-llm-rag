const { createInviteRepository, issueInvite } = require('../production/inviteEnrollment');
const { createProductionRepository } = require('../production/repository');
const { validateInstallationId, validateLabel } = require('../production/enrollment');

const HASH = /^[0-9a-f]{64}$/u;

function createDeviceManagement(pool, cloudflare) {
  if (!pool?.query || !pool?.connect || typeof cloudflare?.remove !== 'function') {
    throw new TypeError('Invite and device management configuration is incomplete');
  }
  const invites = createInviteRepository(pool);
  const installations = createProductionRepository(pool);
  return {
    async listInvites() {
      const result = await pool.query(`SELECT invite_hash, label, created_at, expires_at,
        used_at, canceled_at, claim_until, installation_id
        FROM production_enrollment_invites ORDER BY created_at DESC LIMIT 100`);
      return result.rows;
    },
    async issue(label) {
      validateLabel(label);
      return issueInvite(invites, { label });
    },
    async cancel(hash) {
      if (!HASH.test(hash)) throw new TypeError('Invalid invite ID');
      const result = await pool.query(`UPDATE production_enrollment_invites
        SET canceled_at = now() WHERE invite_hash = $1 AND used_at IS NULL
          AND canceled_at IS NULL AND expires_at > now()
          AND (claimed_by IS NULL OR claim_until <= now())
        RETURNING invite_hash`, [hash]);
      return result.rowCount === 1;
    },
    async listDevices() {
      const result = await pool.query(`SELECT installation_id, label, issued_at,
        expires_at, revoked_at, cf_service_token_id
        FROM production_installations ORDER BY issued_at DESC LIMIT 100`);
      return result.rows;
    },
    async revoke(id) {
      validateInstallationId(id);
      const result = await pool.query(`SELECT revoked_at, cf_service_token_id
        FROM production_installations WHERE installation_id = $1`, [id]);
      const device = result.rows[0];
      if (!device) return { found: false };
      if (!device.revoked_at) await installations.revoke(id);
      if (device.cf_service_token_id) {
        try {
          await cloudflare.remove(device.cf_service_token_id);
          await invites.markCloudflareTokenRemoved(id, device.cf_service_token_id);
        } catch {
          // The backend is already revoked. Keep the token ID so cleanup can retry.
          return { found: true, cloudflareCleanupPending: true };
        }
      }
      return { found: true, cloudflareCleanupPending: false };
    },
  };
}

module.exports = { createDeviceManagement };
