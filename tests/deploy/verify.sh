#!/usr/bin/env sh
# Post-deploy smoke check for a WarRoomLive behind someone else's edge proxy.
#
#   tests/deploy/verify.sh                             # https://live.tommy-huang.dev
#   tests/deploy/verify.sh https://warroom.example.com
#
# Run it from anywhere that can reach the domain. Run it ON THE SERVER to get
# the extra checks that need the loopback port — including the one that matters
# most, and the one a browser will never show you until the room is busy.
#
# What this is for: the failure modes of this topology are quiet. A missing
# WebSocket upgrade looks like "the room just doesn't connect". A rate limiter
# reading the wrong forwarded address looks like nothing at all until two people
# are on at once, and then like the service falling over. Neither shows up in a
# page that loads fine.
set -eu

ORIGIN=${1:-https://live.tommy-huang.dev}
SCHEME=$(printf '%s' "$ORIGIN" | sed -e 's|://.*$||')
# Strip the port too: getent wants a hostname, not host:port.
HOST=$(printf '%s' "$ORIGIN" | sed -e 's|^https\{0,1\}://||' -e 's|/.*$||' -e 's|:.*$||')
PORT=${WARROOM_PORT:-8088}

PASS=0
FAIL=0
SKIP=0

ok()   { PASS=$((PASS + 1)); printf 'ok:   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'skip: %s\n' "$1"; }

printf '=== %s\n\n' "$ORIGIN"

# --- DNS ------------------------------------------------------------------
ADDR=$(getent hosts "$HOST" 2>/dev/null | awk '{print $1; exit}' || true)
if [ -n "$ADDR" ]; then
  ok "$HOST resolves ($ADDR)"
else
  bad "$HOST does not resolve — the certificate cannot be issued until it does"
fi

# --- TLS ------------------------------------------------------------------
# getUserMedia only works on a secure origin, so a certificate problem is not a
# cosmetic one: the camera never starts.
if [ "$SCHEME" = "https" ]; then
  if curl -sS --max-time 15 -o /dev/null "$ORIGIN/api/health" 2>/dev/null; then
    ok "TLS certificate is valid and trusted"
  else
    bad "TLS handshake failed — camera and microphone will not start without it"
  fi
else
  skip "TLS checks (target is plaintext — expected only when pointing at a local stack)"
fi

HEALTH=$(curl -sS --max-time 15 "$ORIGIN/api/health" 2>/dev/null || true)
case "$HEALTH" in
  *'"status":"ok"'*) ok "the backend answers through the edge" ;;
  *) bad "GET /api/health did not return ok (got: ${HEALTH:-nothing})" ;;
esac

# --- Plaintext must not stay plaintext -------------------------------------
if [ "$SCHEME" = "https" ]; then
  REDIRECT=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' \
    "http://$HOST/" 2>/dev/null || true)
  case "$REDIRECT" in
    30*https://*) ok "plaintext redirects to HTTPS ($REDIRECT)" ;;
    *) bad "http://$HOST/ did not redirect to HTTPS (got: $REDIRECT)" ;;
  esac
else
  skip "HTTPS redirect check (target is plaintext)"
fi

# --- WebSocket upgrade -----------------------------------------------------
# The quiet one. If the edge does not pass Upgrade through — an nginx missing
# its $connection_upgrade map, most often — every page loads perfectly and no
# room ever connects.
check_upgrade() {
  path=$1
  label=$2
  code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$ORIGIN$path" 2>/dev/null || true)
  if [ "$code" = "101" ]; then
    ok "$label upgrades to a WebSocket (101)"
  else
    bad "$label did not upgrade (HTTP $code) — the edge is not passing Upgrade through"
  fi
}
check_upgrade /ws/signal "signaling"
check_upgrade /ws/doc "document sync"

# --- Security headers ------------------------------------------------------
HEADERS=$(curl -sS --max-time 15 -D - -o /dev/null "$ORIGIN/" 2>/dev/null || true)
if [ "$SCHEME" = "https" ]; then
  printf '%s' "$HEADERS" | grep -qi '^x-frame-options:' \
    && ok "X-Frame-Options is set" \
    || bad "X-Frame-Options is missing — the room controls can be framed"
else
  skip "security headers (they are set by the edge, which a local stack has no)"
fi
if [ "$SCHEME" = "https" ]; then
  printf '%s' "$HEADERS" | grep -qi '^permissions-policy:.*camera' \
    && ok "Permissions-Policy grants camera/microphone to this origin" \
    || skip "Permissions-Policy does not mention camera (only needed once framed)"
fi

# --- Rate limiting works at all --------------------------------------------
# From outside, this can only show that the limit exists. Whether it isolates
# callers needs two source addresses, which is the on-server check below.
BURST=$(for _ in $(seq 1 60); do
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}\n' "$ORIGIN/api/media/config" 2>/dev/null || echo 000
done | sort | uniq -c | tr '\n' ' ')
case "$BURST" in
  *429*) ok "a burst is throttled ($BURST)" ;;
  *) bad "60 rapid requests were never throttled ($BURST) — is the filter reachable?" ;;
esac

sleep 3
AFTER=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$ORIGIN/api/media/config" 2>/dev/null || true)
[ "$AFTER" = "200" ] \
  && ok "and the caller recovers once the bucket refills" \
  || bad "still refused after backing off (HTTP $AFTER)"

# --- On-server only --------------------------------------------------------
if curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
  printf '\n--- on the server\n'

  # THE check for this topology. The backend keys its per-caller limit on the
  # LAST X-Forwarded-For entry, because that is the one the app's own nginx
  # appended and therefore the only one a client cannot forge. Behind an edge
  # that entry becomes the EDGE's address for everyone unless real-ip.conf is
  # mounted — one bucket for the whole internet, so one person's burst returns
  # 429 to everybody. Two forged client addresses show which world you are in.
  for _ in $(seq 1 60); do
    curl -sS --max-time 5 -o /dev/null -H 'X-Forwarded-For: 203.0.113.10' \
      "http://127.0.0.1:$PORT/api/media/config" >/dev/null 2>&1 || true
  done
  OTHER=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    -H 'X-Forwarded-For: 203.0.113.99' \
    "http://127.0.0.1:$PORT/api/media/config" 2>/dev/null || true)
  if [ "$OTHER" = "200" ]; then
    ok "one caller's flood does not throttle everybody else"
  else
    bad "a second caller was refused (HTTP $OTHER) after someone else's burst —
      infrastructure/edge/real-ip.conf is not in effect, so every client shares
      one allowance. Check: docker compose exec frontend ls /etc/nginx/conf.d/"
  fi

  # The container port must not be a second, plaintext front door. Only
  # meaningful against a routable address: on a loopback target this would be
  # asking whether the loopback binding is bound to loopback.
  case "${ADDR:-}" in
    ''|127.*|::1)
      skip "public exposure check (target resolves to loopback)" ;;
    *)
      if curl -sS --max-time 5 -o /dev/null "http://$ADDR:$PORT/api/health" 2>/dev/null; then
        bad "the app is also reachable at http://$ADDR:$PORT — bind it to loopback"
      else
        ok "the container port is not exposed publicly"
      fi ;;
  esac
else
  skip "loopback checks (run this on the server to include them)"
fi

printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] || exit 1
