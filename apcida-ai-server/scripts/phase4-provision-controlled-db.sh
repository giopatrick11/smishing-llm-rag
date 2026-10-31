#!/bin/bash
set -euo pipefail
umask 077

if [[ ${APCIDA_PHASE4_PROVISION:-} != true ]]; then
  echo 'Set APCIDA_PHASE4_PROVISION=true to create the separate synthetic-only database.' >&2
  exit 1
fi

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
pg17_bin=${APCIDA_PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
data_dir="$private_root/postgres"
db_port=55436
server_port=3021

if [[ ! -x "$pg17_bin/initdb" ]] || [[ $("$pg17_bin/initdb" --version) != *' 17.'* ]]; then
  echo 'PostgreSQL 17 Homebrew binaries are required.' >&2
  exit 1
fi
if [[ -e $private_root ]]; then
  echo 'The controlled-server private directory already exists; leaving it untouched.' >&2
  exit 1
fi
available_kb=$(df -Pk "$HOME" | awk 'NR == 2 { print $4 }')
if [[ ! $available_kb =~ ^[0-9]+$ ]] || (( available_kb < 10 * 1024 * 1024 )); then
  echo 'At least 10 GiB of free Data-volume space is required for this controlled setup.' >&2
  exit 1
fi
if nc -z 127.0.0.1 "$db_port" >/dev/null 2>&1 ||
  nc -z 127.0.0.1 "$server_port" >/dev/null 2>&1; then
  echo 'The controlled database or API port is already in use.' >&2
  exit 1
fi

cd "$backend_dir"
source_url=$(node -e 'require("dotenv").config({quiet:true}); process.stdout.write(process.env.DATABASE_URL || "")')
if [[ -z $source_url ]]; then
  echo 'The approved RAG source DATABASE_URL is missing.' >&2
  exit 1
fi

install -d -m 700 "$private_root"
openssl rand -hex 32 > "$private_root/superuser.password"
"$pg17_bin/initdb" -D "$data_dir" --auth-local=peer --auth-host=scram-sha-256 \
  -U "$(id -un)" --pwfile="$private_root/superuser.password" --no-instructions >/dev/null
"$pg17_bin/pg_ctl" -D "$data_dir" -l "$private_root/postgres.log" \
  -o "-h 127.0.0.1 -p $db_port" -w start >/dev/null
"$pg17_bin/createdb" -h /tmp -p "$db_port" -U "$(id -un)" apcida

superuser_password=$(tr -d '\n' < "$private_root/superuser.password")
admin_url="postgresql://$(id -un):$superuser_password@127.0.0.1:$db_port/apcida"
DATABASE_URL="$admin_url" node - <<'NODE'
const { runMigrations } = require('./src/db/migrate');
runMigrations(process.env.DATABASE_URL, { includeProduction: true })
  .then((files) => process.stdout.write(`Applied ${files.length} migrations to the separate database.\n`))
  .catch(() => { process.stderr.write('Separate database migration failed.\n'); process.exitCode = 1; });
NODE

APCIDA_SOURCE_DATABASE_URL="$source_url" APCIDA_TARGET_DATABASE_URL="$admin_url" \
  node src/staging/copyApprovedKnowledge.js

app_password=$(openssl rand -hex 32)
printf "CREATE ROLE apcida_app LOGIN PASSWORD '%s';\n" "$app_password" |
  "$pg17_bin/psql" -X -q -v ON_ERROR_STOP=1 -h /tmp -p "$db_port" -U "$(id -un)" -d apcida
"$pg17_bin/psql" -X -q -v ON_ERROR_STOP=1 -h /tmp -p "$db_port" -U "$(id -un)" -d apcida <<'SQL'
GRANT CONNECT ON DATABASE apcida TO apcida_app;
GRANT USAGE ON SCHEMA public TO apcida_app;
GRANT SELECT ON TABLE public.rag_knowledge TO apcida_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.production_installations,
  public.production_rate_windows,
  public.production_inference_requests,
  public.production_inference_slot,
  public.production_enrollment_invites TO apcida_app;
SQL

app_url="postgresql://apcida_app:$app_password@127.0.0.1:$db_port/apcida"
data_key=$(openssl rand -hex 32)
cat > "$private_root/production.env" <<ENV
APCIDA_PRODUCTION_ENABLED=true
APCIDA_PRODUCTION_MODE=controlled-test
APCIDA_PRODUCTION_BIND=127.0.0.1
APCIDA_PRODUCTION_PORT=$server_port
DATABASE_URL=$app_url
PRODUCTION_DATA_KEY=$data_key
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:12b
RAG_ENABLED=true
RULES_ENABLED=true
RULES_SHADOW_MODE=true
VERDICT_POLICY=gemma
REQUEST_TIMEOUT_MS=90000
ENV
chmod 600 "$private_root/production.env" "$private_root/superuser.password"

DATABASE_URL="$app_url" node - <<'NODE'
const { createDatabasePool, checkRagDatabase } = require('./src/db/pool');
const { checkProductionRepository } = require('./src/production/repository');
(async () => {
  const pool = createDatabasePool(process.env.DATABASE_URL);
  try {
    await checkRagDatabase(pool);
    await checkProductionRepository(pool);
    const result = await pool.query('SELECT count(*)::integer AS count FROM rag_knowledge WHERE is_active = true');
    if (result.rows[0]?.count !== 100) throw new Error('Approved RAG count mismatch');
  } finally { await pool.end(); }
})().then(() => process.stdout.write('Separate app-role database checks passed (100 active RAG records).\n'))
  .catch(() => { process.stderr.write('Separate app-role database check failed.\n'); process.exitCode = 1; });
NODE

echo 'Controlled synthetic database is ready on localhost port 55436.'
echo 'Private configuration is stored outside Git. The existing phone pilot and tunnel route were not changed.'
