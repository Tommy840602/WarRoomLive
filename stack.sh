#!/usr/bin/env bash
# Bring the stack up with any combination of the optional overlays.
#
#   ./stack.sh up oidc ai events                  # three features at once
#   ./stack.sh up recording observability         # recording pulls in sfu
#   ./stack.sh up all                             # everything that can coexist
#   ./stack.sh config oidc ai                     # print the merged config
#   ./stack.sh down oidc ai                       # same set, torn down
#   ./stack.sh files oidc ai                      # just the -f flags, to reuse
#
# WHY THIS EXISTS. Stacking `-f` by hand is not merely tedious, it is
# error-prone in one specific and dangerous way: a scalar environment value is
# REPLACED by a later file rather than merged, and several overlays each set
# SPRING_PROFILES_ACTIVE. `-f oidc -f ai` used to produce `postgres,ai` — the
# backend fell back to its permit-all chain while devidp still ran and the
# frontend still showed a login screen. A stack that looks authenticated and is
# not is the worst failure this repo can produce, and no test caught it because
# every suite ran one overlay at a time.
#
# So the overlays now all read $WARROOM_PROFILES, and this computes the union.
set -euo pipefail
cd "$(dirname "$0")"

# --- The catalogue: feature -> compose file, required Spring profiles, and the
#     features it cannot work without. Order in ORDER is the order the -f flags
#     are passed, which decides who wins where two overlays set the same key.
declare -A FILE=(
  [oidc]=docker-compose.oidc.yml
  [ai]=docker-compose.ai.yml
  [events]=docker-compose.events.yml
  [observability]=docker-compose.observability.yml
  [turn]=docker-compose.turn.yml
  [sfu]=docker-compose.sfu.yml
  [recording]=docker-compose.recording.yml
  [scale]=docker-compose.scale.yml
  [ha]=docker-compose.ha.yml
  [backup]=docker-compose.backup.yml
  [backup-s3]=docker-compose.backup-s3.yml
  [tls]=docker-compose.tls.yml
)

declare -A PROFILES=(
  [oidc]=oidc
  [ai]=ai
  [events]=kafka
  [scale]=redis
  [ha]="redis redisha"
)

declare -A NEEDS=(
  [recording]=sfu
  [ha]=scale
  [backup-s3]=backup
)

# Later files override earlier ones on any key they share, so this order is a
# statement about intent: recording refines sfu's LiveKit, ha refines scale's
# Redis, backup-s3 refines backup's volume, and tls takes the edge last because
# it clears the frontend's published ports.
ORDER=(oidc ai events observability turn sfu recording scale ha backup backup-s3 tls)

# Everything except tls, which republishes the edge on different ports, and
# turn, which wants host networking on a machine with a real address. `all` is
# for "does this combination even come up", not for a deployment.
ALL=(oidc ai events observability sfu recording scale ha backup)

usage() {
  cat <<USAGE
usage: ./stack.sh <command> [feature ...]

commands
  up | down | config | ps | logs | files    (anything else is passed to compose)

  Arguments after `--` go straight to docker compose:
    ./stack.sh up oidc ai -- -d --build
    ./stack.sh config oidc -- -q

features
  ${ORDER[*]}
  all        = ${ALL[*]}

notes
  recording implies sfu; ha implies scale; backup-s3 implies backup.
  Spring profiles are unioned into \$WARROOM_PROFILES automatically.
USAGE
}

[ $# -ge 1 ] || { usage; exit 1; }
CMD=$1; shift

# Features up to `--`, anything after it goes through to compose untouched.
# Without the separator there is no way to tell `./stack.sh config oidc` ("the
# oidc feature") from a service named oidc, and compose flags had nowhere to go.
WANTED=()
PASSTHRU=()
seen_sep=0
for arg in "$@"; do
  if [ "$arg" = "--" ]; then seen_sep=1; continue; fi
  if [ "$seen_sep" = "1" ]; then PASSTHRU+=("$arg"); continue; fi
  if [ "$arg" = "all" ]; then WANTED+=("${ALL[@]}"); else WANTED+=("$arg"); fi
done

# Pull in prerequisites, repeatedly — backup-s3 needs backup, which needs
# nothing, but a future chain could be deeper.
# `${arr[@]:-}` on an EMPTY array yields one empty-string element, which then
# indexes the associative arrays as [""] — "bad array subscript" under `set -u`,
# which is how the plainest invocation of all (no features at all) died.
# `${arr[@]+"${arr[@]}"}` expands to nothing instead.
for _ in 1 2 3; do
  for f in ${WANTED[@]+"${WANTED[@]}"}; do
    [ -n "${FILE[$f]+x}" ] || { echo "unknown feature: $f" >&2; usage; exit 1; }
    need=${NEEDS[$f]:-}
    if [ -n "$need" ] && [[ " ${WANTED[*]} " != *" $need "* ]]; then
      echo "note: $f requires $need — adding it" >&2
      WANTED+=("$need")
    fi
  done
done

FILES=(-f docker-compose.yml)
SELECTED=()
for f in "${ORDER[@]}"; do
  if [[ " ${WANTED[*]-} " == *" $f "* ]]; then
    FILES+=(-f "${FILE[$f]}")
    SELECTED+=("$f")
  fi
done

# The union, deduplicated, postgres first because every other profile assumes it.
profiles=(postgres)
for f in ${SELECTED[@]+"${SELECTED[@]}"}; do
  for p in ${PROFILES[$f]:-}; do
    [[ " ${profiles[*]} " == *" $p "* ]] || profiles+=("$p")
  done
done
export WARROOM_PROFILES
WARROOM_PROFILES=$(IFS=,; echo "${profiles[*]}")

# On stderr, so `files` stays pipeable while still telling you what it decided.
echo "features: ${SELECTED[*]-}" >&2
echo "profiles: $WARROOM_PROFILES" >&2

if [ "$CMD" = "files" ]; then
  echo "${FILES[@]}"
  exit 0
fi

# Record what this stack IS, for anything that later needs to talk to it.
#
# The e2e suites shell out to `docker compose` themselves — to restart a
# service, to exec psql, to run a one-off sweeper — and they used to build that
# command from the base file plus overlays they named in their own source. On a
# combined stack that is a DIFFERENT and narrower view of the same project, and
# `docker compose run` reconciles services to the config it was given: the
# sweeper in the retention suite quietly recreated collab without the events
# overlay's environment, and document.snapshot.created stopped being emitted for
# the rest of the session. Nothing logged anything; the events suite simply
# started timing out.
if [ "$CMD" = "up" ]; then
  {
    echo "WARROOM_COMPOSE_FILES='${FILES[*]}'"
    echo "WARROOM_PROFILES='$WARROOM_PROFILES'"
  } > .stack.env
fi

# `"${PASSTHRU[@]:-}"` would expand an EMPTY array to one empty-string argument,
# which compose reads as a service named "" and rejects. This expands to nothing.
exec docker compose "${FILES[@]}" "$CMD" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
