#!/bin/bash
set -euo pipefail
umask 077

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
private_env="$private_root/production.env"
admin_key_file="$private_root/admin.key"
if [[ ! -f $private_env ]] || [[ $(stat -f %Lp "$private_env") != 600 ]]; then
  echo 'A private mode-0600 controlled-server configuration is required.' >&2
  exit 1
fi
if [[ ! -f $admin_key_file ]]; then
  openssl rand -hex 32 > "$admin_key_file"
  chmod 600 "$admin_key_file"
fi
if [[ $(stat -f %Lp "$admin_key_file") != 600 ]]; then
  echo 'The private administrator key must be mode 0600.' >&2
  exit 1
fi

cd "$backend_dir"
set -a
. "$private_env"
set +a
admin_key=$(tr -d '\n' < "$admin_key_file")
test_dir=$(mktemp -d "$private_root/verify.XXXXXX")
token_file="$test_dir/installation.token"
installation_id=''
cleanup() {
  if [[ -n $installation_id ]]; then
    PRODUCTION_ADMIN_KEY="$admin_key" APCIDA_PRODUCTION_ADMIN_TOKEN="$admin_key" \
      node src/production/adminCli.js revoke --id "$installation_id" >/dev/null ||
      echo 'Temporary test credential revocation needs manual review.' >&2
  fi
  rm -f "$token_file"
  rmdir "$test_dir"
}
trap cleanup EXIT

enrollment=$(PRODUCTION_ADMIN_KEY="$admin_key" APCIDA_PRODUCTION_ADMIN_TOKEN="$admin_key" \
  node src/production/adminCli.js enroll --label Phase4LocalSynthetic \
    --out "$token_file" --approve)
installation_id=$(printf '%s\n' "$enrollment" |
  sed -nE 's/^Production installation approved: ([0-9a-f-]{36});.*/\1/p')
if [[ -z $installation_id ]]; then
  echo 'Temporary test enrollment did not return an installation ID.' >&2
  exit 1
fi

APCIDA_PHASE4_TOKEN_FILE="$token_file" node - <<'NODE'
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { validateProductionResponse } = require('./src/production/smsContract');

(async () => {
  const token = fs.readFileSync(process.env.APCIDA_PHASE4_TOKEN_FILE, 'utf8').trim();
  const messageId = randomUUID();
  const body = { messageId, sender: 'ManualTest',
    text: 'Synthetic test: Your bank account will be frozen. Send your one-time code now.',
    receivedAt: new Date().toISOString() };
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': messageId,
    'content-type': 'application/json' };
  const started = Date.now();
  const first = await fetch('http://127.0.0.1:3021/api/v1/sms/analyze', {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const result = await first.json();
  if (first.status !== 200 || !validateProductionResponse(result, messageId)) {
    throw new Error(`First synthetic analysis failed: HTTP ${first.status}, code=${result.error || 'INVALID_RESPONSE'}`);
  }
  process.stdout.write(`Persistent local synthetic analysis: HTTP 200, classification=${result.classification}, confidence=${result.confidence}, elapsed_ms=${Date.now() - started}\n`);
  const replay = await fetch('http://127.0.0.1:3021/api/v1/sms/analyze', {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const replayResult = await replay.json();
  if (replay.status !== 200 || JSON.stringify(replayResult) !== JSON.stringify(result)) {
    throw new Error('Encrypted duplicate replay did not match the first response');
  }
  process.stdout.write('Persistent local duplicate replay: HTTP 200, identical response.\n');
})().catch((error) => {
  process.stderr.write(`Synthetic check failed: ${error.message}\n`);
  process.exitCode = 1;
});
NODE

echo 'Temporary test credential will be revoked and removed.'
