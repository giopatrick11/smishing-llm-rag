#!/bin/bash
set -euo pipefail

if [[ ${APCIDA_PHASE6_STACK_RESTART:-} != true ]]; then
  echo 'Set APCIDA_PHASE6_STACK_RESTART=true for controlled service recovery.' >&2
  exit 1
fi

domain="gui/$(id -u)"
pg_isready_bin=/opt/homebrew/opt/postgresql@17/bin/pg_isready
local_status() {
  curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    'http://127.0.0.1:3021/health' 2>/dev/null || true
}
public_status() {
  curl -sS --max-time 12 -o /dev/null -w '%{http_code}' \
    'https://sms.apcida.stream/api/v1/enrollment' 2>/dev/null || true
}
database_ready() {
  "$pg_isready_bin" -q -h 127.0.0.1 -p 55436
}

if ! database_ready || [[ $(local_status) != 200 || $(public_status) != 404 ]]; then
  echo 'Database, API, and public route must be healthy before restart.' >&2
  exit 1
fi

launchctl kickstart -k "$domain/com.apcida.controlled-postgres"
database_recovered=false
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if database_ready && [[ $(local_status) == 200 ]]; then
    database_recovered=true
    break
  fi
  sleep 1
done
if [[ $database_recovered != true ]]; then
  echo 'Database or API did not recover after PostgreSQL restart.' >&2
  exit 1
fi
echo 'PostgreSQL restart: database ready, local API healthy.'

launchctl kickstart -k "$domain/com.apcida.cloudflared"
tunnel_recovered=false
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [[ $(public_status) == 404 ]]; then
    tunnel_recovered=true
    break
  fi
  sleep 1
done
if [[ $tunnel_recovered != true ]]; then
  echo 'Public route did not recover after tunnel restart.' >&2
  exit 1
fi
echo 'Cloudflare Tunnel restart: public route reaches the API.'
