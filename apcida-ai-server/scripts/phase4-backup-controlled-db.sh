#!/bin/bash
set -euo pipefail
umask 077

pg17_bin=${APCIDA_PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
backup_dir="$private_root/backups"
db_port=55436
if [[ ! -d $private_root/postgres ]] || [[ ! -x $pg17_bin/pg_dump ]]; then
  echo 'The separate PostgreSQL 17 controlled database is required.' >&2
  exit 1
fi
install -d -m 700 "$backup_dir"
backup_file=$(mktemp "$backup_dir/apcida-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
restore_database="apcida_restore_$$"
created_restore=false
cleanup() {
  if [[ $created_restore == true ]]; then
    "$pg17_bin/dropdb" -h /tmp -p "$db_port" -U "$(id -un)" --if-exists "$restore_database" >/dev/null 2>&1 ||
      echo 'Temporary restore database needs manual cleanup.' >&2
  fi
}
trap cleanup EXIT

"$pg17_bin/pg_dump" -h /tmp -p "$db_port" -U "$(id -un)" -d apcida -Fc > "$backup_file"
chmod 600 "$backup_file"
"$pg17_bin/pg_restore" --list "$backup_file" >/dev/null

"$pg17_bin/createdb" -h /tmp -p "$db_port" -U "$(id -un)" "$restore_database"
created_restore=true
"$pg17_bin/pg_restore" -h /tmp -p "$db_port" -U "$(id -un)" \
  -d "$restore_database" --exit-on-error "$backup_file" >/dev/null
restored_count=$("$pg17_bin/psql" -X -q -t -A -h /tmp -p "$db_port" -U "$(id -un)" \
  -d "$restore_database" -c 'SELECT count(*) FROM rag_knowledge WHERE is_active = true')
if [[ $restored_count != 100 ]]; then
  echo 'Backup restore check found an unexpected approved RAG count.' >&2
  exit 1
fi
restored_schema=$("$pg17_bin/psql" -X -q -t -A -h /tmp -p "$db_port" -U "$(id -un)" \
  -d "$restore_database" -c "SELECT
    to_regclass('public.production_installations') IS NOT NULL,
    to_regclass('public.production_inference_requests') IS NOT NULL,
    to_regclass('public.production_enrollment_invites') IS NOT NULL,
    to_regclass('public.production_inference_slot') IS NOT NULL")
if [[ $restored_schema != 't|t|t|t' ]]; then
  echo 'Backup restore check is missing a production or invite table.' >&2
  exit 1
fi

printf 'Private controlled database backup and restore passed: 100 approved RAG records and production/invite tables; archive size %s bytes.\n' \
  "$(stat -f %z "$backup_file")"
echo 'Backup is retained in the private controlled-server/backups directory.'
