#!/usr/bin/env sh
# Browser suites against a running compose stack.
#
#   docker compose up -d
#   npm --prefix tests/ui ci && npx --prefix tests/ui playwright install chromium
#   tests/ui/run.sh              # media, collab, room-acl
#   tests/ui/run.sh --all        # plus reconnect, which restarts the backend
#   tests/ui/run.sh collab       # a named suite
#
# These drive the real app in a real browser, which is the only place some
# things can be checked at all: that audio is audible, that an editor is wired
# to its document, that a control is offered to the right person. Not run in
# CI — they need a stack and a browser. The frontend's own unit tests (`npm
# test` in frontend/) are the part that does run there.
set -eu
cd "$(dirname "$0")/../.."

if [ ! -d tests/ui/node_modules ]; then
  echo "tests/ui dependencies missing — run: npm --prefix tests/ui ci"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "cannot reach the Docker daemon — is Docker running?"
  exit 1
fi
if ! docker compose ps --format '{{.Service}}' 2>/dev/null | grep -qx frontend; then
  echo "no stack detected — start one first, e.g. docker compose up -d"
  exit 1
fi

ALL=0
SUITES=""
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    *) SUITES="$SUITES $arg" ;;
  esac
done

if [ -z "$SUITES" ]; then
  SUITES="media collab room-acl quality"
  docker compose ps --format '{{.Service}}' 2>/dev/null | grep -qx minio && SUITES="$SUITES recordings"
  [ "$ALL" = "1" ] && SUITES="$SUITES reconnect"
fi

RUN_ID=${RUN_ID:-$(date +%s)}
FAILED=""
for suite in $SUITES; do
  echo ""
  echo "=== $suite"
  if node "tests/ui/$suite.mjs" "$RUN_ID"; then :; else FAILED="$FAILED $suite"; fi
done

echo ""
if [ -n "$FAILED" ]; then
  echo "FAILED SUITES:$FAILED"
  exit 1
fi
echo "ALL UI SUITES PASSED:$SUITES"
