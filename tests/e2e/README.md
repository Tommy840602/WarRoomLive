# End-to-end suites

Black-box checks against a running compose stack. Every suite talks to the
stack through the single nginx origin (`:8088`) exactly as a browser does, so
the proxy routes, the profile wiring and the overlay topology are part of what
is under test — these catch what unit tests structurally cannot.

```bash
docker compose up -d
npm --prefix tests/e2e ci        # once

tests/e2e/run.sh                 # every suite the running stack supports
tests/e2e/run.sh signaling crdt  # named suites
tests/e2e/run.sh --all           # include the destructive ones
```

`run.sh` picks suites from what is actually running, so the same command works
on the base stack and on any overlay combination. Not run in CI — CI has no
stack; these are for local verification and for proving an overlay works after
changing it.

## Suites

| Suite | Needs | Covers |
|---|---|---|
| `signaling` | any stack | Peer discovery and the glare asymmetry, point-to-point SDP/ICE relay, chat broadcast + history replay, the room cap, departure notices. |
| `room-acl` | any stack | Host assignment and handover, host-only lock and kick, refusal of non-host and spoofed-identity senders, the kicked peer's 4403 close. |
| `crdt` | any stack | Convergence through the collab service, conflict-free merge of concurrent/offline edits, full state for a late joiner. |
| `capacity` | any stack | 12 simultaneous joins against a cap-8 room split exactly 8/4 — the atomic path (per-room compute locally, Lua on Redis). |
| `oidc` | oidc overlay | Both WS planes refuse anonymous and forged credentials, and both work with a real token. |
| `token-lifecycle` | oidc overlay, short TTL | Refresh-token rotation and single use; a connection whose token expired is closed with 4401 on its next message. |
| `events` | events overlay | Activity → outbox → Redpanda → indexer → read models → search API, plus idempotent consumption of a replayed envelope. |
| `crdt-hardening` | any stack — **destructive** | An edit made inside the snapshot debounce survives SIGKILL of the collab service (update log), oversized updates are refused without harming the room, the log compacts into the snapshot. |
| `scale` | scale overlay — **destructive** | CRDT convergence across collab replicas; ghost pruning after a backend replica is SIGKILLed without closing its sockets. |

Destructive suites kill a service to prove recovery. `crdt-hardening` restarts
what it kills; `scale` leaves the replica down on purpose — `docker compose …
up -d` brings it back.

## Prerequisites per overlay

```bash
# oidc — token-lifecycle needs a TTL short enough to outlive in a test
docker compose -f docker-compose.yml -f docker-compose.oidc.yml up -d
DEVIDP_TOKEN_TTL=25 docker compose -f docker-compose.yml -f docker-compose.oidc.yml up -d

# events
docker compose -f docker-compose.yml -f docker-compose.events.yml up -d

# scale
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d
```

## Notes

- `E2E_ORIGIN` overrides the origin (default `http://localhost:8088`) when the
  stack is published elsewhere — for example behind the TLS overlay.
- Each run uses a fresh room/document id, so suites can be re-run against a
  stack that keeps its data, and several can run back to back.
- Container names are resolved through `docker compose ps`, never hard-coded:
  replica numbering is not stable across recreations.
- The suites assert on observable behaviour (messages, close codes, rows,
  HTTP responses) rather than on logs, except where a log line is the only
  evidence of an internal decision — ghost pruning and node placement.
- Found by these suites, fixed alongside them: on a cold `up -d` of the events
  overlay the indexer raced the broker and exited for good (compose waits for
  the container, not the port, and kafkajs's own retry budget is finite), so
  the whole read-model pipeline stayed dead. Its initial connect now retries
  with backoff, like the DB errors it already handled.
