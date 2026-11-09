#!/bin/bash
set -euo pipefail
umask 077

backend_dir=$(cd "$(dirname "$0")/.." && pwd)
label=com.apcida.admin-dashboard
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/$label.plist"
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"

if [[ ! -f "$private_root/dashboard-db.password" || ! -f "$private_root/dashboard-login.key" ]]; then
  echo 'Provision the dashboard database role and start the dashboard once first.' >&2
  exit 1
fi
install -d -m 700 "$HOME/Library/LaunchAgents"
install -m 600 "$backend_dir/deploy/macos/$label.plist" "$plist"
touch "$private_root/admin-dashboard.log" "$private_root/admin-dashboard.error.log"
chmod 600 "$private_root/admin-dashboard.log" "$private_root/admin-dashboard.error.log"
/usr/bin/plutil -lint "$plist" >/dev/null
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$label"
fi
launchctl bootstrap "$domain" "$plist"
launchctl print "$domain/$label" >/dev/null
echo 'Admin dashboard will start at Mac login on 127.0.0.1:3022.'
