#!/usr/bin/env bash
# Bring WarRoomLive up with any combination of its optional features.
#
#   ./stack.sh up                          # base only
#   ./stack.sh up oidc ai events           # three features
#   ./stack.sh up recording observability  # recording pulls in sfu
#   ./stack.sh up all
#   ./stack.sh up oidc -d --build          # anything dash-led goes to compose
#   ./stack.sh env oidc ai                 # just show what those features set
#   ./stack.sh down / ps / logs / config …
#
# There is one docker-compose.yml and no overlays. Optional SERVICES are gated
# by compose profiles; optional SETTINGS on the shared services cannot be —
# compose has no per-key conditional — so the compose file always declares them
# with "off" defaults and this script supplies the on-values.
#
# That pairing is the reason this file exists. An OIDC issuer without the `oidc`
# Spring profile is a stack that renders a login screen in front of a
# permit-all backend; the two must never be settable apart. Here they are one
# table entry.
set -euo pipefail
cd "$(dirname "$0")"

FEATURES=(oidc ai events observability turn sfu recording scale ha backup backup-s3 tls prod)

# Keep these lookups as case statements rather than associative arrays. macOS
# still ships Bash 3.2, which supports indexed arrays but not `declare -A`.
profiles_for() {
  case "$1" in
    oidc) [ "$PRODUCTION" = "1" ] || echo oidc-dev ;;
    ai) [ "$PRODUCTION" = "1" ] || echo ai-dev ;;
    events|observability|turn|sfu|recording|scale|ha|tls) echo "$1" ;;
    backup-s3)
      echo backup-s3
      [ "$PRODUCTION" = "1" ] || echo backup-s3-dev
      ;;
  esac
  return 0
}

spring_for() {
  case "$1" in
    oidc) echo oidc ;;
    ai) echo ai ;;
    events) echo kafka ;;
    scale) echo redis ;;
    ha) echo "redis redisha" ;;
  esac
  return 0
}

needs_for() {
  case "$1" in
    recording) echo sfu ;;
    ha) echo scale ;;
    backup-s3) echo backup ;;
  esac
  return 0
}

usage() {
  cat <<USAGE
usage: ./stack.sh <command> [feature ...] [docker compose args]

features   ${FEATURES[*]}
           all = the development stack (excludes tls, prod and turn).

           recording implies sfu; ha implies scale; backup-s3 implies backup.

oidc and ai use bundled development stand-ins unless prod is selected.
With prod, real provider settings and every selected feature's secrets are
required; the launcher never starts devidp, devai or the backup MinIO fixture.
USAGE
}

# What each feature switches on, beyond starting its services. One place, so a
# feature's profile and its settings cannot drift apart.
settings_for() {
  case "$1" in
    oidc)
      add OIDC_ISSUER "${OIDC_ISSUER:-${PUBLIC_ORIGIN:-http://localhost:8088}/auth}"
      add OIDC_JWK_SET_URI "${OIDC_JWK_SET_URI:-http://devidp:8089/auth/jwks}"
      add OIDC_CLIENT_ID "${OIDC_CLIENT_ID:-warroomlive-web}"
      ;;
    ai)
      # Points at the bundled dev stand-in unless the caller named a real one.
      add AI_BASE_URL "${AI_BASE_URL:-http://devai:8090/v1}"
      add AI_MODEL "${AI_MODEL:-devai-phrasebook}"
      ;;
    events)
      add KAFKA_BOOTSTRAP_SERVERS redpanda:9092
      add EVENTS_ENABLED true
      ;;
    observability)
      add TRACING_ENABLED true
      ;;
    turn)
      add TURN_URLS "${TURN_URLS:-turn:${TURN_PUBLIC_HOST:-localhost}:3478}"
      add TURN_USERNAME "${TURN_USERNAME:-warroom}"
      add TURN_PASSWORD "${TURN_PASSWORD:-warroomsecret}"
      ;;
    sfu)
      # Path-style: the browser resolves it against the page origin and nginx
      # proxies /livekit, keeping the single-origin setup.
      add LIVEKIT_URL "${LIVEKIT_URL:-/livekit}"
      add LIVEKIT_API_KEY "${LIVEKIT_API_KEY:-devkey}"
      add LIVEKIT_API_SECRET "${LIVEKIT_API_SECRET:-devkey_secret_needs_at_least_32_bytes}"
      # Media no longer costs upload per peer, so the signaling cap can rise.
      # MESH_MAX_PEERS stays 8: rooms still start on the mesh and switch above it.
      add MAX_ROOM_SIZE 50
      ;;
    recording)
      add LIVEKIT_CONFIG livekit-recording.yaml
      add LIVEKIT_INTERNAL_URL "${LIVEKIT_INTERNAL_URL:-http://livekit:7880}"
      add EGRESS_S3_ENDPOINT "${EGRESS_S3_ENDPOINT:-http://minio:9000}"
      add EGRESS_S3_BUCKET "${EGRESS_S3_BUCKET:-recordings}"
      add EGRESS_S3_ACCESS_KEY "${EGRESS_S3_ACCESS_KEY:-${MINIO_ROOT_USER:-warroom}}"
      add EGRESS_S3_SECRET_KEY "${EGRESS_S3_SECRET_KEY:-${MINIO_ROOT_PASSWORD:-warroomsecret}}"
      ;;
    scale)
      add REDIS_HOST redis
      add BACKEND_REPLICAS 2
      add COLLAB_REPLICAS 2
      ;;
    ha)
      add REDIS_SENTINEL_NODES sentinel-1:26379,sentinel-2:26379,sentinel-3:26379
      add REDIS_SENTINEL_MASTER warroom
      ;;
    backup)
      add PG_ARCHIVE_MODE on
      ;;
    tls)
      # The port cannot be un-published, so it is bound to loopback: Caddy can
      # reach it and the internet cannot.
      add FRONTEND_BIND 127.0.0.1
      ;;
    prod)
      add RESTART_POLICY unless-stopped
      add ALLOWED_ORIGINS "$PUBLIC_ORIGIN"
      add FRONTEND_BIND 127.0.0.1
      add EDGE_REALIP_CONF real-ip.conf
      ;;
  esac
}

ENV_LINES=()
add() { ENV_LINES+=("$1=$2"); export "$1=$2"; }

[ $# -ge 1 ] || { usage; exit 1; }
CMD=$1; shift

ALL=(oidc ai events observability sfu recording scale ha backup)
WANTED=()
PASSTHRU=()
sep=0
for arg in "$@"; do
  if [ "$arg" = "--" ]; then sep=1; continue; fi
  # A leading dash can only be a compose argument — no feature is named `-d`.
  # Accepting it without the separator means `./stack.sh up ai --build` works,
  # rather than failing with "unknown feature: --build".
  case "$arg" in -*) sep=1;; esac
  if [ "$sep" = "1" ]; then PASSTHRU+=("$arg"); continue; fi
  if [ "$arg" = "all" ]; then WANTED+=("${ALL[@]}"); else WANTED+=("$arg"); fi
done

PRODUCTION=0
case " ${WANTED[*]-} " in *" prod "*) PRODUCTION=1;; esac

has_feature() { case " ${WANTED[*]-} " in *" $1 "*) return 0;; *) return 1;; esac; }
require_value() {
  local key=$1 value=${!1-}
  [ -n "$value" ] || { echo "prod requires $key" >&2; exit 1; }
}
reject_value() {
  local key=$1 rejected=$2 value=${!1-}
  [ "$value" != "$rejected" ] || { echo "prod refuses development value for $key" >&2; exit 1; }
}

# `prod` is a safety boundary, not a convenient restart-policy alias. Validate
# every selected integration before applying defaults so a public deployment
# cannot quietly inherit a fixture service or repository credential.
if [ "$PRODUCTION" = "1" ]; then
  has_feature tls && { echo "prod and tls are mutually exclusive edge modes" >&2; exit 1; }
  require_value DB_PASSWORD
  require_value PUBLIC_ORIGIN
  reject_value DB_PASSWORD warroomlive
  case "$PUBLIC_ORIGIN" in https://*) :;; *) echo "prod requires an https PUBLIC_ORIGIN" >&2; exit 1;; esac

  if has_feature oidc; then
    require_value OIDC_ISSUER
    require_value OIDC_JWK_SET_URI
    require_value OIDC_CLIENT_ID
    case "$OIDC_JWK_SET_URI" in *devidp*) echo "prod refuses the bundled devidp" >&2; exit 1;; esac
  fi
  if has_feature ai; then
    require_value AI_BASE_URL
    case "$AI_BASE_URL" in *devai*) echo "prod refuses the bundled devai" >&2; exit 1;; esac
  fi
  if has_feature sfu || has_feature recording; then
    require_value LIVEKIT_API_KEY
    require_value LIVEKIT_API_SECRET
    reject_value LIVEKIT_API_KEY devkey
    reject_value LIVEKIT_API_SECRET devkey_secret_needs_at_least_32_bytes
  fi
  if has_feature turn; then
    require_value TURN_USERNAME
    require_value TURN_PASSWORD
    reject_value TURN_USERNAME warroom
    reject_value TURN_PASSWORD warroomsecret
    case "${TURN_URLS:-turn:${TURN_PUBLIC_HOST:-localhost}:3478}" in
      *localhost*|*127.0.0.1*|*0.0.0.0*|*\[::1\]*)
        echo "prod requires a publicly reachable TURN_URLS or TURN_PUBLIC_HOST" >&2
        exit 1
        ;;
    esac
  fi
  if has_feature recording; then
    require_value MINIO_ROOT_USER
    require_value MINIO_ROOT_PASSWORD
    reject_value MINIO_ROOT_USER warroom
    reject_value MINIO_ROOT_PASSWORD warroomsecret
  fi
  if has_feature backup-s3; then
    require_value RCLONE_CONFIG_S3_ENDPOINT
    require_value RCLONE_CONFIG_S3_ACCESS_KEY_ID
    require_value RCLONE_CONFIG_S3_SECRET_ACCESS_KEY
    require_value BACKUP_PASSPHRASE
    reject_value RCLONE_CONFIG_S3_ACCESS_KEY_ID warroom
    reject_value RCLONE_CONFIG_S3_SECRET_ACCESS_KEY warroomsecret
    reject_value BACKUP_PASSPHRASE warroom-dev-backup-passphrase
  fi
fi

# Prerequisites, repeatedly — a chain could be deeper than one step.
for _ in 1 2 3; do
  for f in ${WANTED[@]+"${WANTED[@]}"}; do
    case " ${FEATURES[*]} " in *" $f "*) :;; *) echo "unknown feature: $f" >&2; usage; exit 1;; esac
    need=$(needs_for "$f")
    if [ -n "$need" ] && [[ " ${WANTED[*]} " != *" $need "* ]]; then
      echo "note: $f requires $need — adding it" >&2
      WANTED+=("$need")
    fi
  done
done

# Applied in FEATURES order, so what a stack ends up with never depends on the
# order the features happened to be typed.
SELECTED=()
PROFILE_ARGS=()
for f in "${FEATURES[@]}"; do
  [[ " ${WANTED[*]-} " == *" $f "* ]] || continue
  SELECTED+=("$f")
  for profile in $(profiles_for "$f"); do
    PROFILE_ARGS+=(--profile "$profile")
  done
  settings_for "$f"
done

# The Spring profile union — postgres first, since everything else assumes it.
springs=(postgres)
for f in ${SELECTED[@]+"${SELECTED[@]}"}; do
  for p in $(spring_for "$f"); do
    [[ " ${springs[*]} " == *" $p "* ]] || springs+=("$p")
  done
done
WARROOM_PROFILES=$(IFS=,; echo "${springs[*]}")
export WARROOM_PROFILES
ENV_LINES+=("WARROOM_PROFILES=$WARROOM_PROFILES")

echo "features: ${SELECTED[*]-}" >&2
echo "profiles: $WARROOM_PROFILES" >&2

if [ "$CMD" = "env" ]; then
  printf '%s\n' ${ENV_LINES[@]+"${ENV_LINES[@]}"} | sort
  exit 0
fi

# Recorded so the e2e suites can talk to the stack that is actually running
# rather than guessing which features are on.
if [ "$CMD" = "up" ]; then
  {
    printf "WARROOM_FEATURES='%s'\n" "${SELECTED[*]-}"
    printf "WARROOM_PROFILE_ARGS='%s'\n" "${PROFILE_ARGS[*]-}"
    printf '%s\n' ${ENV_LINES[@]+"${ENV_LINES[@]}"}
  } > .stack.env
fi

exec docker compose ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} "$CMD" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
