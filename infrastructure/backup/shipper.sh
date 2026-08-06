#!/bin/sh
# Backup shipper (backup-s3 overlay): continuously syncs the backups volume
# (base backups + archived WAL) to MinIO through an rclone `crypt` remote, so
# everything in the bucket is client-side encrypted (contents and file names)
# with BACKUP_PASSPHRASE. Sync is incremental and idempotent; WAL segments are
# written whole by archive_command before they become visible, so a sync never
# ships a partial segment. restore-stage/ is drill scratch space — never shipped.
set -eu

# rclone stores crypt passwords obscured, not raw — derive at startup.
RCLONE_CONFIG_CRYPT_PASSWORD=$(rclone obscure "$BACKUP_PASSPHRASE")
export RCLONE_CONFIG_CRYPT_PASSWORD

until rclone mkdir "s3:${BACKUP_BUCKET:-warroom-backups}" 2>/dev/null; do
  echo "waiting for object storage..."
  sleep 2
done
echo "backup shipper: syncing /backups -> encrypted bucket ${BACKUP_BUCKET:-warroom-backups} every ${SHIP_INTERVAL:-10}s"

while true; do
  # --create-empty-src-dirs matters: a base backup contains empty directories
  # (pg_notify, pg_subtrans, …) that Postgres requires to start, and object
  # storage has no directories — without placeholders the restore fails.
  rclone sync /backups crypt: --exclude "restore-stage/**" --create-empty-src-dirs -q \
    || echo "sync failed; will retry"
  sleep "${SHIP_INTERVAL:-10}"
done
