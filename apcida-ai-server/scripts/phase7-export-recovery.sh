#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -lt 1 || $# -gt 2 || ! -d $1 ]]; then
  echo 'Usage: bash scripts/phase7-export-recovery.sh <existing off-device folder> [release-keystore-file]' >&2
  exit 1
fi
destination=$1
signing_keystore=${2:-}
if [[ -n $signing_keystore && ! -f $signing_keystore ]]; then
  echo 'The release keystore file is missing.' >&2
  exit 1
fi
root=$(cd "$(dirname "$0")/.." && pwd)
private_root="$HOME/Library/Application Support/ApCiDa/controlled-server"

echo 'Creating and restoring a fresh controlled database backup first...'
bash "$root/scripts/phase4-backup-controlled-db.sh"
backup_file=$(find "$private_root/backups" -maxdepth 1 -type f -name 'apcida-*' \
  -print | sort | tail -1)
if [[ -z $backup_file ]]; then
  echo 'No verified database backup was found.' >&2
  exit 1
fi

read -r -s -p 'Choose a recovery passphrase (20+ characters; store it away from this Mac): ' recovery_passphrase
printf '\n'
read -r -s -p 'Repeat the recovery passphrase: ' recovery_confirmation
printf '\n'
if [[ ${#recovery_passphrase} -lt 20 || $recovery_passphrase != "$recovery_confirmation" ]]; then
  echo 'Passphrases did not match or were too short. No encrypted export was written.' >&2
  exit 1
fi
unset recovery_confirmation
printf %s "$recovery_passphrase" | node "$root/scripts/phase7-recovery-bundle.js" \
  export "$private_root" "$backup_file" "$destination" "$signing_keystore"
unset recovery_passphrase
