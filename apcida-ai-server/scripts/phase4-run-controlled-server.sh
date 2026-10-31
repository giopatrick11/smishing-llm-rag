#!/bin/bash
set -euo pipefail

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
private_env="$HOME/Library/Application Support/ApCiDa/controlled-server/production.env"
node_bin=${APCIDA_NODE_BIN:-/Users/giopatrick/Library/Application Support/Herd/config/nvm/versions/node/v22.21.1/bin/node}
if [[ ! -f $private_env ]] || [[ $(stat -f %Lp "$private_env") != 600 ]]; then
  echo 'A private mode-0600 controlled-server configuration is required.' >&2
  exit 1
fi
if [[ ! -x $node_bin ]]; then
  echo 'The configured Node.js binary is unavailable.' >&2
  exit 1
fi

cd "$backend_dir"
set -a
. "$private_env"
set +a
# Keep the Mac awake for the controlled API only while it is on AC power.
exec /usr/bin/caffeinate -s "$node_bin" src/production/server.js
