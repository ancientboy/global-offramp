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
# A prepared live database is independently backed up; never merge it with sandbox data.
if [ "$(docker exec global-offramp-business-postgres psql -U offramp_owner -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname='offramp_live'")" = 1 ]; then
 docker exec global-offramp-business-postgres pg_dump -U offramp_owner -d offramp_live -Fc > "$backup_dir/database-live.dump.partial"
 mv "$backup_dir/database-live.dump.partial" "$backup_dir/database-live.dump"
 if [ -d /var/lib/global-offramp-live/receipts ]; then tar -czf "$backup_dir/receipts-live.tgz" -C /var/lib/global-offramp-live receipts; fi
fi
cd "$backup_dir"
sha256sum ./*.dump ./*.tgz > SHA256SUMS
printf 'Database and immutable receipt snapshot completed\n'
# Retention and offsite replication must be configured separately; no automatic deletion.
