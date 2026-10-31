#!/bin/bash
set -euo pipefail
umask 077
if [[ ${APCIDA_PHASE5_SMOKE:-} != true ]]; then
  echo 'Set APCIDA_PHASE5_SMOKE=true for the disposable invite test.' >&2
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
const { createProductionRepository } = require('./src/production/repository');
const { createInviteRepository, issueInvite, hashInvite,
  createCloudflareTokenClient } = require('./src/production/inviteEnrollment');
const { randomUUID } = require('node:crypto');
const { validateProductionResponse } = require('./src/production/smsContract');

const origin = 'https://sms.apcida.stream';
const pool = createDatabasePool(process.env.DATABASE_URL);
const repository = createProductionRepository(pool);
const invites = createInviteRepository(pool);
const cf = createCloudflareTokenClient({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_PROVISIONING_API_TOKEN });
let code, installationId;

async function request(path, options = {}) {
  return fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(25000), ...options });
}
function expect(response, status, label) {
  process.stdout.write(`${label}: HTTP ${response.status}\n`);
  if (response.status !== status) throw new Error(`${label} returned unexpected status`);
}

(async () => {
  try {
    ({ code } = await issueInvite(invites, { label: 'DisposablePhase5Check' }));
    const enroll = () => request('/api/v1/enrollment', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteCode: code }) });
    const first = await enroll();
    expect(first, 201, 'One-time invite');
    const credentials = await first.json();
    installationId = credentials.installationId;
    if (!/^[A-Za-z0-9_-]{43}$/.test(credentials.installationToken) ||
      !credentials.clientId || !credentials.clientSecret) throw new Error('Invalid enrollment response');
    expect(await enroll(), 401, 'Invite replay');
    const access = { 'CF-Access-Client-Id': credentials.clientId,
      'CF-Access-Client-Secret': credentials.clientSecret };
    let accessCheck;
    let accessAttempts = 0;
    for (; accessAttempts < 7; accessAttempts++) {
      accessCheck = await request('/health', { headers: access });
      if (accessCheck.status === 200) break;
      if (accessAttempts < 6) await new Promise(resolve => setTimeout(resolve, 5000));
    }
    process.stdout.write(`Cloudflare credential checks: ${accessAttempts + 1}\n`);
    expect(accessCheck, 200, 'New phone Access token');
    expect(await request('/api/v1/sms/analyze', { method: 'POST',
      headers: { ...access, authorization: `Bearer ${credentials.installationToken}`,
        'content-type': 'application/json' }, body: JSON.stringify({ invalid: true }) }),
    400, 'Authenticated invalid-body check');
    if (process.env.APCIDA_PHASE5_RELIABILITY === 'true') {
      const samples = [
        ['scam-1', 'Invented test: Your bank account will be frozen today. Reply with your one-time code.'],
        ['safe', 'Invented test: Reminder, your library book is due tomorrow.'],
        ['scam-2', 'Invented test: Your parcel is on hold. Pay a small delivery fee to release it.'],
      ];
      let firstRequest;
      for (const [label, message] of samples) {
        const messageId = randomUUID();
        const options = { method: 'POST', signal: AbortSignal.timeout(110000), headers: { ...access,
          authorization: `Bearer ${credentials.installationToken}`,
          'idempotency-key': messageId, 'content-type': 'application/json' },
        body: JSON.stringify({ messageId, sender: 'ReliabilityTest', text: message,
          receivedAt: new Date().toISOString() }) };
        const started = Date.now();
        const response = await request('/api/v1/sms/analyze', options);
        const elapsed = Date.now() - started;
        const payload = await response.json();
        process.stdout.write(`${label}: HTTP ${response.status}, ${elapsed} ms, ${payload.classification || payload.error || 'unknown'}\n`);
        if (response.status !== 200 || !validateProductionResponse(payload, messageId)) {
          throw new Error(`${label} analysis failed`);
        }
        if (!firstRequest) firstRequest = { options, payload };
      }
      const replayStart = Date.now();
      const replay = await request('/api/v1/sms/analyze', {
        ...firstRequest.options, signal: AbortSignal.timeout(15000) });
      const replayPayload = await replay.json();
      process.stdout.write(`duplicate replay: HTTP ${replay.status}, ${Date.now() - replayStart} ms\n`);
      if (replay.status !== 200 || JSON.stringify(replayPayload) !== JSON.stringify(firstRequest.payload)) {
        throw new Error('Duplicate replay mismatch');
      }
    }
    expect(await request('/api/v1/installations/me', { method: 'DELETE',
      headers: { ...access, authorization: `Bearer ${credentials.installationToken}` } }),
    204, 'Installation self-revocation');
    process.stdout.write(process.env.APCIDA_PHASE5_RELIABILITY === 'true'
      ? 'Disposable protected invite flow passed. Only invented test messages were analyzed.\n'
      : 'Disposable protected invite flow passed. No SMS was analyzed.\n');
  } finally {
    if (installationId) {
      await repository.revoke(installationId).catch(() => {});
      const result = await pool.query(`SELECT cf_service_token_id AS "cfTokenId"
        FROM production_installations WHERE installation_id = $1`, [installationId]);
      const cfTokenId = result.rows[0]?.cfTokenId;
      if (cfTokenId) {
        await cf.remove(cfTokenId);
        await invites.markCloudflareTokenRemoved(installationId, cfTokenId);
      }
    }
    if (code) await pool.query('DELETE FROM production_enrollment_invites WHERE invite_hash = $1',
      [hashInvite(code)]);
    if (installationId) await pool.query('DELETE FROM production_installations WHERE installation_id = $1',
      [installationId]);
    await pool.end();
  }
})().catch(() => {
  process.stderr.write('Disposable invite flow failed; inspect the private database before retrying.\n');
  process.exitCode = 1;
});
NODE
