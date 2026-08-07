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
| `limits` | any stack | Abuse limits on both the signaling plane and the HTTP API: an over-long chat is refused (not truncated), an oversized frame closes only that connection, a flooding sender is bounded by its token bucket while the room stays usable, and an API flood gets 429 + Retry-After while health stays answerable and the caller recovers on its own. |
| `retention` | any stack | Expired data is deleted and everything else is left alone. The interesting assertions are the negative ones — recent rows survive, and an *unpublished* outbox row survives however old it is, because that is the queue rather than history. Runs a second backend via `docker compose run` with retention turned on, so the stack under test is never reconfigured. |
| `reconnect` | any stack | The server contract behind client reconnection: an abrupt drop is announced, a re-join restores membership exactly once, a close arriving late for a replaced socket does not evict the live one, and replayed state reaches the room. |
| `oidc` | oidc overlay | Both WS planes refuse anonymous and forged credentials, and both work with a real token. Also that **identity is the server's**: a client joining under someone else's name is shown as the name its token vouches for, and a non-host is refused a recording deletion *before* the lookup — a 404 would leak whether it exists. |
| `token-lifecycle` | oidc overlay, short TTL | Refresh-token rotation and single use; a connection whose token expired is closed with 4401 on its next message. |
| `recordings` | sfu + recording overlays | A completed recording becomes a listed, playable item: the signed Egress webhook writes a row (redelivery does not duplicate it), the library lists it (paged, with nonsense paging clamped), and the presigned URL really serves the object through the proxy while a tampered signature does not. Deletion removes the row **and** the object, and a URL minted before it stops working. |
| `attachments` | sfu + recording overlays | Sharing a file: the upload goes straight to the object store through a signed PUT and the row is written only on confirmation, with the size taken from the store rather than the caller. A key from another room is refused, a replayed confirmation does not duplicate, the room is told over signaling, and deleting removes the object as well as the row. |
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
- The room cap is discovered from the running stack (`discoverRoomCap`), not
  assumed: it is 8 by default and 50 under the SFU overlay, so a hard-coded
  number turns those suites into a test of which overlay happens to be up.
- The suites assert on observable behaviour (messages, close codes, rows,
  HTTP responses) rather than on logs, except where a log line is the only
  evidence of an internal decision — ghost pruning and node placement.
- The `scale` suite pins one client to each replica instead of sending both
  through the proxy. Round-robin can put every client on the same instance,
  and a suite that happens to do so passes while cross-instance sync is
  entirely broken — which is exactly how the crash below survived an earlier
  version of this test.

Found by these suites, fixed alongside them:

- **A collab replica died the first time awareness crossed instances.**
  `@hocuspocus/extension-redis@4` installs its own nested
  `@hocuspocus/server@4` while the service ran `@hocuspocus/server@2`. The two
  versions then shared document objects over the Redis channel, and the nested
  v4 code called `document.callbacks.beforeHandleAwareness` — absent on a v2
  document — so the replica exited on an uncaught TypeError as soon as a second
  browser moved its cursor. Clients on that replica silently lost sync. Fixed
  by holding all three Hocuspocus packages on one major version.
- **The indexer raced the broker on a cold start and exited for good.** Compose
  waits for the container, not the port, and kafkajs's own retry budget is
  finite, so the whole read-model pipeline stayed dead. Its initial connect now
  retries with backoff, like the DB errors it already handled.
