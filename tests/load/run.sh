#!/usr/bin/env sh
# Runs the signaling load test against a running compose stack:
#   docker compose up -d          # any overlay combination
#   tests/load/run.sh             # defaults: 120 VUs, 4 peers/room, 80s total
#
# Tune with env, e.g.: VUS=400 HOLD=120s CHAT_INTERVAL_MS=1000 tests/load/run.sh
# Thresholds (blueprint SLOs) are enforced by k6 — a red run exits non-zero.
set -eu
cd "$(dirname "$0")/../.."

NETWORK=${NETWORK:-warroomlive_default}
RUN_ID=${RUN_ID:-$(date +%s)}

docker run --rm -i \
  --network "$NETWORK" \
  -e WS_URL="${WS_URL:-ws://frontend/ws/signal}" \
  -e VUS="${VUS:-120}" \
  -e PEERS_PER_ROOM="${PEERS_PER_ROOM:-4}" \
  -e CHAT_INTERVAL_MS="${CHAT_INTERVAL_MS:-2000}" \
  -e SESSION_MS="${SESSION_MS:-30000}" \
  -e RAMP="${RAMP:-20s}" \
  -e HOLD="${HOLD:-60s}" \
  -e RUN_ID="$RUN_ID" \
  -v "$(pwd)/tests/load:/scripts:ro" \
  grafana/k6:latest run /scripts/signaling.js
