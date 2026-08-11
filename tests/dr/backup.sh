#!/usr/bin/env sh
# Takes a physical base backup of the running stack's Postgres into the backups
# volume (requires the backup overlay for WAL archiving to make it PITR-capable).
#   ./stack.sh up backup -- -d
#   tests/dr/backup.sh          # plain format (directory)
#   tests/dr/backup.sh tar      # tar.gz format — one object per backup
#
# Use `tar` when the backup is destined for object storage: object stores have
# no directories, so a plain backup's empty ones (pg_notify, pg_subtrans, …)
# would be lost in transit and the restored cluster would refuse to start.
set -eu
cd "$(dirname "$0")/../.."

# One compose file now; `backup` has no services of its own, only settings,
# so no profile is needed here — just the file.
COMPOSE="./stack.sh"
FORMAT=${1:-plain}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# The archiver runs as the postgres user; the volume default-owns to root.
$COMPOSE exec -T db sh -c "mkdir -p /backups/wal /backups/base && chown -R postgres:postgres /backups"
if [ "$FORMAT" = "tar" ]; then
  $COMPOSE exec -T db sh -c "mkdir -p /backups/base/$STAMP && chown postgres:postgres /backups/base/$STAMP"
  $COMPOSE exec -T db pg_basebackup -U warroomlive -D "/backups/base/$STAMP" -Ft -z -Xstream -c fast
else
  $COMPOSE exec -T db pg_basebackup -U warroomlive -D "/backups/base/$STAMP" -Fp -Xstream -c fast
fi
echo "base backup complete ($FORMAT): /backups/base/$STAMP (WAL archive: /backups/wal)"
echo "$STAMP"
