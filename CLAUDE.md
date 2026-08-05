# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**WarRoomLive** — a low-latency, multi-user cross-department collaboration room. Participants share audio/video and data over **WebRTC**; a **WebSocket** channel carries signaling. It is a monorepo with a React (TypeScript) frontend and a Java Spring Boot backend.

## Layout

- `backend/` — Spring Boot 3.3 signaling server (Java 21, Maven).
- `frontend/` — React 18 + TypeScript, built with Vite.
- `README.md` — architecture diagram and run instructions (keep in sync with this file).
- `AGENTS.md`, `.github/agents/` — workspace agent conventions.
- `.github/workflows/ci.yml` — CI: runs `mvn verify` (backend) and `npm ci && npm run build` (frontend) on push/PR to `main`. Keep the toolchain versions here in step with the Java/Node versions above.

## Commands

Backend (`cd backend`):
- `mvn spring-boot:run` — run the server on `:8080`.
- `mvn test` — run all tests.
- `mvn -Dtest=SignalingHandlerIntegrationTest test` — run a single test class (append `#methodName` for one method).
- `mvn package` — build an executable jar into `target/`.

Frontend (`cd frontend`):
- `npm install` — install dependencies (first run).
- `npm run dev` — Vite dev server on `:5173`; proxies `/api` and `/ws` to the backend on `:8080`.
- `npm run build` — type-check (`tsc`) then production build into `dist/`.
- `npm run typecheck` — type-check only.

Local end-to-end: run the backend and `npm run dev` together, then open two browser tabs on `localhost:5173` and join the same room. `getUserMedia` only works on `localhost` or HTTPS.

## Architecture

The signaling server **never touches media** — it only relays SDP offers/answers and ICE candidates to the addressed peer, and broadcasts room membership changes. Media (SRTP) flows peer-to-peer.

- **Topology is full mesh**: every participant holds a direct `RTCPeerConnection` to every other participant. This is simplest and lowest-latency for small groups (~6–8); beyond that an SFU should replace the mesh. This assumption is baked into `WebRtcRoom` (frontend) and the per-peer relay in `SignalingHandler` (backend) — revisit both if you introduce an SFU. A hard per-room cap (`warroomlive.signaling.max-room-size`, default 8) is enforced on join via a `room-full` reply; the frontend also warns at `ROOM_WARN_THRESHOLD` (6). Raise/remove both when an SFU lands.
- **Glare avoidance**: the peer already in the room initiates the offer to a newcomer (driven by the server's `peers` vs `peer-joined` messages). Preserve this asymmetry when changing negotiation.
- **Signaling envelope is shared contract**: `SignalMessage` exists on both sides — `backend/src/main/java/com/warroomlive/signaling/SignalMessage.java` and `frontend/src/signaling/types.ts`. Adding or renaming a message `type` requires updating **both**, plus the `switch` in `SignalingHandler` and the handlers in `WebRtcRoom`.
- **Room state is in-memory** (`RoomManager`, a single process). Horizontal scaling would need a shared backplane (e.g. Redis pub/sub) — there is no persistence today.
- WebSocket allowed origins are configured via `warroomlive.signaling.allowed-origins` in `application.yml` (`*` for local dev; lock down per environment).

## Conventions

- Follow the `implementation-specialist` contract (see `.github/agents/`): read before editing, make the smallest change that satisfies the request, and verify with a build/test before reporting success.
- Backend package root is `com.warroomlive`; signaling lives under `com.warroomlive.signaling`.
- When adding backend behavior, extend the integration test style in `SignalingHandlerIntegrationTest` (drives the real `/ws/signal` endpoint with `StandardWebSocketClient`) rather than mocking the transport.

## Maintaining this file

Keep the commands and architecture notes here and in `README.md` in sync as the project evolves (new endpoints, an SFU, persistence, auth, CI). Record any new agents or workspace conventions.
