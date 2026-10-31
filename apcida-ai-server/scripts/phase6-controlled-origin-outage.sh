#!/bin/bash
set -euo pipefail

if [[ ${APCIDA_PHASE6_OUTAGE:-} != true ]]; then
  echo 'Set APCIDA_PHASE6_OUTAGE=true for the controlled API outage check.' >&2
  exit 1
fi
hold_seconds=${APCIDA_PHASE6_PHONE_HOLD_SECONDS:-0}
if [[ ! $hold_seconds =~ ^[0-9]+$ ]] || (( hold_seconds > 300 )); then
  echo 'APCIDA_PHASE6_PHONE_HOLD_SECONDS must be an integer from 0 to 300.' >&2
  exit 1
fi

service="gui/$(id -u)/com.apcida.controlled-api"
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/com.apcida.controlled-api.plist"
origin='https://sms.apcida.stream/api/v1/enrollment'
stopped=false

public_status() {
  curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$origin" 2>/dev/null || true
}
local_status() {
  curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    'http://127.0.0.1:3021/health' 2>/dev/null || true
}
restore() {
  if [[ $stopped == true ]]; then
    if ! launchctl bootstrap "$domain" "$plist"; then
      echo 'URGENT: API service did not restart. Run launchctl bootstrap manually.' >&2
      return 1
    fi
    stopped=false
  fi
}
trap restore EXIT

if [[ ! -r $plist || $(local_status) != 200 ]]; then
  echo 'API service and installed LaunchAgent must be healthy before outage testing.' >&2
  exit 1
fi
before=$(public_status)
printf 'Public enrollment route before outage: HTTP %s\n' "$before"
if [[ $before != 404 ]]; then
  echo 'Expected the unprotected GET enrollment route to reach the API as HTTP 404.' >&2
  exit 1
fi

launchctl bootout "$service"
stopped=true
for _ in 1 2 3 4 5; do
  [[ $(local_status) != 200 ]] && break
  sleep 1
done
if [[ $(local_status) == 200 ]]; then
  echo 'API did not stop; restoring LaunchAgent.' >&2
  exit 1
fi
during=$(public_status)
printf 'Public enrollment route during outage: HTTP %s\n' "$during"
if [[ ! $during =~ ^5[0-9][0-9]$ ]]; then
  echo 'Expected a Cloudflare 5xx origin error while the API was stopped.' >&2
  exit 1
fi
if (( hold_seconds > 0 )); then
  printf 'Phone outage window is open for up to %s seconds; the API will restart automatically.\n' "$hold_seconds"
  sleep "$hold_seconds"
fi

restore
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ $(local_status) == 200 ]] && break
  sleep 1
done
after_local=$(local_status)
after_public=$(public_status)
printf 'After restart: local HTTP %s; public HTTP %s\n' "$after_local" "$after_public"
if [[ $after_local != 200 || $after_public != 404 ]]; then
  echo 'API recovery did not pass both checks.' >&2
  exit 1
fi
echo 'Controlled origin outage and recovery passed. No message text was sent.'
