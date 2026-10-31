#!/bin/bash
set -euo pipefail
umask 077

if [[ ${APCIDA_ENABLE_INVITES:-} != true ]]; then
  echo 'Set APCIDA_ENABLE_INVITES=true for the controlled invite-only beta.' >&2
  exit 1
fi
private_env="$HOME/Library/Application Support/ApCiDa/controlled-server/production.env"
if [[ ! -f $private_env ]] || [[ $(stat -f %Lp "$private_env") != 600 ]]; then
  echo 'The private controlled-server environment is missing or not mode 600.' >&2
  exit 1
fi
if grep -Eq '^APCIDA_INVITE_ENROLLMENT_ENABLED=' "$private_env"; then
  echo 'Enrollment flag already exists; refusing to change it.' >&2
  exit 1
fi
if ! grep -Eq '^CLOUDFLARE_ACCOUNT_ID=[0-9a-fA-F]{32}$' "$private_env" ||
  ! grep -Eq '^CLOUDFLARE_PROVISIONING_API_TOKEN=[A-Za-z0-9_-]+$' "$private_env"; then
  echo 'Private Cloudflare provisioning values are missing.' >&2
  exit 1
fi

status() {
  curl -sS --max-time 12 -o /dev/null -w '%{http_code}' "$@"
}
enrollment_url='https://sms.apcida.stream/api/v1/enrollment'
if [[ $(status "$enrollment_url") != 404 ]] ||
  [[ $(status 'https://sms.apcida.stream/health') != 302 ]] ||
  [[ $(status 'https://sms.apcida.stream/api/v1/sms/analyze') != 302 ]]; then
  echo 'Cloudflare path protection did not match the expected preflight; nothing changed.' >&2
  exit 1
fi

enabled_by_script=0
completed=0
rollback() {
  if (( enabled_by_script == 1 && completed == 0 )); then
    temporary=$(mktemp "$private_env.rollback.XXXXXX")
    awk '$0 != "APCIDA_INVITE_ENROLLMENT_ENABLED=true"' "$private_env" > "$temporary"
    chmod 600 "$temporary"
    mv "$temporary" "$private_env"
    launchctl kickstart -k "gui/$(id -u)/com.apcida.controlled-api" >/dev/null 2>&1 || true
    echo 'Enrollment was rolled back after a failed check.' >&2
  fi
}
trap rollback EXIT

printf '\nAPCIDA_INVITE_ENROLLMENT_ENABLED=true\n' >> "$private_env"
enabled_by_script=1
launchctl kickstart -k "gui/$(id -u)/com.apcida.controlled-api"

healthy=0
for _ in {1..20}; do
  if [[ $(status 'http://127.0.0.1:3021/health' || true) == 200 ]]; then
    healthy=1
    break
  fi
  sleep 1
done
if (( healthy != 1 )); then
  echo 'Controlled API did not recover.' >&2
  exit 1
fi

invalid_code=$(printf '%043d' 0)
if [[ $(status -X POST -H 'content-type: application/json' \
  --data "{\"inviteCode\":\"$invalid_code\"}" "$enrollment_url") != 401 ]] ||
  [[ $(status 'https://sms.apcida.stream/health') != 302 ]]; then
  echo 'Enrollment or protected-route check failed.' >&2
  exit 1
fi

completed=1
echo 'Invite enrollment enabled. Invalid invite rejected; protected health route still requires Access.'
