#!/bin/bash
set -euo pipefail
umask 077

if [[ ${APCIDA_PREPARE_STUDY_SCHEMA:-} != true ]]; then
  echo 'Set APCIDA_PREPARE_STUDY_SCHEMA=true to prepare the controlled thesis study schema.' >&2
  exit 1
fi

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
password_file="$private_root/superuser.password"
psql_bin=/opt/homebrew/opt/postgresql@17/bin/psql
if [[ ! -r $password_file || ! -x $psql_bin ]]; then
  echo 'Controlled database prerequisites are missing.' >&2
  exit 1
fi
admin_password=$(tr -d '\n' < "$password_file")
admin_url="postgresql://$(id -un):$admin_password@127.0.0.1:55436/apcida"
cd "$backend_dir"
APCIDA_PRODUCTION_MODE=controlled-test APCIDA_APPLY_PRODUCTION_SCHEMA=true \
  DATABASE_URL="$admin_url" node src/db/migrate.js
"$psql_bin" -X -q -v ON_ERROR_STOP=1 -h /tmp -p 55436 -U "$(id -un)" -d apcida <<'SQL'
GRANT USAGE ON SCHEMA study TO apcida_app, apcida_review;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA study TO apcida_app;
GRANT USAGE ON SEQUENCE study.contributions_id_seq TO apcida_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA study TO apcida_review;
GRANT USAGE ON SEQUENCE study.contributions_id_seq TO apcida_review;
GRANT SELECT, UPDATE ON TABLE public.production_inference_slot TO apcida_review;
SQL
echo 'Study schema prepared. Enable APCIDA_STUDY_ENABLED only after reviewing retention and expert access.'
