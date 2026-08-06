#!/usr/bin/env sh
# Full point-in-time-recovery drill against the running backup-overlay stack:
#
#   1. seed marker A (through the real app paths: chat + shared notes)
#   2. take a base backup
#   3. capture the recovery target time T
#   4. seed post-"disaster" marker B (must NOT survive the restore)
#   5. force a WAL switch so everything up to T is archived
#   6. restore base backup + WAL into a FRESH postgres container with
#      recovery_target_time = T
#   7. assert: marker A present, marker B absent, CRDT documents rebuild to
#      identical hashes on source and restored databases
#
# Prereqs: backup overlay up; `npm --prefix tests/dr ci` once for the JS helpers.
set -eu
cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.backup.yml"
PROJECT=${PROJECT:-warroomlive}
NETWORK=${NETWORK:-${PROJECT}_default}
RESTORE=warroomlive-restore-drill
RUN=$(date +%s)
export DR_ROOM="dr-$RUN"

psql_src() { $COMPOSE exec -T db psql -U warroomlive -d warroomlive -tAc "$1"; }
psql_restored() { docker exec "$RESTORE" psql -U warroomlive -d warroomlive -tAc "$1"; }

echo "== 1/7 seed marker A (chat + notes)"
node tests/dr/seed.mjs "dr-A-$RUN" --with-notes

echo "== 2/7 base backup"
STAMP=$(tests/dr/backup.sh | tail -1)

echo "== 3/7 capture recovery target time"
sleep 2
TARGET=$(psql_src "select now()")
echo "   T = $TARGET"
sleep 2

echo "== 4/7 seed post-disaster marker B"
node tests/dr/seed.mjs "dr-B-$RUN"

echo "== 5/7 switch WAL so the archive covers T"
psql_src "select pg_switch_wal()" >/dev/null
sleep 3

echo "== 6/7 restore into a fresh container (recovery_target_time = T)"
docker rm -f "$RESTORE" >/dev/null 2>&1 || true
# Stage a copy of the base backup with the recovery settings baked in; the
# restore container then only copies, fixes ownership and starts postgres.
$COMPOSE exec -T db sh -c "rm -rf /backups/restore-stage && cp -a /backups/base/$STAMP /backups/restore-stage && touch /backups/restore-stage/recovery.signal"
$COMPOSE exec -T db sh -c "cat >> /backups/restore-stage/postgresql.auto.conf" <<EOF
restore_command = 'cp /backups/wal/%f %p'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
EOF
docker run -d --name "$RESTORE" --network "$NETWORK" \
  -v "${PROJECT}_backups:/backups" \
  --entrypoint sh postgres:16-alpine -c '
    cp -a /backups/restore-stage /var/lib/postgresql/restored &&
    chown -R postgres:postgres /var/lib/postgresql/restored &&
    chmod 700 /var/lib/postgresql/restored &&
    exec su postgres -c "postgres -D /var/lib/postgresql/restored"
  ' >/dev/null

echo "   waiting for recovery to complete..."
i=0
until [ "$(docker exec "$RESTORE" psql -U warroomlive -d warroomlive -tAc 'select pg_is_in_recovery()' 2>/dev/null || echo x)" = "f" ]; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "FAIL: recovery did not complete"; docker logs "$RESTORE" | tail -20; exit 1; }
  sleep 2
done

echo "== 7/7 verify"
FAIL=0
A=$(psql_restored "select count(*) from chat_message where text='dr-A-$RUN'")
B=$(psql_restored "select count(*) from chat_message where text='dr-B-$RUN'")
[ "$A" = "1" ] && echo "ok: marker A survived the restore" || { echo "FAIL: marker A missing (=$A)"; FAIL=1; }
[ "$B" = "0" ] && echo "ok: post-disaster marker B correctly absent (PITR honored T)" || { echo "FAIL: marker B present (=$B)"; FAIL=1; }

SRC_IP=$($COMPOSE exec -T db hostname -i | tr -d ' \r')
RST_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$RESTORE")
node tests/dr/verify-crdt.mjs "$SRC_IP" > /tmp/dr-src.txt
node tests/dr/verify-crdt.mjs "$RST_IP" > /tmp/dr-restored.txt
if grep -q "warroom:$DR_ROOM" /tmp/dr-src.txt && diff -q /tmp/dr-src.txt /tmp/dr-restored.txt >/dev/null; then
  echo "ok: CRDT documents rebuild to identical hashes on source and restored DBs"
  grep "warroom:$DR_ROOM" /tmp/dr-restored.txt | sed 's/^/   /'
else
  echo "FAIL: CRDT rebuild mismatch"; diff /tmp/dr-src.txt /tmp/dr-restored.txt || true; FAIL=1
fi

docker rm -f "$RESTORE" >/dev/null
[ "$FAIL" = "0" ] && echo "\nDR DRILL PASSED" || { echo "\nDR DRILL FAILED"; exit 1; }
