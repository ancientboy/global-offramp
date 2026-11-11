#!/bin/sh
set -eu
umask 077
exec 9>/run/lock/global-offramp-workspace-backup.lock
flock -n 9 || exit 0
backup_root=/var/backups/global-offramp/business
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$backup_root/$backup_stamp"
mkdir -p "$backup_dir"
chmod 700 "$backup_root" "$backup_dir"
# Dump first. Receipt blobs are immutable and written before DB metadata commits;
# copying blobs afterwards includes every object referenced by this DB snapshot.
docker exec global-offramp-business-postgres pg_dump -U offramp_owner -d offramp_business -Fc > "$backup_dir/database.dump.partial"
mv "$backup_dir/database.dump.partial" "$backup_dir/database.dump"
tar -czf "$backup_dir/receipts.tgz" -C /var/lib/global-offramp-workspace receipts
cd "$backup_dir"
sha256sum database.dump receipts.tgz > SHA256SUMS
printf 'Database and immutable receipt snapshot completed\n'
# Retention and offsite replication must be configured separately; no automatic deletion.
