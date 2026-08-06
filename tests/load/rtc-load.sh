#!/usr/bin/env sh
# LiveKit RTC load test against the SFU overlay: simulated publishers and
# subscribers exercise the media path (the k6 suite only covers signaling).
#
#   docker compose -f docker-compose.yml -f docker-compose.sfu.yml up -d
#   tests/load/rtc-load.sh [video-publishers] [subscribers] [duration]
#
# Defaults model one busy war room: 5 publishers + 20 subscribers for 60s.
# Watch the SFU panels in the Grafana dashboard while it runs (observability
# overlay), and check the summary the CLI prints for dropped/late packets.
set -eu
cd "$(dirname "$0")/../.."

PUBLISHERS=${1:-5}
SUBSCRIBERS=${2:-20}
DURATION=${3:-60s}
PROJECT=${PROJECT:-warroomlive}
NETWORK=${NETWORK:-${PROJECT}_default}
ROOM=${ROOM:-rtc-load-$(date +%s)}

# Dev credentials of the SFU overlay (infrastructure/livekit/livekit.yaml).
KEY=${LIVEKIT_API_KEY:-devkey}
SECRET=${LIVEKIT_API_SECRET:-devkey_secret_needs_at_least_32_bytes}

echo "== RTC load: $PUBLISHERS publisher(s), $SUBSCRIBERS subscriber(s), $DURATION, room $ROOM"
docker run --rm --network "$NETWORK" \
  -e LIVEKIT_URL="ws://livekit:7880" \
  -e LIVEKIT_API_KEY="$KEY" \
  -e LIVEKIT_API_SECRET="$SECRET" \
  livekit/livekit-cli:latest load-test \
    --room "$ROOM" \
    --video-publishers "$PUBLISHERS" \
    --subscribers "$SUBSCRIBERS" \
    --duration "$DURATION" \
    --simulate-speakers
