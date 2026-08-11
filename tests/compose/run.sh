#!/usr/bin/env bash
# What each feature combination actually resolves to.
#
#   tests/compose/run.sh
#
# Every other suite needs a stack that is up. This one needs `docker compose
# config` alone — no images, no network, no database — which is why it is the
# only stack-shaped suite that runs in CI.
#
# It exists because of a specific bug, from back when this was a base file plus
# twelve overlays: a scalar value is REPLACED by a later `-f`, not merged, and
# several overlays each set SPRING_PROFILES_ACTIVE, so `-f oidc -f ai` produced
# `postgres,ai` — a backend on its permit-all chain behind a login screen that
# still rendered. There are no overlays now and no merge, so that shape is gone;
# what these checks defend is the pairing that replaced it. An OIDC issuer
# without the `oidc` Spring profile is the same fail-open by another route.
set -uo pipefail
cd "$(dirname "$0")/../.."

PASS=0
FAILED=()
ok() {
  if [ "$1" = "0" ]; then echo "ok: $2"; PASS=$((PASS + 1))
  else echo "FAIL: $2"; FAILED+=("$2"); fi
}

# What one feature set puts in the environment.
envof() { # envof <KEY> <feature...>
  local key=$1; shift
  ./stack.sh env "$@" 2>/dev/null | sed -n "s/^$key=//p" | head -1
}

# Which services a feature set would actually start.
services() { ./stack.sh config "$@" -- --services 2>/dev/null | sort | tr '\n' ' '; }

# macOS still invokes Bash 3.2 for /bin/bash. Keep the launcher within that
# language level even though CI's Linux runner uses a newer Bash.
if grep -Eq '^[[:space:]]*declare[[:space:]]+-A' stack.sh; then rc=1; else rc=0; fi
ok $rc "launcher avoids associative arrays unsupported by macOS Bash 3.2"

# --- Everything parses, alone and together.
for combo in "" "oidc" "ai" "events" "observability" "turn" "sfu" "recording" \
             "scale" "ha" "backup" "backup-s3" "tls" "all" \
             "oidc ai" "oidc ai events" "sfu recording observability" \
             "scale ha events" "oidc ai events observability sfu scale"; do
  # shellcheck disable=SC2086
  ./stack.sh config $combo -- -q >/dev/null 2>&1
  ok $? "config is valid for: ${combo:-(base only)}"
done

# --- Spring profiles add up rather than replace.
p=$(envof WARROOM_PROFILES oidc ai)
[ "$p" = "postgres,oidc,ai" ]; ok $? "oidc + ai keeps both profiles (got: $p)"

p=$(envof WARROOM_PROFILES ai oidc)
[ "$p" = "postgres,oidc,ai" ]; ok $? "and the order they are typed does not change the result"

p=$(envof WARROOM_PROFILES oidc ai events scale)
[ "$p" = "postgres,oidc,ai,kafka,redis" ]; ok $? "four features, four profiles (got: $p)"

p=$(envof WARROOM_PROFILES)
[ "$p" = "postgres" ]; ok $? "and the base stack is just postgres (got: $p)"

# --- The fail-open, checked from both directions.
for combo in "oidc" "oidc ai" "oidc events" "oidc ai events" "oidc scale" "all"; do
  # shellcheck disable=SC2086
  issuer=$(envof OIDC_ISSUER $combo)
  # shellcheck disable=SC2086
  active=$(envof WARROOM_PROFILES $combo)
  if [ -n "$issuer" ]; then case ",$active," in *,oidc,*) rc=0;; *) rc=1;; esac; else rc=1; fi
  ok $rc "OIDC_ISSUER is never set without the oidc profile: $combo ($active)"
done

issuer=$(envof OIDC_ISSUER ai events scale)
[ -z "$issuer" ]; ok $? "and never set by a feature that has nothing to do with auth"

# --- Optional services start only for their own feature.
case "$(services)" in
  *devidp*|*devai*|*redpanda*|*livekit*|*redis*|*prometheus*|*coturn*|*caddy*) rc=1;; *) rc=0;;
esac
ok $rc "the base stack starts nothing optional: $(services)"

case "$(services oidc)" in *devidp*) rc=0;; *) rc=1;; esac
ok $rc "oidc starts devidp"
case "$(services oidc)" in *devai*) rc=1;; *) rc=0;; esac
ok $rc "and does not start devai"
case "$(services ai)" in *devai*) rc=0;; *) rc=1;; esac
ok $rc "ai starts devai"
case "$(services events)" in *redpanda*indexer*|*indexer*redpanda*) rc=0;; *) rc=1;; esac
ok $rc "events starts redpanda and the indexer"
case "$(services backup-s3)" in *minio-backup*backup-shipper*|*backup-shipper*minio-backup*) rc=0;; *) rc=1;; esac
ok $rc "local backup-s3 starts both the shipper and its MinIO fixture"

# One Redis serves the backplane, Sentinel and egress — so it has to come up
# for any of them, which is why it carries three profiles rather than one.
for f in scale ha recording; do
  case "$(services $f)" in *redis*) rc=0;; *) rc=1;; esac
  ok $rc "redis starts for: $f"
done

# --- Prerequisites are added, not silently missing.
notes() { ./stack.sh env "$@" 2>&1 >/dev/null; }
case "$(notes recording)" in *"requires sfu"*) rc=0;; *) rc=1;; esac
ok $rc "recording pulls in sfu"
case "$(notes ha)" in *"requires scale"*) rc=0;; *) rc=1;; esac
ok $rc "ha pulls in scale"
case "$(notes backup-s3)" in *"requires backup"*) rc=0;; *) rc=1;; esac
ok $rc "backup-s3 pulls in backup"
case "$(services recording)" in *livekit*) rc=0;; *) rc=1;; esac
ok $rc "and the service it needs really does start"

# --- Settings that only make sense together.
[ "$(envof LIVEKIT_CONFIG recording)" = "livekit-recording.yaml" ]
ok $? "recording swaps in the LiveKit config that knows about egress"
[ -z "$(envof LIVEKIT_CONFIG sfu)" ]
ok $? "and plain sfu does not"
[ "$(envof MAX_ROOM_SIZE sfu)" = "50" ]
ok $? "sfu raises the signaling room cap"
[ "$(envof MESH_MAX_PEERS sfu)" = "" ]
ok $? "but leaves the mesh threshold alone — rooms still start on the mesh"
[ "$(envof PG_ARCHIVE_MODE backup)" = "on" ]
ok $? "backup turns WAL archiving on"
[ -z "$(envof PG_ARCHIVE_MODE)" ]
ok $? "and it is off without that feature"
[ "$(envof FRONTEND_BIND tls)" = "127.0.0.1" ]
ok $? "tls binds the frontend to loopback, since a port cannot be un-published"

# --- prod is a fail-closed boundary, including optional integrations.
if DB_PASSWORD= PUBLIC_ORIGIN= ./stack.sh env prod >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod refuses to start without DB_PASSWORD and PUBLIC_ORIGIN"
DB_PASSWORD=x PUBLIC_ORIGIN=https://w.example ./stack.sh env prod >/dev/null 2>&1
ok $? "and starts once they are set"

if DB_PASSWORD=x PUBLIC_ORIGIN=http://w.example ./stack.sh env prod >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod requires an HTTPS public origin"

if DB_PASSWORD=warroomlive PUBLIC_ORIGIN=https://w.example ./stack.sh env prod >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod refuses the repository database password"

if DB_PASSWORD=x PUBLIC_ORIGIN=https://w.example ./stack.sh env prod tls >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod and tls cannot claim two different edge topologies"

PROD_BASE="DB_PASSWORD=prod-db-secret PUBLIC_ORIGIN=https://w.example"

if env $PROD_BASE ./stack.sh env prod oidc >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod oidc requires a real provider"
prod_oidc_services=$(env $PROD_BASE \
  OIDC_ISSUER=https://id.example/realms/warroom \
  OIDC_JWK_SET_URI=https://id.example/realms/warroom/protocol/openid-connect/certs \
  OIDC_CLIENT_ID=warroom-web \
  ./stack.sh config prod oidc -- --services 2>/dev/null | sort | tr '\n' ' ')
case "$prod_oidc_services" in *devidp*) rc=1;; *) rc=0;; esac
ok $rc "prod oidc never starts the bundled devidp ($prod_oidc_services)"

if env $PROD_BASE ./stack.sh env prod ai >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod ai requires a real model endpoint"
prod_ai_services=$(env $PROD_BASE AI_BASE_URL=https://ai.example/v1 \
  ./stack.sh config prod ai -- --services 2>/dev/null | sort | tr '\n' ' ')
case "$prod_ai_services" in *devai*) rc=1;; *) rc=0;; esac
ok $rc "prod ai never starts the bundled devai ($prod_ai_services)"

if env $PROD_BASE ./stack.sh env prod sfu >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod sfu requires LiveKit credentials"
lk_env=$(env $PROD_BASE LIVEKIT_API_KEY=prodkey LIVEKIT_API_SECRET=prod-secret-at-least-32-bytes-long \
  ./stack.sh env prod sfu 2>/dev/null)
case "$lk_env" in *"LIVEKIT_API_KEY=prodkey"*"LIVEKIT_API_SECRET=prod-secret-at-least-32-bytes-long"*) rc=0;; *) rc=1;; esac
ok $rc "real LiveKit credentials are preserved"

if env $PROD_BASE ./stack.sh env prod turn >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod turn requires public, non-development credentials"
turn_env=$(env $PROD_BASE TURN_URLS=turn:turn.example:3478 TURN_USERNAME=prodturn TURN_PASSWORD=turn-secret \
  ./stack.sh env prod turn 2>/dev/null)
case "$turn_env" in *"TURN_URLS=turn:turn.example:3478"*) rc=0;; *) rc=1;; esac
case "$turn_env" in *"TURN_USERNAME=prodturn"*) :;; *) rc=1;; esac
case "$turn_env" in *"TURN_PASSWORD=turn-secret"*) :;; *) rc=1;; esac
ok $rc "real TURN settings are preserved"

RECORDING_ENV="$PROD_BASE LIVEKIT_API_KEY=prodkey LIVEKIT_API_SECRET=prod-secret-at-least-32-bytes-long"
if env $RECORDING_ENV ./stack.sh env prod recording >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod recording requires non-development MinIO credentials"
recording_env=$(env $RECORDING_ENV MINIO_ROOT_USER=recording-user MINIO_ROOT_PASSWORD=recording-secret \
  ./stack.sh env prod recording 2>/dev/null)
case "$recording_env" in *"EGRESS_S3_ACCESS_KEY=recording-user"*"EGRESS_S3_SECRET_KEY=recording-secret"*) rc=0;; *) rc=1;; esac
ok $rc "recording passes real MinIO credentials to the backend"
recording_config=$(env $RECORDING_ENV MINIO_ROOT_USER=recording-user MINIO_ROOT_PASSWORD=recording-secret \
  ./stack.sh config prod recording 2>/dev/null)
case "$recording_config" in *"LIVEKIT_KEYS: 'prodkey: prod-secret-at-least-32-bytes-long'"*"MINIO_ROOT_PASSWORD: recording-secret"*) rc=0;; *) rc=1;; esac
ok $rc "the same real secrets reach LiveKit, Egress and MinIO"

if env $PROD_BASE ./stack.sh env prod backup-s3 >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "prod backup-s3 requires external storage credentials and an encryption key"
prod_backup_services=$(env $PROD_BASE \
  RCLONE_CONFIG_S3_ENDPOINT=https://objects.example \
  RCLONE_CONFIG_S3_ACCESS_KEY_ID=backup-user \
  RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=backup-secret \
  BACKUP_PASSPHRASE=backup-encryption-secret \
  ./stack.sh config prod backup-s3 -- --services 2>/dev/null | sort | tr '\n' ' ')
case "$prod_backup_services" in *minio-backup*) rc=1;; *backup-shipper*) rc=0;; *) rc=1;; esac
ok $rc "prod backup-s3 starts the shipper but not the bundled MinIO ($prod_backup_services)"

# --- The e2e harness must reproduce the running stack, environment included.
#
# This is the hazard that has now bitten twice, in two different shapes. The
# suites shell out to `docker compose` themselves, and any such command that
# describes a DIFFERENT stack than the running one will have compose reconcile
# services to match it. Under the overlay model the missing piece was the file
# list; under one file it is the environment, because a set of variables — unlike
# a list of files — is not self-describing. Both times the symptom was collab
# quietly coming back with a feature switched off, mid-run, with nothing logged.
cat > .stack.env <<'FIXTURE'
WARROOM_FEATURES='ai events'
WARROOM_PROFILE_ARGS='--profile ai-dev --profile events'
EVENTS_ENABLED=true
AI_BASE_URL=http://devai:8090/v1
WARROOM_PROFILES=postgres,ai,kafka
FIXTURE
loaded=$(cd tests/e2e && node -e "
  import('./lib.mjs').then((m) => console.log([
    process.env.EVENTS_ENABLED,
    process.env.AI_BASE_URL,
    process.env.WARROOM_PROFILES,
    m.compose(),
  ].join('|')))
" 2>/dev/null)
rm -f .stack.env

case "$loaded" in
  "true|http://devai:8090/v1|postgres,ai,kafka|"*) rc=0;; *) rc=1;;
esac
ok $rc "the e2e harness loads the recorded feature environment ($loaded)"

case "$loaded" in *"--profile ai-dev --profile events"*) rc=0;; *) rc=1;; esac
ok $rc "and issues compose commands with the recorded profiles"

# --- Unknown features are an error.
if ./stack.sh env nonsense >/dev/null 2>&1; then rc=1; else rc=0; fi
ok $rc "an unknown feature name is an error, not a no-op"

echo
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "COMPOSE: ${#FAILED[@]} FAILED — ${FAILED[*]}"
  exit 1
fi
echo "ALL $PASS COMPOSE CHECKS PASSED"
