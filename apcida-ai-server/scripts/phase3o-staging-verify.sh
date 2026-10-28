#!/bin/bash
set -euo pipefail
umask 077

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
android_dir=${APCIDA_ANDROID_DIR:-/Users/giopatrick/Documents/apcida/Mobile_App}
staging_dir=$(mktemp -d /private/tmp/apcida-phase3o-staging.XXXXXX)
staging_pid=''
cleanup() {
  if [[ -n "$staging_pid" ]]; then kill "$staging_pid" 2>/dev/null || true; wait "$staging_pid" 2>/dev/null || true; fi
  pg_ctl -D "$staging_dir/postgres" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$staging_dir"
}
trap cleanup EXIT

initdb -D "$staging_dir/postgres" -A trust -U "$(id -un)" --no-instructions >/dev/null
# The port is reserved for this isolated local test; fail if it is already occupied.
staging_pg_port=55434
pg_ctl -D "$staging_dir/postgres" -l "$staging_dir/postgres.log" \
  -o "-h 127.0.0.1 -p $staging_pg_port" -w start >/dev/null
createdb -h 127.0.0.1 -p "$staging_pg_port" -U "$(id -un)" apcida_staging
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$staging_pg_port" -U "$(id -un)" \
  -d apcida_staging -f "$backend_dir/src/db/migrations/004_production_inference.sql" >/dev/null

export APCIDA_STAGING_ENABLED=true
export APCIDA_STAGING_BIND=127.0.0.1
export APCIDA_STAGING_DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$staging_pg_port/apcida_staging"
export APCIDA_STAGING_DATA_KEY
APCIDA_STAGING_DATA_KEY=$(openssl rand -hex 32)
export APCIDA_STAGING_TOKEN_FILE="$staging_dir/tokens.json"
export APCIDA_STAGING_ENDPOINT_FILE="$staging_dir/endpoint"
node "$backend_dir/src/staging/localServer.js" >"$staging_dir/staging.log" 2>&1 &
staging_pid=$!
for ((i=0; i<60; i++)); do
  if [[ -s "$APCIDA_STAGING_ENDPOINT_FILE" && -s "$APCIDA_STAGING_TOKEN_FILE" ]]; then break; fi
  if ! kill -0 "$staging_pid" 2>/dev/null; then cat "$staging_dir/staging.log"; exit 1; fi
  sleep 0.1
done
[[ -s "$APCIDA_STAGING_ENDPOINT_FILE" && -s "$APCIDA_STAGING_TOKEN_FILE" ]]
export APCIDA_STAGING_HTTP_BASE
APCIDA_STAGING_HTTP_BASE=$(cat "$APCIDA_STAGING_ENDPOINT_FILE")
export APCIDA_STAGING_TOKEN APCIDA_STAGING_REVOKED_TOKEN APCIDA_STAGING_SELF_REVOKE_TOKEN
export APCIDA_STAGING_ANDROID_REVOKE_TOKEN
APCIDA_STAGING_TOKEN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.APCIDA_STAGING_TOKEN_FILE)).validToken)')
APCIDA_STAGING_REVOKED_TOKEN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.APCIDA_STAGING_TOKEN_FILE)).revokedToken)')
APCIDA_STAGING_SELF_REVOKE_TOKEN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.APCIDA_STAGING_TOKEN_FILE)).selfRevokeToken)')
APCIDA_STAGING_ANDROID_REVOKE_TOKEN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.APCIDA_STAGING_TOKEN_FILE)).androidRevokeToken)')

(cd "$backend_dir" && node --test test/phase3oStaging.test.js)
APCIDA_TEST_DATABASE_URL="$APCIDA_STAGING_DATABASE_URL" \
  node --test "$backend_dir/test/phase3nProductionRepository.test.js"
(cd "$android_dir" && ./gradlew :app:testDebugUnitTest \
  --tests com.apcida.smishingdetector.backend.remote.ProductionStagingContractTest \
  --rerun-tasks --no-daemon --console=plain)
