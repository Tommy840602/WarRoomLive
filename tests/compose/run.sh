#!/usr/bin/env bash
# What the overlays merge into, for combinations nobody had ever run.
#
#   tests/compose/run.sh
#
# Every other suite in this repo needs a stack that is up. This one only needs
# `docker compose config` — no images, no network, no database — which is why it
# is the first stack-shaped test that can run in CI.
#
# It exists because of a specific bug. A scalar environment value is REPLACED by
# a later `-f`, not merged, and six overlays each set SPRING_PROFILES_ACTIVE.
# `-f oidc -f ai` produced `postgres,ai`: the backend fell back to its
# permit-all security chain while devidp still ran and the frontend still
# rendered a login screen. The stack looked authenticated and was not, and every
# existing suite passed because each ran exactly one overlay at a time.
set -uo pipefail
cd "$(dirname "$0")/../.."

PASS=0
FAILED=()

ok() {
  if [ "$1" = "0" ]; then
    echo "ok: $2"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $2"
    FAILED+=("$2")
  fi
}

# The merged value of one environment key on one service.
envof() { # envof <service> <key> <feature...>
  local service=$1 key=$2; shift 2
  ./stack.sh config "$@" 2>/dev/null \
    | awk -v s="  $service:" '$0==s{f=1;next} /^  [a-z]/{f=0} f' \
    | grep -E "^      $key:" | head -1 | sed "s/^      $key: *//" | tr -d '"'
}

# --- Every combination at least parses. `config -q` is the whole check: an
#     overlay that names a volume nobody declares, or indents a key wrong, dies
#     here instead of at 3am.
for combo in "oidc" "ai" "events" "observability" "turn" "sfu" "recording" \
             "scale" "ha" "backup" "backup-s3" "tls" "all" \
             "oidc ai" "oidc ai events" "sfu recording observability" \
             "scale ha events" "oidc ai events observability sfu scale"; do
  # shellcheck disable=SC2086
  ./stack.sh config $combo -- -q >/dev/null 2>&1
  ok $? "compose config is valid for: $combo"
done

# --- The bug this file exists for.
profiles=$(envof backend SPRING_PROFILES_ACTIVE oidc ai)
[ "$profiles" = "postgres,oidc,ai" ]
ok $? "oidc + ai keeps BOTH profiles (got: $profiles)"

profiles=$(envof backend SPRING_PROFILES_ACTIVE ai oidc)
[ "$profiles" = "postgres,oidc,ai" ]
ok $? "and the order the features are named does not change the result"

profiles=$(envof backend SPRING_PROFILES_ACTIVE oidc ai events scale)
[ "$profiles" = "postgres,oidc,ai,kafka,redis" ]
ok $? "four feature overlays contribute four profiles (got: $profiles)"

# The specific fail-open: OIDC settings present while the profile that enforces
# them is missing is the state where the room looks locked and is wide open.
# Checked across every combination that includes oidc, because the bug only ever
# appeared in combination.
for combo in "oidc" "oidc ai" "oidc events" "oidc ai events" "oidc scale" "all"; do
  # shellcheck disable=SC2086
  issuer=$(envof backend OIDC_ISSUER $combo)
  # shellcheck disable=SC2086
  active=$(envof backend SPRING_PROFILES_ACTIVE $combo)
  if [ -n "$issuer" ]; then
    case ",$active," in *,oidc,*) rc=0;; *) rc=1;; esac
  else
    rc=1
  fi
  ok $rc "OIDC_ISSUER is never set without the oidc profile: $combo ($active)"
done

# --- Standalone use is unchanged: the defaults still stand on their own.
profiles=$(envof backend SPRING_PROFILES_ACTIVE oidc)
[ "$profiles" = "postgres,oidc" ]
ok $? "one overlay on its own is unaffected by the shared variable"

profiles=$(envof backend SPRING_PROFILES_ACTIVE)
[ "$profiles" = "postgres" ]
ok $? "and so is the base stack"

# --- Prerequisites are pulled in rather than silently missing.
#
# Captured first, then matched. Piping straight into `grep -q` made this flaky:
# grep exits the moment it matches, the launcher takes SIGPIPE on its next
# stderr line, and with `pipefail` the pipeline reports 141 — a race that
# happened to win interactively and lose inside the suite.
notes() { ./stack.sh files "$@" 2>&1 >/dev/null; }

case "$(notes recording)" in *"requires sfu"*) rc=0;; *) rc=1;; esac
ok $rc "recording pulls in sfu"
case "$(notes ha)" in *"requires scale"*) rc=0;; *) rc=1;; esac
ok $rc "ha pulls in scale"
case "$(notes backup-s3)" in *"requires backup"*) rc=0;; *) rc=1;; esac
ok $rc "backup-s3 pulls in backup"

case "$(./stack.sh files recording 2>/dev/null)" in
  *docker-compose.sfu.yml*) rc=0;; *) rc=1;;
esac
ok $rc "and the file it needs really is on the command line"

# --- Stacking order is intent, not accident: the later file must win where two
#     overlays configure the same thing.
config=$(./stack.sh config sfu recording 2>/dev/null | grep -c "livekit-recording.yaml")
[ "$config" -ge 1 ]
ok $? "recording's LiveKit config replaces the plain SFU one"

# --- Unknown features are refused rather than silently ignored.
if ./stack.sh files nonsense >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "an unknown feature name is an error, not a no-op"

echo
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "COMPOSE: ${#FAILED[@]} FAILED — ${FAILED[*]}"
  exit 1
fi
echo "ALL $PASS COMPOSE CHECKS PASSED"
