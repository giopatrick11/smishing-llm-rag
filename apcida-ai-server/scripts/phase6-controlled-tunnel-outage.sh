#!/bin/bash
set -euo pipefail

if [[ ${APCIDA_PHASE6_TUNNEL_OUTAGE:-} != true ]]; then
  echo 'Set APCIDA_PHASE6_TUNNEL_OUTAGE=true for the controlled tunnel outage check.' >&2
  exit 1
fi
hold_seconds=${APCIDA_PHASE6_PHONE_HOLD_SECONDS:-0}
if [[ ! $hold_seconds =~ ^[0-9]+$ ]] || (( hold_seconds > 300 )); then
  echo 'APCIDA_PHASE6_PHONE_HOLD_SECONDS must be an integer from 0 to 300.' >&2
  exit 1
fi

domain="gui/$(id -u)"
service="$domain/com.apcida.cloudflared"
plist="$HOME/Library/LaunchAgents/com.apcida.cloudflared.plist"
origin='https://sms.apcida.stream/api/v1/enrollment'
stopped=false

public_status() {
  curl -sS --max-time 12 -H 'Cache-Control: no-cache' -o /dev/null -w '%{http_code}' \
    "${origin}?probe=$(date +%s)" 2>/dev/null || true
}
local_status() {
  curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    'http://127.0.0.1:3021/health' 2>/dev/null || true
}
restore() {
  if [[ $stopped == true ]]; then
    if ! launchctl bootstrap "$domain" "$plist"; then
      echo 'URGENT: Cloudflare Tunnel did not restart. Run launchctl bootstrap manually.' >&2
      return 1
    fi
    stopped=false
  fi
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -r $plist ]] || ! launchctl print "$service" >/dev/null 2>&1; then
  echo 'The installed Cloudflare Tunnel LaunchAgent must be running.' >&2
  exit 1
fi
if [[ $(local_status) != 200 || $(public_status) != 404 ]]; then
  echo 'The local API and public route must be healthy before tunnel outage testing.' >&2
  exit 1
fi
echo 'Before outage: local HTTP 200; public HTTP 404.'

launchctl bootout "$service"
stopped=true
outage_status=''
for _ in 1 2 3 4 5 6; do
  outage_status=$(public_status)
  [[ $outage_status =~ ^5[0-9][0-9]$ ]] && break
  sleep 2
done
printf 'During tunnel outage: public HTTP %s; local HTTP %s.\n' \
  "$outage_status" "$(local_status)"
if [[ ! $outage_status =~ ^5[0-9][0-9]$ || $(local_status) != 200 ]]; then
  echo 'Expected public 5xx while the local API remained healthy.' >&2
  exit 1
fi
if (( hold_seconds > 0 )); then
  printf 'Phone tunnel-outage window is open for up to %s seconds; the tunnel will restart automatically.\n' "$hold_seconds"
  sleep "$hold_seconds"
fi

restore
recovered=''
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  recovered=$(public_status)
  [[ $recovered == 404 ]] && break
  sleep 2
done
printf 'After tunnel restart: public HTTP %s; local HTTP %s.\n' \
  "$recovered" "$(local_status)"
if [[ $recovered != 404 || $(local_status) != 200 ]]; then
  echo 'The public route did not recover within the check window.' >&2
  exit 1
fi
echo 'Controlled tunnel outage and recovery passed. No message text was sent.'
