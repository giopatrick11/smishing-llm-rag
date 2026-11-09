#!/bin/bash
set -euo pipefail
umask 077

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
password_file="$private_root/superuser.password"

if [[ ! -f $password_file ]]; then
  echo 'Controlled database administrator password file is missing.' >&2
  exit 1
fi

cd "$backend_dir"
admin_password=$(tr -d '\n' < "$password_file")
if [[ ! $admin_password =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Controlled database administrator password has an invalid format.' >&2
  exit 1
fi

rag_admin_key=$(node - <<'NODE'
const fs = require('node:fs');
const dotenv = require('dotenv');
const values = dotenv.parse(fs.readFileSync('.env'));
if (!values.RAG_ADMIN_KEY || values.RAG_ADMIN_KEY.length < 32) {
  process.stderr.write('RAG_ADMIN_KEY is missing from the private .env file.\n');
  process.exit(1);
}
process.stdout.write(values.RAG_ADMIN_KEY);
NODE
)

export APCIDA_PRODUCTION_MODE=controlled-test
export RAG_ADMIN_KEY="$rag_admin_key"
export APCIDA_ADMIN_TOKEN="$rag_admin_key"
export DATABASE_URL="postgresql://$(id -un):$admin_password@127.0.0.1:55436/apcida"
exec node src/knowledge/cli.js "$@"
