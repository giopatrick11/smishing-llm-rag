#!/bin/bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
private_dir="$HOME/Library/Application Support/ApCiDa/controlled-server"
bin_dir="$private_dir/bin"
rotator="$bin_dir/rotate-controlled-logs.py"
plist="$HOME/Library/LaunchAgents/com.apcida.log-rotation.plist"
label='com.apcida.log-rotation'
launch_domain="gui/$(id -u)"

umask 077
mkdir -p "$bin_dir" "$HOME/Library/LaunchAgents"
chmod 700 "$private_dir" "$bin_dir"
install -m 700 "$script_dir/phase6-rotate-controlled-logs.py" "$rotator"

/usr/bin/python3 - "$rotator" "$plist" <<'PY'
import plistlib
import sys
from pathlib import Path

rotator, plist = sys.argv[1:]
configuration = {
    'Label': 'com.apcida.log-rotation',
    'ProgramArguments': ['/usr/bin/python3', rotator],
    'RunAtLoad': False,
    'StartCalendarInterval': {'Hour': 3, 'Minute': 15},
}
Path(plist).write_bytes(plistlib.dumps(configuration))
PY
chmod 600 "$plist"

if launchctl print "$launch_domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$launch_domain/$label"
fi
launchctl bootstrap "$launch_domain" "$plist"
/usr/bin/python3 "$rotator"
launchctl print "$launch_domain/$label" >/dev/null
printf 'ApCiDa log rotation installed: daily at 03:15 local time, 30-day archive retention.\n'
