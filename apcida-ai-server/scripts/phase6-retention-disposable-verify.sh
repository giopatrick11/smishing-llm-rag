#!/bin/bash
set -euo pipefail
umask 077

if [[ ${APCIDA_PHASE6_RETENTION_TEST:-} != true ]]; then
  echo 'Set APCIDA_PHASE6_RETENTION_TEST=true for the disposable retention check.' >&2
  exit 1
fi
backend_dir=$(cd "$(dirname "$0")/.." && pwd)
pg17_bin=${APCIDA_PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}
test_db="apcida_retention_$$"
"$pg17_bin/createdb" -h /tmp -p 55436 -U "$(id -un)" "$test_db"
cleanup() {
  "$pg17_bin/dropdb" -h /tmp -p 55436 -U "$(id -un)" --if-exists "$test_db" >/dev/null 2>&1 ||
    echo 'Disposable retention database needs manual cleanup.' >&2
}
trap cleanup EXIT
cd "$backend_dir"
APCIDA_PHASE6_TEST_DB="$test_db" node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { createProductionRepository } = require('./src/production/repository');

(async () => {
  const pool = new Pool({ host: '/tmp', port: 55436,
    database: process.env.APCIDA_PHASE6_TEST_DB, user: os.userInfo().username });
  try {
    for (const name of ['004_production_inference.sql', '005_production_invites.sql',
      '006_production_invite_cleanup.sql']) {
      await pool.query(fs.readFileSync(`src/db/migrations/${name}`, 'utf8'));
    }
    const oldRevoked = randomUUID();
    const oldExpired = randomUUID();
    const current = randomUUID();
    for (const [id, label, issued, expires, revoked] of [
      [oldRevoked, 'OldRevokedSynthetic', '-60 days', '+1 day', '-31 days'],
      [oldExpired, 'OldExpiredSynthetic', '-60 days', '-31 days', null],
      [current, 'CurrentSynthetic', '0 days', '+1 day', null],
    ]) {
      await pool.query(`INSERT INTO production_installations
        (installation_id, label, token_hash, issued_at, expires_at, revoked_at)
        VALUES ($1, $2, $3, now() + $4::interval, now() + $5::interval,
          CASE WHEN $6::text IS NULL THEN NULL ELSE now() + $6::interval END)`,
      [id, label, randomBytes(32).toString('hex'), issued, expires, revoked]);
    }
    await pool.query(`INSERT INTO production_enrollment_invites
      (invite_hash, label, expires_at, used_at, installation_id)
      VALUES ($1, 'OldRevokedSynthetic', now() - interval '31 days',
        now() - interval '31 days', $2)`, [randomBytes(32).toString('hex'), oldRevoked]);
    const removed = await createProductionRepository(pool).purgeInactiveInstallations(30);
    const state = await pool.query(`SELECT
      (SELECT count(*)::int FROM production_installations) AS installations,
      (SELECT count(*)::int FROM production_installations WHERE installation_id = $1) AS current,
      (SELECT count(*)::int FROM production_enrollment_invites) AS invites`, [current]);
    if (removed !== 2 || state.rows[0].installations !== 1 ||
        state.rows[0].current !== 1 || state.rows[0].invites !== 0) {
      throw new Error('Disposable retention assertion failed');
    }
    process.stdout.write('Disposable 30-day retention passed: old revoked and expired records removed, linked invite cascaded, current installation kept.\n');
  } finally { await pool.end(); }
})().catch(() => {
  process.stderr.write('Disposable retention verification failed.\n');
  process.exitCode = 1;
});
NODE
