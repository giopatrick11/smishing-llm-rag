#!/bin/bash
set -euo pipefail
umask 077
if [[ ${APCIDA_PHASE7_RENEWAL_VERIFY:-} != true ]]; then
  echo 'Set APCIDA_PHASE7_RENEWAL_VERIFY=true for the disposable renewal check.' >&2
  exit 1
fi
backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_env="$HOME/Library/Application Support/ApCiDa/controlled-server/production.env"
if [[ ! -r $private_env ]]; then
  echo 'Private controlled-server configuration is missing.' >&2
  exit 1
fi
cd "$backend_dir"
APCIDA_PRIVATE_ENV="$private_env" node <<'NODE'
require('dotenv').config({ path: process.env.APCIDA_PRIVATE_ENV, quiet: true });
const { createDatabasePool } = require('./src/db/pool');
const { createInviteRepository, issueInvite, hashInvite,
  createCloudflareTokenClient } = require('./src/production/inviteEnrollment');
const pool = createDatabasePool(process.env.DATABASE_URL);
const invites = createInviteRepository(pool);
const cloudflare = createCloudflareTokenClient({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_PROVISIONING_API_TOKEN });
const origin = 'https://sms.apcida.stream';
let code, installationId;
const request = (path, options = {}) => fetch(origin + path,
  { redirect: 'manual', signal: AbortSignal.timeout(25000), ...options });

(async () => {
  try {
    ({ code } = await issueInvite(invites, { label: 'DisposableRenewalCheck' }));
    const enrolled = await request('/api/v1/enrollment', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteCode: code }) });
    if (enrolled.status !== 201) throw Error(`Enrollment HTTP ${enrolled.status}`);
    const credentials = await enrolled.json();
    installationId = credentials.installationId;
    const access = { 'CF-Access-Client-Id': credentials.clientId,
      'CF-Access-Client-Secret': credentials.clientSecret };
    let ready = false;
    for (let attempt = 0; attempt < 7; attempt++) {
      const health = await request('/health', { headers: access });
      if (health.status === 200) { ready = true; break; }
      if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    if (!ready) throw Error('Cloudflare token did not become active');
    await pool.query(`UPDATE production_installations
      SET expires_at = now() + interval '6 days' WHERE installation_id = $1`, [installationId]);
    const renewed = await request('/api/v1/installations/me/renew', { method: 'POST',
      headers: { ...access, authorization: `Bearer ${credentials.installationToken}` } });
    if (renewed.status !== 200) throw Error(`Renewal HTTP ${renewed.status}`);
    const result = await renewed.json();
    const database = await pool.query(`SELECT (EXTRACT(EPOCH FROM expires_at) * 1000)::double precision
      AS "expiresAt" FROM production_installations WHERE installation_id = $1`, [installationId]);
    if (!Number.isFinite(result.expiresAt) || result.expiresAt < Date.now() + 28 * 86400000 ||
      Math.abs(database.rows[0].expiresAt - result.expiresAt) > 1000) {
      throw Error('Backend expiry was not extended after Cloudflare refresh');
    }
    console.log('Disposable Cloudflare and backend renewal passed; no SMS was sent.');
  } finally {
    if (installationId) {
      await pool.query(`UPDATE production_installations SET revoked_at = now()
        WHERE installation_id = $1 AND revoked_at IS NULL`, [installationId]).catch(() => {});
      const row = await pool.query(`SELECT cf_service_token_id AS "cfTokenId"
        FROM production_installations WHERE installation_id = $1`, [installationId]);
      const tokenId = row.rows[0]?.cfTokenId;
      if (tokenId) {
        await cloudflare.remove(tokenId);
        await invites.markCloudflareTokenRemoved(installationId, tokenId);
      }
    }
    if (code) await pool.query('DELETE FROM production_enrollment_invites WHERE invite_hash = $1',
      [hashInvite(code)]);
    if (installationId) await pool.query('DELETE FROM production_installations WHERE installation_id = $1',
      [installationId]);
    await pool.end();
  }
})().catch((error) => {
  console.error(`Disposable renewal failed: ${error.message}`);
  process.exitCode = 1;
});
NODE
