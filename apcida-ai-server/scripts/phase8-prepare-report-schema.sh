#!/bin/bash
set -euo pipefail
umask 077

if [[ ${APCIDA_PREPARE_REPORT_SCHEMA:-} != true ]]; then
  echo 'Set APCIDA_PREPARE_REPORT_SCHEMA=true to add the controlled report table.' >&2
  exit 1
fi

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
password_file="$private_root/superuser.password"
if [[ ! -r $password_file ]] || [[ ! -f "$private_root/production.env" ]]; then
  echo 'Controlled database files are missing.' >&2
  exit 1
fi
admin_password=$(tr -d '\n' < "$password_file")
admin_url="postgresql://$(id -un):$admin_password@127.0.0.1:55436/apcida"
cd "$backend_dir"
APCIDA_PRODUCTION_MODE=controlled-test APCIDA_APPLY_PRODUCTION_SCHEMA=true \
  DATABASE_URL="$admin_url" node src/db/migrate.js
/opt/homebrew/opt/postgresql@17/bin/psql -X -q -v ON_ERROR_STOP=1 \
  -h /tmp -p 55436 -U "$(id -un)" -d apcida <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.production_reports TO apcida_app;
SQL
echo 'Report schema prepared. Reports remain separate from RAG.'
