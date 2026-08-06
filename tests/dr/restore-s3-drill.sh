#!/usr/bin/env sh
# PITR drill restoring EXCLUSIVELY from object storage (backup-s3 overlay):
# same shape as restore-drill.sh, but the restore container never touches the
# backups volume — base backup + WAL are pulled (and decrypted) from the MinIO
# bucket into a scratch volume first. Proves the encrypted bucket alone is
# sufficient to recover to a point in time.
#
# Prereqs: backup + backup-s3 overlays up; `npm --prefix tests/dr ci` once.
set -eu
cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.backup.yml -f docker-compose.backup-s3.yml"
PROJECT=${PROJECT:-warroomlive}
NETWORK=${NETWORK:-${PROJECT}_default}
RESTORE=warroomlive-s3-restore-drill
SCRATCH_VOL=${PROJECT}_s3-restore-scratch
RUN=$(date +%s)
export DR_ROOM="drs3-$RUN"

# The same rclone remote config the shipper uses (dev creds of the overlay).
RCLONE_ENV="-e RCLONE_CONFIG_S3_TYPE=s3 -e RCLONE_CONFIG_S3_PROVIDER=Minio \
  -e RCLONE_CONFIG_S3_ENDPOINT=http://minio-backup:9000 \
  -e RCLONE_CONFIG_S3_ACCESS_KEY_ID=warroom -e RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=warroomsecret \
  -e RCLONE_CONFIG_CRYPT_TYPE=crypt -e RCLONE_CONFIG_CRYPT_REMOTE=s3:${BACKUP_BUCKET:-warroom-backups}"
PASS=${BACKUP_PASSPHRASE:-warroom-dev-backup-passphrase}

psql_src() { $COMPOSE exec -T db psql -U warroomlive -d warroomlive -tAc "$1"; }
psql_restored() { docker exec "$RESTORE" psql -U warroomlive -d warroomlive -tAc "$1"; }
ship_now() {
  docker compose -f docker-compose.yml -f docker-compose.backup.yml -f docker-compose.backup-s3.yml \
    exec -T backup-shipper sh -c \
    'RCLONE_CONFIG_CRYPT_PASSWORD=$(rclone obscure "$BACKUP_PASSPHRASE") rclone sync /backups crypt: --exclude "restore-stage/**" --create-empty-src-dirs -q'
}

echo "== 1/8 seed marker A (chat + notes)"
node tests/dr/seed.mjs "drs3-A-$RUN" --with-notes

echo "== 2/8 base backup (tar format — object storage has no directories)"
STAMP=$(tests/dr/backup.sh tar | tail -1)

echo "== 3/8 capture recovery target time"
sleep 2
TARGET=$(psql_src "select now()")
echo "   T = $TARGET"
sleep 2

echo "== 4/8 seed post-disaster marker B"
node tests/dr/seed.mjs "drs3-B-$RUN"

echo "== 5/8 switch WAL and force a final encrypted ship to the bucket"
psql_src "select pg_switch_wal()" >/dev/null
sleep 3
ship_now

echo "== 6/8 pull (and decrypt) base + WAL from the bucket into a scratch volume"
docker rm -f "$RESTORE" >/dev/null 2>&1 || true
docker volume rm -f "$SCRATCH_VOL" >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run --rm --network "$NETWORK" $RCLONE_ENV -v "$SCRATCH_VOL":/restore \
  --entrypoint sh rclone/rclone:1.68 -c \
  'RCLONE_CONFIG_CRYPT_PASSWORD=$(rclone obscure "'"$PASS"'") rclone sync crypt: /restore --create-empty-src-dirs -q'

echo "== 7/8 restore into a fresh container (recovery_target_time = T, WAL from bucket copy)"
docker run --rm -v "$SCRATCH_VOL":/restore --entrypoint sh postgres:16-alpine -c "
  rm -rf /restore/staged && mkdir -p /restore/staged &&
  tar xzf /restore/base/$STAMP/base.tar.gz -C /restore/staged &&
  touch /restore/staged/recovery.signal &&
  cat >> /restore/staged/postgresql.auto.conf <<EOF
restore_command = 'cp /restore/wal/%f %p'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
EOF"
docker run -d --name "$RESTORE" --network "$NETWORK" \
  -v "$SCRATCH_VOL":/restore \
  --entrypoint sh postgres:16-alpine -c "
    cp -a /restore/staged /var/lib/postgresql/restored &&
    chown -R postgres:postgres /var/lib/postgresql/restored &&
    chmod 700 /var/lib/postgresql/restored &&
    exec su postgres -c 'postgres -D /var/lib/postgresql/restored'
  " >/dev/null

echo "   waiting for recovery to complete..."
i=0
until [ "$(docker exec "$RESTORE" psql -U warroomlive -d warroomlive -tAc 'select pg_is_in_recovery()' 2>/dev/null || echo x)" = "f" ]; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "FAIL: recovery did not complete"; docker logs "$RESTORE" | tail -20; exit 1; }
  sleep 2
done

echo "== 8/8 verify"
FAIL=0
A=$(psql_restored "select count(*) from chat_message where text='drs3-A-$RUN'")
B=$(psql_restored "select count(*) from chat_message where text='drs3-B-$RUN'")
[ "$A" = "1" ] && echo "ok: marker A survived the bucket-only restore" || { echo "FAIL: marker A missing (=$A)"; FAIL=1; }
[ "$B" = "0" ] && echo "ok: post-disaster marker B correctly absent (PITR honored T)" || { echo "FAIL: marker B present (=$B)"; FAIL=1; }

SRC_IP=$($COMPOSE exec -T db hostname -i | tr -d ' \r')
RST_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$RESTORE")
node tests/dr/verify-crdt.mjs "$SRC_IP" > /tmp/drs3-src.txt
node tests/dr/verify-crdt.mjs "$RST_IP" > /tmp/drs3-restored.txt
if grep -q "warroom:$DR_ROOM" /tmp/drs3-src.txt && diff -q /tmp/drs3-src.txt /tmp/drs3-restored.txt >/dev/null; then
  echo "ok: CRDT documents rebuild to identical hashes on source and restored DBs"
  grep "warroom:$DR_ROOM" /tmp/drs3-restored.txt | sed 's/^/   /'
else
  echo "FAIL: CRDT rebuild mismatch"; diff /tmp/drs3-src.txt /tmp/drs3-restored.txt || true; FAIL=1
fi

# The bucket must hold only ciphertext: no plaintext WAL names at the top level.
PLAINTEXT=$(docker run --rm --network "$NETWORK" --entrypoint sh minio/mc:latest -c \
  "mc alias set b http://minio-backup:9000 warroom warroomsecret >/dev/null && mc ls --recursive b/${BACKUP_BUCKET:-warroom-backups}" \
  | grep -cE "wal/|base/" || true)
[ "$PLAINTEXT" = "0" ] && echo "ok: bucket holds only encrypted names (no plaintext wal/ or base/ paths)" \
  || { echo "FAIL: plaintext paths visible in bucket ($PLAINTEXT)"; FAIL=1; }

docker rm -f "$RESTORE" >/dev/null
docker volume rm -f "$SCRATCH_VOL" >/dev/null
[ "$FAIL" = "0" ] && echo "\nS3 DR DRILL PASSED" || { echo "\nS3 DR DRILL FAILED"; exit 1; }
