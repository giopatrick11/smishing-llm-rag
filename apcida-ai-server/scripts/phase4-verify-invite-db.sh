#!/bin/bash
set -euo pipefail
umask 077
backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_env="$HOME/Library/Application Support/ApCiDa/controlled-server/production.env"
if [[ ! -r $private_env ]]; then
  echo 'Controlled private configuration is missing.' >&2
  exit 1
fi
cd "$backend_dir"
APCIDA_PRIVATE_ENV="$private_env" node <<'NODE'
require('dotenv').config({ path: process.env.APCIDA_PRIVATE_ENV, quiet: true });
const { createDatabasePool } = require('./src/db/pool');
const { createInviteRepository, issueInvite, redeemInvite, hashInvite } = require('./src/production/inviteEnrollment');
const { createProductionRepository } = require('./src/production/repository');

(async () => {
  const pool = createDatabasePool(process.env.DATABASE_URL);
  const invites = createInviteRepository(pool);
  let code, installationId;
  try {
    ({ code } = await issueInvite(invites, { label: 'DisposableInviteCheck' }));
    const fakeCloudflare = {
      async create() { return { id: 'disposable-cf-check',
        clientId: 'disposable.access', clientSecret: 'b'.repeat(54) }; },
      async remove() {},
    };
    const first = await redeemInvite(invites, fakeCloudflare, code);
    if (!first || await redeemInvite(invites, fakeCloudflare, code) !== null) {
      throw new Error('One-use redemption failed');
    }
    installationId = first.installationId;
    const record = await createProductionRepository(pool).findByTokenHash(
      require('./src/production/security').hashInstallationToken(first.installationToken));
    if (record?.installationId !== installationId) throw new Error('Installation not stored');
    process.stdout.write('Controlled invite database check passed; no Cloudflare token created.\n');
  } finally {
    if (installationId) await createProductionRepository(pool).revoke(installationId);
    if (code) await pool.query('DELETE FROM production_enrollment_invites WHERE invite_hash = $1',
      [hashInvite(code)]);
    if (installationId) await pool.query('DELETE FROM production_installations WHERE installation_id = $1',
      [installationId]);
    await pool.end();
  }
})().catch(() => {
  process.stderr.write('Controlled invite database check failed.\n');
  process.exitCode = 1;
});
NODE
