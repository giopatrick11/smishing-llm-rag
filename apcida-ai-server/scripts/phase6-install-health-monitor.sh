#!/bin/bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
private_dir="$HOME/Library/Application Support/ApCiDa/controlled-server"
bin_dir="$private_dir/bin"
monitor="$bin_dir/health-monitor.py"
plist="$HOME/Library/LaunchAgents/com.apcida.health-monitor.plist"
label='com.apcida.health-monitor'
launch_domain="gui/$(id -u)"

umask 077
mkdir -p "$bin_dir" "$HOME/Library/LaunchAgents"
chmod 700 "$private_dir" "$bin_dir"
install -m 700 "$script_dir/phase6-health-monitor.py" "$monitor"

/usr/bin/python3 - "$monitor" "$plist" <<'PY'
import plistlib
import sys
from pathlib import Path

monitor, plist = sys.argv[1:]
configuration = {
    'Label': 'com.apcida.health-monitor',
    'ProgramArguments': ['/usr/bin/python3', monitor],
    'RunAtLoad': True,
    'StartInterval': 60,
}
Path(plist).write_bytes(plistlib.dumps(configuration))
PY
chmod 600 "$plist"

if launchctl print "$launch_domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$launch_domain/$label"
fi
launchctl bootstrap "$launch_domain" "$plist"
launchctl print "$launch_domain/$label" >/dev/null
printf 'ApCiDa local health monitor installed: checks every 60 seconds.\n'
printf 'View status with: /usr/bin/python3 "%s" --status\n' "$monitor"
