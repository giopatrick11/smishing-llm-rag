#!/bin/bash
set -euo pipefail
umask 077

if [[ ${APCIDA_PHASE6_RETENTION:-} != true ]]; then
  echo 'Set APCIDA_PHASE6_RETENTION=true to enable 30-day identity retention.' >&2
  exit 1
fi
private_env="$HOME/Library/Application Support/ApCiDa/controlled-server/production.env"
if [[ ! -f $private_env ]] || [[ $(stat -f %Lp "$private_env") != 600 ]]; then
  echo 'Private controlled-server environment is missing or not mode 600.' >&2
  exit 1
fi
if grep -Eq '^APCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS=' "$private_env"; then
  echo 'Identity retention is already configured; refusing to overwrite it.' >&2
  exit 1
fi

changed=false
completed=false
rollback() {
  if [[ $changed == true && $completed == false ]]; then
    temporary=$(mktemp "$private_env.rollback.XXXXXX")
    awk '$0 != "APCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS=30"' "$private_env" > "$temporary"
    chmod 600 "$temporary"
    mv "$temporary" "$private_env"
    launchctl kickstart -k "gui/$(id -u)/com.apcida.controlled-api" >/dev/null 2>&1 || true
    echo 'Identity retention setting rolled back after a failed check.' >&2
  fi
}
trap rollback EXIT

printf '\nAPCIDA_PRODUCTION_IDENTITY_RETENTION_DAYS=30\n' >> "$private_env"
changed=true
launchctl kickstart -k "gui/$(id -u)/com.apcida.controlled-api"

healthy=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [[ $(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
      'http://127.0.0.1:3021/health' 2>/dev/null || true) == 200 ]]; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ $healthy != true ]]; then
  echo 'Controlled API did not recover.' >&2
  exit 1
fi

completed=true
echo '30-day inactive-installation retention configured; controlled API is healthy.'
