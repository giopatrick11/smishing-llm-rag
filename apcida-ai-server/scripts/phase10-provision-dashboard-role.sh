#!/bin/bash
set -euo pipefail
umask 077

private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
password_file="$private_root/dashboard-db.password"
psql_bin=/opt/homebrew/opt/postgresql@17/bin/psql

if [[ ! -x $psql_bin || ! -d $private_root ]]; then
  echo 'The controlled PostgreSQL 17 installation is required.' >&2
  exit 1
fi
if [[ ! -e $password_file ]]; then
  /usr/bin/openssl rand -hex 32 > "$password_file"
  chmod 600 "$password_file"
fi
db_password=$(tr -d '\n' < "$password_file")
if [[ ! $db_password =~ ^[0-9a-f]{64}$ ]]; then
  echo 'The dashboard database password file is invalid.' >&2
  exit 1
fi

if [[ $("$psql_bin" -X -At -h /tmp -p 55436 -U "$(id -un)" -d apcida \
  -c "SELECT count(*) FROM pg_roles WHERE rolname = 'apcida_review'") == 0 ]]; then
  printf "CREATE ROLE apcida_review LOGIN PASSWORD '%s';\n" "$db_password" |
    "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h /tmp -p 55436 -U "$(id -un)" -d apcida
else
  printf "ALTER ROLE apcida_review PASSWORD '%s';\n" "$db_password" |
    "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h /tmp -p 55436 -U "$(id -un)" -d apcida
fi

"$psql_bin" -X -q -v ON_ERROR_STOP=1 -h /tmp -p 55436 -U "$(id -un)" -d apcida <<'SQL'
GRANT CONNECT ON DATABASE apcida TO apcida_review;
GRANT USAGE ON SCHEMA public TO apcida_review;
GRANT SELECT, UPDATE ON TABLE public.production_reports TO apcida_review;
GRANT DELETE ON TABLE public.production_reports TO apcida_review;
REVOKE ALL ON TABLE public.production_enrollment_invites FROM apcida_review;
GRANT SELECT (invite_hash, label, created_at, expires_at, used_at, canceled_at, claimed_by, claim_until, installation_id)
  ON TABLE public.production_enrollment_invites TO apcida_review;
GRANT INSERT (invite_hash, label, expires_at), UPDATE (canceled_at)
  ON TABLE public.production_enrollment_invites TO apcida_review;
REVOKE ALL ON TABLE public.production_installations FROM apcida_review;
GRANT SELECT (installation_id, label, issued_at, expires_at, revoked_at, cf_service_token_id)
  ON TABLE public.production_installations TO apcida_review;
GRANT UPDATE (revoked_at, cf_service_token_id)
  ON TABLE public.production_installations TO apcida_review;
GRANT DELETE ON TABLE public.production_inference_requests TO apcida_review;
GRANT DELETE ON TABLE public.production_rate_windows TO apcida_review;
GRANT SELECT, INSERT, UPDATE ON TABLE public.rag_knowledge_staging TO apcida_review;
GRANT SELECT, INSERT, UPDATE ON TABLE public.rag_knowledge TO apcida_review;
GRANT USAGE ON SEQUENCE public.rag_knowledge_staging_id_seq TO apcida_review;
GRANT USAGE ON SEQUENCE public.rag_knowledge_id_seq TO apcida_review;
SQL
echo 'Dashboard database role has report, RAG, invite, and device-revocation permissions.'
