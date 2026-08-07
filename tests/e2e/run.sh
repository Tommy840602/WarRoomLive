#!/usr/bin/env sh
# End-to-end suites against a running compose stack.
#
#   docker compose up -d && npm --prefix tests/e2e ci   # once
#   tests/e2e/run.sh                 # every suite the running stack supports
#   tests/e2e/run.sh signaling crdt  # named suites
#   tests/e2e/run.sh --all           # include the destructive ones
#
# Suites are selected from what is actually running, so the same command works
# on the base stack and on any overlay combination. Destructive suites (they
# SIGKILL a service to test recovery) are opt-in via --all or by name; the
# closing summary says how to restore anything they left down.
set -eu
cd "$(dirname "$0")/../.."

COMPOSE="docker compose"
running() { $COMPOSE ps --format '{{.Service}}' 2>/dev/null | grep -qx "$1"; }
replicas() { $COMPOSE ps --format '{{.Service}}' 2>/dev/null | grep -cx "$1" || true; }

if [ ! -d tests/e2e/node_modules ]; then
  echo "tests/e2e dependencies missing — run: npm --prefix tests/e2e ci"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "cannot reach the Docker daemon — is Docker running?"
  exit 1
fi
if ! running backend; then
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

# Nothing named: pick by what the running stack can support.
if [ -z "$SUITES" ]; then
  SUITES="signaling room-acl crdt capacity reconnect limits retention agenda"
  running devidp && SUITES="$SUITES oidc"
  running indexer && SUITES="$SUITES events"
  running minio && SUITES="$SUITES recordings attachments"
  if [ "$ALL" = "1" ]; then
    SUITES="$SUITES crdt-hardening"
    [ "$(replicas backend)" -ge 2 ] && SUITES="$SUITES scale"
  fi
fi

RUN_ID=${RUN_ID:-$(date +%s)}
# Suites talk to localhost and, when pinned to a replica, to container IPs —
# never through an outbound proxy.
NO_PROXY=${NO_PROXY:-'*'}
no_proxy=$NO_PROXY
export NO_PROXY no_proxy
FAILED=""
for suite in $SUITES; do
  echo ""
  echo "=== $suite"
  if node "tests/e2e/$suite.mjs" "$RUN_ID"; then :; else FAILED="$FAILED $suite"; fi
done

echo ""
case " $SUITES " in
  *" scale "*) echo "note: the scale suite left a backend replica down — 'docker compose … up -d' restores it" ;;
esac
if [ -n "$FAILED" ]; then
  echo "FAILED SUITES:$FAILED"
  exit 1
fi
echo "ALL SUITES PASSED:$SUITES"
