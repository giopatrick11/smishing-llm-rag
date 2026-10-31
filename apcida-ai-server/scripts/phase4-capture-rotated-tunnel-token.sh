#!/bin/bash
set -euo pipefail

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
printf 'In Cloudflare, copy the NEW apcida-pilot tunnel command now. Return here and press Return.\n'
read -r _
trap 'printf "" | pbcopy' EXIT
pbpaste | node "$backend_dir/scripts/phase4-save-rotated-tunnel-token.js"
