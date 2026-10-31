#!/bin/bash
set -u

# Read-only checks for the temporary Mac-hosted synthetic phone pilot.
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

listening_on_loopback() {
  lsof -nP -iTCP:3020 -sTCP:LISTEN 2>/dev/null |
    awk 'NR > 1 { found = 1; if ($9 != "127.0.0.1:3020") other = 1 }
      END { exit !(found && !other) }'
}

model_available() {
  ollama show "$1" >/dev/null 2>&1
}

report 'Test API responds on the Mac' curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3020/health
report 'Test API listens only on 127.0.0.1:3020' listening_on_loopback

pg_isready_command=$(command -v pg_isready || true)
if [[ -z $pg_isready_command && -x /opt/homebrew/opt/postgresql@17/bin/pg_isready ]]; then
  pg_isready_command=/opt/homebrew/opt/postgresql@17/bin/pg_isready
fi
if [[ -n $pg_isready_command ]]; then
  report 'Disposable test database accepts local connections' \
    "$pg_isready_command" -q -h 127.0.0.1 -p 55435
else
  printf '[CHECK] Disposable test database accepts local connections (pg_isready is missing)\n'
  failures=$((failures + 1))
fi

report 'Gemma model is available in local Ollama' model_available gemma3:12b
report 'Embedding model is available in local Ollama' model_available nomic-embed-text
report 'Named Cloudflare tunnel connector is running' pgrep -q -f 'cloudflared tunnel run'

if (( failures > 0 )); then
  printf '%s check(s) need attention. This command never sends an SMS.\n' "$failures"
  exit 1
fi
printf 'Local synthetic pilot checks passed. Remote access and production readiness require separate verification.\n'
