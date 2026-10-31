#!/bin/bash
set -euo pipefail
umask 077

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
private_env="$private_root/production.env"
admin_key_file="$private_root/admin.key"
token_file="$private_root/phone-synthetic.token"
id_file="$private_root/phone-synthetic.id"
if [[ ! -f $private_env || ! -f $admin_key_file || ! -f $id_file ]]; then
  echo 'Private controlled-server configuration, administrator key, and phone installation ID are required.' >&2
  exit 1
fi
installation_id=$(tr -d '\n' < "$id_file")
if [[ ! $installation_id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo 'The private phone installation ID is invalid.' >&2
  exit 1
fi

cd "$backend_dir"
set -a
. "$private_env"
set +a
admin_key=$(tr -d '\n' < "$admin_key_file")
PRODUCTION_ADMIN_KEY="$admin_key" APCIDA_PRODUCTION_ADMIN_TOKEN="$admin_key" \
  node src/production/adminCli.js revoke --id "$installation_id"
rm -f "$token_file" "$id_file"
echo 'The synthetic phone credential was retired locally and on the backend.'
