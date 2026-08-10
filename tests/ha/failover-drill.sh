#!/usr/bin/env sh
# Redis Sentinel failover drill. Prereqs:
#   ./stack.sh up ha -- --build -d
#   npm --prefix tests/ha ci
# Kills the Redis master and asserts Sentinel promotion + full service recovery.
# NOTE: the drill leaves the old master dead; `docker compose ... up -d` after
# the drill restores it as a replica of the promoted master.
set -eu
cd "$(dirname "$0")/../.."
node tests/ha/drill.mjs "$(date +%s)"
