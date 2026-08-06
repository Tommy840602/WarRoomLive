# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**WarRoomLive** — a low-latency, multi-user cross-department collaboration room. Real-time traffic is split across three planes: **WebRTC** for audio/video media, **WebSocket** for signaling and business events, and **Yjs CRDT** for collaborative shared notes. It is a monorepo with a React (TypeScript) frontend, a Java Spring Boot backend, and a Node collab service.

## Layout

- `backend/` — Spring Boot 3.3 signaling server (Java 21, Maven).
- `frontend/` — React 18 + TypeScript, built with Vite.
- `collab/` — Node 20 Hocuspocus (Yjs) document-sync service on `:1234`; persists an update log + compacted snapshots to Postgres when reachable, else memory-only. Enforces message-size/doc-size/rate limits; requires JWTs when `OIDC_ISSUER` is set.
- `devidp/` — DEV-ONLY OIDC provider (fixed users alice/bob, in-memory key) used by the `docker-compose.oidc.yml` overlay; production swaps it for Keycloak/Entra via the `OIDC_*` env vars. Never deploy it publicly.
- `docs/architecture/roadmap.md` — phased plan mapping the target production tech stack onto this codebase; consult it before starting a new architectural increment.
- `README.md` — architecture diagram and run instructions (keep in sync with this file).
- `AGENTS.md`, `.github/agents/` — workspace agent conventions.
- `.github/workflows/ci.yml` — CI: runs `mvn verify` (backend) and `npm ci && npm run build` (frontend) on push/PR to `main`. Keep the toolchain versions here in step with the Java/Node versions above.
- `docker-compose.yml` + `backend/Dockerfile` + `frontend/Dockerfile` (nginx, `frontend/nginx.conf`) + `collab/Dockerfile` — full-stack deploy (`docker compose up --build`, opens on `:8088`). The frontend nginx reverse-proxies `/api` and `/ws` to `backend:8080` and `/ws/doc` to `collab:1234`, so the browser uses a single origin; the backend runs the `postgres` profile against the `db` service and the collab service persists to the same `db`. CI does not build images — verify Docker changes by running the stack.
- `docker-compose.oidc.yml` — opt-in auth overlay: backend runs profiles `postgres,oidc`, collab gets `OIDC_ISSUER`, and the devidp service is served under the frontend origin at `/auth` (nginx proxies it with a request-time DNS variable so the base stack still starts without it).
- `docker-compose.sfu.yml` + `infrastructure/livekit/livekit.yaml` — opt-in SFU overlay: LiveKit server, backend `LIVEKIT_*` env, signaling room cap raised to 50; nginx proxies `/livekit` (prefix stripped — LiveKit serves `/rtc` at root) while media flows over the published RTC ports.
- `docker-compose.observability.yml` + `infrastructure/observability/` — opt-in Prometheus (+ Grafana, datasource provisioned) scraping backend `/actuator/prometheus` and collab `/metrics`; neither path is proxied by nginx.
- `docker-compose.tls.yml` + `Caddyfile` — opt-in TLS overlay. Adds a Caddy edge that terminates TLS (automatic Let's Encrypt via `SITE_ADDRESS`, or its internal CA for `localhost`) and reverse-proxies to the frontend; the overlay clears the frontend's published ports with `!override []`. Apply with `-f docker-compose.yml -f docker-compose.tls.yml`. The base compose stays plaintext for simple local runs.

## Commands

Backend (`cd backend`):
- `mvn spring-boot:run` — run the server on `:8080`.
- `mvn test` — run all tests.
- `mvn -Dtest=SignalingHandlerIntegrationTest test` — run a single test class (append `#methodName` for one method).
- `mvn package` — build an executable jar into `target/`.

Frontend (`cd frontend`):
- `npm install` — install dependencies (first run).
- `npm run dev` — Vite dev server on `:5173`; proxies `/api` and `/ws` to the backend on `:8080`, and `/ws/doc` to the collab service on `:1234`.
- `npm run build` — type-check (`tsc`) then production build into `dist/`.
- `npm run typecheck` — type-check only.

Collab service (`cd collab`):
- `npm install` — install dependencies (first run).
- `npm start` — run Hocuspocus on `ws://localhost:1234`. Persists to Postgres if reachable (env: `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`), otherwise runs memory-only. Optional for local dev — everything except shared notes works without it.

Local end-to-end: run the backend and `npm run dev` together, then open two browser tabs on `localhost:5173` and join the same room. `getUserMedia` only works on `localhost` or HTTPS.

## Architecture

The signaling server **never touches media** — it only relays SDP offers/answers and ICE candidates to the addressed peer, and broadcasts room membership changes. Media (SRTP) flows peer-to-peer.

- **Media transport is mode-switched, decided by the backend**: `GET /api/media/config` returns `mesh` (default) or `sfu` (when `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are set — see `docker-compose.sfu.yml`). The frontend picks `WebRtcRoom` (full mesh) or `SfuRoom` (LiveKit) accordingly; both implement the `MediaRoom` interface, and everything else (signaling, chat, notes) is transport-agnostic. Mesh is simplest/lowest-latency for ~6–8 people; the hard per-room cap (`warroomlive.signaling.max-room-size`, default 8, raised to 50 in the SFU overlay) and the frontend warning at `ROOM_WARN_THRESHOLD` (6, mesh-only) protect it. LiveKit participant identity == signaling `selfId`, which is what maps SFU tracks onto the peer-keyed UI state — preserve that invariant. LiveKit tokens are signed server-side in `MediaController` (room-scoped video grant); the API secret never reaches the browser.
- **Glare avoidance**: the peer already in the room initiates the offer to a newcomer (driven by the server's `peers` vs `peer-joined` messages). Preserve this asymmetry when changing negotiation.
- **Signaling envelope is shared contract**: `SignalMessage` exists on both sides — `backend/src/main/java/com/warroomlive/signaling/SignalMessage.java` and `frontend/src/signaling/types.ts`. Adding or renaming a message `type` requires updating **both**, plus the `switch` in `SignalingHandler` and the handlers in `WebRtcRoom`.
- **Room membership state is in-memory** (`RoomManager`, a single process). Horizontal scaling would need a shared backplane (e.g. Redis pub/sub).
- **Chat persistence is behind `ChatRepository`** (`chat/` package) with two profile-selected implementations: `InMemoryChatRepository` (default, `@Profile("!postgres")`, bounded ring buffer) and `JpaChatRepository` (`@Profile("postgres")`, Postgres). Because `spring-boot-starter-data-jpa` is always on the classpath, the default profile **excludes** the JPA/DataSource auto-configs in `application.yml`; `application-postgres.yml` clears that exclusion. If you add a second JPA repository, both profiles must still start — keep the exclusion list in sync. On join the server replays recent chat as a `history` message.
- WebSocket allowed origins are configured via `warroomlive.signaling.allowed-origins` in `application.yml` (`*` for local dev; lock down per environment).
- **Shared notes are a separate CRDT plane**: `CollabNotes` (frontend, TipTap + Yjs) syncs through the `collab/` Hocuspocus service at `/ws/doc` — never through the signaling socket. One Yjs document per room, named `warroom:<room>`. Durable state is two-tier in Postgres: every update appends to `collab_update` (crash safety), the debounced snapshot lands in `collab_document` and trims covered log rows (compaction) — keep fetch/store symmetric if you touch either. Ephemeral state (cursors, awareness) is relayed only, throttled client-side to ~25 Hz. The signaling `SignalMessage` contract is not involved; don't add note-related message types to it.
- **Auth is profile-gated and server-side**: default = permit-all (`SecurityConfig`, `!oidc` chain); the `oidc` profile turns the backend into an OAuth2 resource server (JWT via header or `access_token` query param for WS handshakes) and collab verifies the same JWTs in `onAuthenticate` when `OIDC_ISSUER` is set. `issuer` (public string browsers see, must equal the JWT `iss`) and `jwk-set-uri` (internal fetch address) are deliberately separate because of the single-origin proxy. The frontend adapts via `GET /api/auth/config` + `AuthGate` (PKCE, `oidc-client-ts`) — never enforce anything client-side only.

## Conventions

- Follow the `implementation-specialist` contract (see `.github/agents/`): read before editing, make the smallest change that satisfies the request, and verify with a build/test before reporting success.
- Backend package root is `com.warroomlive`; signaling lives under `com.warroomlive.signaling`.
- When adding backend behavior, extend the integration test style in `SignalingHandlerIntegrationTest` (drives the real `/ws/signal` endpoint with `StandardWebSocketClient`) rather than mocking the transport.

## Maintaining this file

Keep the commands and architecture notes here and in `README.md` in sync as the project evolves (new endpoints, an SFU, persistence, auth, CI). Record any new agents or workspace conventions.
