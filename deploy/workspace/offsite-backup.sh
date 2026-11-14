#!/bin/bash
set -euo pipefail
umask 077
exec 9>/run/lock/global-offramp-offsite.lock
flock -n 9 || exit 0
root=/var/backups/global-offramp/business
latest=$(find "$root" -mindepth 2 -maxdepth 2 -name SHA256SUMS -printf '%T@ %h\n' | sort -nr | head -1 | cut -d ' ' -f2-)
[ -n "$latest" ]
(cd "$latest" && sha256sum --check --status SHA256SUMS)
stamp=$(basename "$latest")
archive=/var/backups/global-offramp/encrypted/$stamp.tar.gpg
mkdir -p /var/backups/global-offramp/encrypted
# GnuPG encryption includes integrity protection. Key is independently retained by the operator.
if [ ! -f "$archive" ]; then
 extra=()
 if [ -f /etc/global-offramp/live/runtime.env ]; then extra=(-C /etc/global-offramp live/runtime.env live-recipient-vault.key live-account-security.key); fi
 if [ -f /etc/global-offramp/live/wallet-policy.json ]; then extra+=(-C /etc/global-offramp live/wallet-policy.json); fi
 tar -cf - -C "$latest" . -C /etc/global-offramp recipient-vault.key account-security.key -C /etc/global-offramp/business runtime.env nowpayments.env "${extra[@]}" | gpg --batch --yes --pinentry-mode loopback --passphrase-file /etc/global-offramp/backup-encryption.key --symmetric --cipher-algo AES256 --compress-algo none --output "$archive.partial"
 mv "$archive.partial" "$archive"
fi
# Receiver key is restricted to write-only rsync in this project's own backup directory.
rsync -t --chmod=F600 -e 'ssh -i /etc/global-offramp/offsite_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/global-offramp/offsite_known_hosts -o ConnectTimeout=10' "$archive" offramp-backup@47.237.102.174:./
date -u +%Y-%m-%dT%H:%M:%SZ > /var/lib/global-offramp-workspace/offsite-last-success
printf 'Encrypted offsite snapshot synchronized\n'
# Do not delete either local or offsite history without an explicit retention policy.
