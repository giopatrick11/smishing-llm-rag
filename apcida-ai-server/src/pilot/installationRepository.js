function createInstallationRepository(pool) {
  if (!pool?.query) throw new TypeError('Pilot database pool is required');
  return {
    async create({ installationId, label, tokenHash, expiresAt }) {
      await pool.query(
        `INSERT INTO pilot_installations (installation_id, label, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [installationId, label, tokenHash, new Date(expiresAt)],
      );
      return installationId;
    },
    async findByTokenHash(tokenHash) {
      const result = await pool.query(
        `SELECT installation_id AS "installationId",
                (EXTRACT(EPOCH FROM expires_at) * 1000)::double precision AS "expiresAt",
                revoked_at AS "revokedAt"
         FROM pilot_installations WHERE token_hash = $1 LIMIT 1`,
        [tokenHash],
      );
      return result.rows[0] || null;
    },
    async revoke(installationId) {
      const result = await pool.query(
        `UPDATE pilot_installations SET revoked_at = now()
         WHERE installation_id = $1 AND revoked_at IS NULL
         RETURNING installation_id`,
        [installationId],
      );
      return result.rowCount === 1;
    },
    async status(installationId) {
      const result = await pool.query(
        `SELECT installation_id AS "installationId", label, issued_at AS "issuedAt",
                expires_at AS "expiresAt", revoked_at AS "revokedAt"
         FROM pilot_installations WHERE installation_id = $1`,
        [installationId],
      );
      return result.rows[0] || null;
    },
  };
}

async function checkInstallationRepository(pool) {
  const result = await pool.query("SELECT to_regclass('public.pilot_installations') IS NOT NULL AS ready");
  if (!result.rows[0]?.ready) throw new Error('Pilot auth schema unavailable; run npm run db:migrate');
}

module.exports = { createInstallationRepository, checkInstallationRepository };
