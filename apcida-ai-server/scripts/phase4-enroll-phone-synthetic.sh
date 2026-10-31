#!/bin/bash
set -euo pipefail
umask 077

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
private_env="$private_root/production.env"
admin_key_file="$private_root/admin.key"
token_file="$private_root/phone-synthetic.token"
id_file="$private_root/phone-synthetic.id"
if [[ ! -f $private_env || ! -f $admin_key_file ]]; then
  echo 'Private controlled-server configuration and administrator key are required.' >&2
  exit 1
fi
if [[ -e $token_file || -e $id_file ]]; then
  echo 'A synthetic phone credential already exists; refusing to overwrite it.' >&2
  exit 1
fi

cd "$backend_dir"
set -a
. "$private_env"
set +a
admin_key=$(tr -d '\n' < "$admin_key_file")
result=$(PRODUCTION_ADMIN_KEY="$admin_key" APCIDA_PRODUCTION_ADMIN_TOKEN="$admin_key" \
  node src/production/adminCli.js enroll --label Phase4SyntheticPhone \
    --out "$token_file" --approve)
installation_id=$(printf '%s\n' "$result" | sed -nE \
  's/^Production installation approved: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12});.*/\1/p')
if [[ -z $installation_id ]]; then
  echo 'Credential was created, but its installation ID could not be saved; inspect the private database before enrolling again.' >&2
  exit 1
fi
printf '%s\n' "$installation_id" > "$id_file"
printf '%s\n' "$result"
echo 'The phone token was saved privately; do not paste it into chat or Git.'
