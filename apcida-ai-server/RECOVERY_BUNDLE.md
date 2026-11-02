# Encrypted off-device recovery bundle

`scripts/phase7-export-recovery.sh` first creates a fresh PostgreSQL custom dump and restores it to a disposable database. It then encrypts the verified dump plus the controlled server's `production.env`, `admin.key`, `tunnel.token`, and `superuser.password` into one `.enc` file. A release signing keystore can be included as the optional second argument once a stable key exists. The script does not include SMS text or local Android inbox data. The `.enc` file is protected with AES-256-GCM and a passphrase-derived key; the passphrase is read without echo and is not written to disk by the script.

From `apcida-ai-server`, with an external drive or synced folder mounted and its destination directory already created:

```bash
bash scripts/phase7-export-recovery.sh "/Volumes/Your External Drive/ApCiDa"
```

Store the chosen passphrase in a password manager or another location that will survive loss of this Mac. Keep the destination and passphrase separate. A file in the Mac's ordinary Documents folder does not provide off-device recovery. For a synced folder, confirm in that service that the encrypted file finished uploading; this script can verify the local file but cannot verify remote sync.

To test that a copied bundle is decryptable, enter the same passphrase privately and use the following commands. The first command verifies the encrypted file without writing the contents. The second extracts into a **new** private directory for a full recovery rehearsal. Remove that extracted directory after review because it contains live service secrets.

```bash
read -r -s -p 'Recovery passphrase: ' recovery_passphrase; printf '\n'
printf %s "$recovery_passphrase" | node scripts/phase7-recovery-bundle.js verify "/path/to/apcida-recovery-....enc"
printf %s "$recovery_passphrase" | node scripts/phase7-recovery-bundle.js restore "/path/to/apcida-recovery-....enc" "/private/tmp/apcida-recovery-review"
unset recovery_passphrase
```

After an actual Mac loss, install the controlled server software and PostgreSQL on the replacement Mac, restore `apcida.pgcustom` with `pg_restore`, and place the recovered configuration and keys in an owner-only private directory. Rotate the Cloudflare tunnel and provisioning credentials after recovery. Do not distribute a production-signed Android APK until its keystore and passwords are also recoverable off-device. Keep the automatic SMS transport gate closed until the separate release review.
