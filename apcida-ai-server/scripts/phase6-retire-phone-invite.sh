#!/bin/bash
set -euo pipefail
umask 077

if [[ ${APCIDA_PHASE6_RETIRE_PHONE_INVITE:-} != true ]]; then
  echo 'Set APCIDA_PHASE6_RETIRE_PHONE_INVITE=true to retire the beta phone installation.' >&2
  exit 1
fi

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
private_env="$private_root/production.env"
admin_key_file="$private_root/admin.key"
invite_file="$private_root/phone-beta-invite.code"
if [[ ! -f $private_env || ! -f $admin_key_file || ! -f $invite_file ]]; then
  echo 'Private configuration, admin key, and issued invite file are required.' >&2
  exit 1
fi
if [[ $(stat -f %Lp "$invite_file") != 600 ]]; then
  echo 'The invite file must be private mode 0600.' >&2
  exit 1
fi

cd "$backend_dir"
set -a
. "$private_env"
set +a
admin_key=$(tr -d '\n' < "$admin_key_file")
PRODUCTION_ADMIN_KEY="$admin_key" APCIDA_PRODUCTION_ADMIN_TOKEN="$admin_key" \
  node - "$invite_file" <<'NODE'
const fs = require('node:fs');
const { loadDatabaseUrl } = require('./src/config/env');
const { createDatabasePool } = require('./src/db/pool');
const { requireProductionAdmin } = require('./src/production/adminAuth');
const { createProductionRepository } = require('./src/production/repository');
const { revokeProductionInstallation } = require('./src/production/enrollment');
const { hashInvite, createInviteRepository, createCloudflareTokenClient,
  cleanupCloudflareTokens } = require('./src/production/inviteEnrollment');

(async () => {
  requireProductionAdmin();
  const inviteFile = process.argv[2];
  const hash = hashInvite(fs.readFileSync(inviteFile, 'utf8').trim());
  const pool = createDatabasePool(loadDatabaseUrl(process.env));
  try {
    const found = await pool.query(`SELECT installation_id FROM production_enrollment_invites
      WHERE invite_hash = $1 AND used_at IS NOT NULL`, [hash]);
    if (found.rowCount !== 1) throw new Error('The invite has not been redeemed exactly once');
    const id = found.rows[0].installation_id;
    await revokeProductionInstallation(createProductionRepository(pool), id);
    const cloudflare = createCloudflareTokenClient({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_PROVISIONING_API_TOKEN,
    });
    await cleanupCloudflareTokens(createInviteRepository(pool), cloudflare);
    const state = await pool.query(`SELECT revoked_at, cf_service_token_id
      FROM production_installations WHERE installation_id = $1`, [id]);
    if (!state.rows[0]?.revoked_at || state.rows[0].cf_service_token_id !== null) {
      throw new Error('Backend or Cloudflare token retirement is incomplete');
    }
    fs.unlinkSync(inviteFile);
    process.stdout.write('Beta phone installation revoked; Cloudflare token deleted; used invite file removed.\n');
  } finally {
    await pool.end();
  }
})().catch(() => {
  process.stderr.write('Beta phone retirement needs manual review; private details were not printed.\n');
  process.exitCode = 1;
});
NODE
