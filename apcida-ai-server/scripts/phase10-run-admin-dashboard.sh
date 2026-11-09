#!/bin/bash
set -euo pipefail
umask 077
backend_dir=$(cd "$(dirname "$0")/.." && pwd)
node_bin=${APCIDA_NODE_BIN:-/Users/giopatrick/Library/Application Support/Herd/config/nvm/versions/node/v22.21.1/bin/node}
if [[ ! -x $node_bin ]]; then
  echo 'The configured Node.js binary is unavailable.' >&2
  exit 1
fi
cd "$backend_dir"
exec "$node_bin" src/admin-web/server.js
