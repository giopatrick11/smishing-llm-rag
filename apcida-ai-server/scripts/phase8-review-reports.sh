#!/bin/bash
set -euo pipefail
umask 077

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"
private_env="$private_root/production.env"
admin_key_file="$private_root/admin.key"
if [[ ! -r $private_env || ! -r $admin_key_file ]]; then
  echo 'Private controlled-server configuration and administrator key are required.' >&2
  exit 1
fi

cd "$backend_dir"
set -a
. "$private_env"
set +a
admin_key=$(tr -d '\n' < "$admin_key_file")
PRODUCTION_ADMIN_KEY="$admin_key" APCIDA_PRODUCTION_ADMIN_TOKEN="$admin_key" \
  node src/production/reportReviewCli.js "$@"
