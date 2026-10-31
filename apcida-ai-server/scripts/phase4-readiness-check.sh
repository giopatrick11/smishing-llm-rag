#!/bin/bash
set -u

# Read-only checks for the persistent, synthetic-only Mac setup.
failures=0
report() {
  local label=$1
  shift
  if "$@"; then
    printf '[OK] %s\n' "$label"
  else
    printf '[CHECK] %s\n' "$label"
    failures=$((failures + 1))
  fi
}

loopback_listener() {
  local port=$1
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null |
    awk -v address="127.0.0.1:$port" \
      'NR > 1 { found = 1; if ($9 != address) other = 1 }
       END { exit !(found && !other) }'
}

launch_agent_loaded() {
  launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1
}

model_available() {
  ollama show "$1" >/dev/null 2>&1
}

access_redirects_to_login() {
  local status
  status=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
    https://sms.apcida.stream/health) || return 1
  [[ $status == 302 ]]
}

on_ac_power() {
  pmset -g batt | head -n 1 | grep -q "AC Power"
}

pg_isready_bin=$(command -v pg_isready || true)
if [[ -z $pg_isready_bin ]]; then
  pg_isready_bin=/opt/homebrew/opt/postgresql@17/bin/pg_isready
fi

for label in com.apcida.controlled-postgres com.apcida.controlled-api com.apcida.cloudflared; do
  report "$label is loaded" launch_agent_loaded "$label"
done
report 'PostgreSQL accepts local connections' "$pg_isready_bin" -q -h 127.0.0.1 -p 55436
report 'PostgreSQL listens only on local loopback' loopback_listener 55436
report 'Controlled API health responds' curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3021/health
report 'Controlled API listens only on local loopback' loopback_listener 3021
report 'Gemma model is available' model_available gemma3:12b
report 'Embedding model is available' model_available nomic-embed-text
report 'Public hostname requires Cloudflare Access login' access_redirects_to_login
report 'Mac is connected to AC power' on_ac_power

if (( failures > 0 )); then
  printf '%s check(s) need attention. No SMS or synthetic analysis was sent.\n' "$failures"
  exit 1
fi
printf 'Mac readiness checks passed. Browser and phone tests remain separate.\n'
