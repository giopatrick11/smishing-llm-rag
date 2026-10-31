#!/bin/bash
set -euo pipefail
umask 077

private_env="$HOME/Library/Application Support/ApCiDa/controlled-server/production.env"
if [[ ! -f $private_env ]] || [[ $(stat -f %Lp "$private_env") != 600 ]]; then
  echo 'The private controlled-server environment is unavailable or not mode 600.' >&2
  exit 1
fi
if grep -Eq '^(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_PROVISIONING_API_TOKEN)=' "$private_env"; then
  echo 'Cloudflare provisioning values already exist; refusing to overwrite them.' >&2
  exit 1
fi

IFS= read -r -p 'Paste Cloudflare Account ID (32 hexadecimal characters): ' account_id
if [[ ! $account_id =~ ^[0-9a-fA-F]{32}$ ]]; then
  echo 'Invalid account ID. Nothing saved.' >&2
  exit 1
fi
IFS= read -r -s -p 'Paste scoped Cloudflare API token (hidden): ' api_token
printf '\n'
# Copy buttons may include surrounding whitespace; it is never part of the token.
api_token=$(printf '%s' "$api_token" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
if (( ${#api_token} < 20 || ${#api_token} > 256 )) ||
  [[ ! $api_token =~ ^[A-Za-z0-9_-]+$ ]]; then
  printf 'Token value has %s characters after trimming. Paste only the API token secret, without Bearer, quotes, or a curl command. Nothing saved.\n' "${#api_token}" >&2
  exit 1
fi

printf '\nCLOUDFLARE_ACCOUNT_ID=%s\nCLOUDFLARE_PROVISIONING_API_TOKEN=%s\n' \
  "$account_id" "$api_token" >> "$private_env"
unset api_token
echo 'Cloudflare provisioning values saved privately. Enrollment is still disabled.'
