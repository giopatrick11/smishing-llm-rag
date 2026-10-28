#!/bin/bash
set -euo pipefail
umask 077

if [[ ${APCIDA_PHASE3S_LIVE_SYNTHETIC:-} != true ]]; then
  echo 'Set APCIDA_PHASE3S_LIVE_SYNTHETIC=true to run one synthetic Gemma + RAG request.' >&2
  exit 1
fi

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
pg17_bin=${APCIDA_PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [[ ! -x "$pg17_bin/initdb" ]] || [[ $("$pg17_bin/initdb" --version) != *' 17.'* ]]; then
  echo 'PostgreSQL 17 binaries are required (set APCIDA_PG17_BIN).' >&2
  exit 1
fi
export PATH="$pg17_bin:$PATH"
private_dir=$(mktemp -d /private/tmp/apcida-phase3s-live.XXXXXX)
server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  pg_ctl -D "$private_dir/postgres" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$private_dir"
}
trap cleanup EXIT

cd "$backend_dir"
export APCIDA_PHASE3S_SOURCE_DATABASE_URL
APCIDA_PHASE3S_SOURCE_DATABASE_URL=$(node -e 'require("dotenv").config({quiet:true}); process.stdout.write(process.env.DATABASE_URL || "")')
[[ -n "$APCIDA_PHASE3S_SOURCE_DATABASE_URL" ]]
if pg_isready -h 127.0.0.1 -p 55435 >/dev/null 2>&1; then
  echo 'Disposable staging port 55435 is already occupied.' >&2
  exit 1
fi
if nc -z 127.0.0.1 3020 >/dev/null 2>&1; then
  echo 'Controlled listener port 3020 is already occupied.' >&2
  exit 1
fi
initdb -D "$private_dir/postgres" -A trust -U "$(id -un)" --no-instructions >/dev/null
pg_ctl -D "$private_dir/postgres" -l "$private_dir/postgres.log" \
  -o '-h 127.0.0.1 -p 55435' -w start >/dev/null
createdb -h 127.0.0.1 -p 55435 -U "$(id -un)" apcida

export DATABASE_URL="postgresql://$(id -un)@127.0.0.1:55435/apcida"
export APCIDA_PHASE3S_TOKEN_FILE="$private_dir/installation.token"
export APCIDA_PRODUCTION_ENABLED=true APCIDA_PRODUCTION_MODE=controlled-test
export APCIDA_PRODUCTION_BIND=127.0.0.1 APCIDA_PRODUCTION_PORT=3020
export PRODUCTION_DATA_KEY
PRODUCTION_DATA_KEY=$(openssl rand -hex 32)
export OLLAMA_MODEL=gemma3:12b RAG_ENABLED=true RULES_ENABLED=true
export RULES_SHADOW_MODE=true VERDICT_POLICY=gemma REQUEST_TIMEOUT_MS=90000

node -e 'require("./src/db/migrate").runMigrations(process.env.DATABASE_URL,{includeProduction:true}).then(()=>process.stdout.write("Disposable staging migrations applied.\n"))'
node src/staging/liveSyntheticCheck.js prepare
node - <<'NODE'
const { loadConfig } = require('./src/config/env');
const { productionSettings } = require('./src/production/server');
const { createDatabasePool, checkRagDatabase } = require('./src/db/pool');
const { checkProductionRepository } = require('./src/production/repository');
(async () => {
  productionSettings();
  const config = loadConfig();
  const pool = createDatabasePool(config.databaseUrl);
  try { await checkRagDatabase(pool); await checkProductionRepository(pool); }
  finally { await pool.end(); }
})().catch(error => { process.stderr.write(`Isolated listener preflight: ${error.message}\n`); process.exitCode = 1; });
NODE
node src/production/server.js >"$private_dir/server.log" 2>&1 &
server_pid=$!
for ((i=0; i<100; i++)); do
  if curl -fsS --max-time 1 http://127.0.0.1:3020/health >/dev/null 2>&1; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo 'Controlled listener failed to start; inspect private local configuration.' >&2
    tail -n 3 "$private_dir/server.log" >&2
    exit 1
  fi
  sleep 0.1
done
curl -fsS --max-time 1 http://127.0.0.1:3020/health >/dev/null
node src/staging/liveSyntheticCheck.js verify
