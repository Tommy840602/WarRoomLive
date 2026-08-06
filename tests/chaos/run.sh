#!/usr/bin/env sh
# Chaos suite: starts a Toxiproxy alongside the running compose stack, routes a
# signaling path through it, and runs tests/chaos/chaos.mjs (Node ≥ 22).
#   docker compose up -d && tests/chaos/run.sh
set -eu
cd "$(dirname "$0")/../.."

NETWORK=${NETWORK:-warroomlive_default}
NAME=warroomlive-toxiproxy

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --network "$NETWORK" \
  -p 8474:8474 -p 18081:18081 ghcr.io/shopify/toxiproxy:latest >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

until curl -sf --noproxy '*' http://localhost:8474/version >/dev/null; do sleep 1; done
curl -sf --noproxy '*' -X POST http://localhost:8474/proxies \
  -d '{"name":"signal","listen":"0.0.0.0:18081","upstream":"backend:8080"}' >/dev/null

node tests/chaos/chaos.mjs "${RUN_ID:-$(date +%s)}"
