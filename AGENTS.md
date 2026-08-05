# Workspace Agents

## Project

**WarRoomLive** — low-latency multi-user collaboration room (WebRTC + WebSocket signaling). Monorepo: `frontend/` (React + TypeScript + Vite), `backend/` (Spring Boot, Java 21, Maven). See `CLAUDE.md` and `README.md` for architecture and commands.

## implementation-specialist
- Defined in `.github/agents/implementation-specialist.agent.md`
- Use this agent for code changes, refactors, bug fixes, and setup tasks.
- Prefer small, safe updates and verify behavior before claiming success.

## Workspace-specific guidance
- Verify changes before reporting success: backend with `cd backend && mvn test`, frontend with `cd frontend && npm run build`.
- The signaling envelope (`SignalMessage`) is a shared contract between `backend/.../signaling/SignalMessage.java` and `frontend/src/signaling/types.ts` — change both together.
- The WebRTC topology is full mesh; revisit `WebRtcRoom` and `SignalingHandler` before assuming an SFU.
- Keep this file and `CLAUDE.md` updated when adding endpoints, agents, or workspace conventions.
