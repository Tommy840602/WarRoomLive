#!/usr/bin/env sh
# Takes a physical base backup of the running stack's Postgres into the backups
# volume (requires the backup overlay for WAL archiving to make it PITR-capable).
#   docker compose -f docker-compose.yml -f docker-compose.backup.yml up -d
#   tests/dr/backup.sh
set -eu
cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.backup.yml"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# The archiver runs as the postgres user; the volume default-owns to root.
$COMPOSE exec -T db sh -c "mkdir -p /backups/wal /backups/base && chown -R postgres:postgres /backups"
$COMPOSE exec -T db pg_basebackup -U warroomlive -D "/backups/base/$STAMP" -Fp -Xstream -c fast
echo "base backup complete: /backups/base/$STAMP (WAL archive: /backups/wal)"
echo "$STAMP"
