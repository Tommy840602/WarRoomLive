# Workspace Agents

## implementation-specialist
- Defined in `.github/agents/implementation-specialist.agent.md`
- Use this agent for code changes, refactors, bug fixes, and workspace setup tasks.
- Prefer small, safe updates and verify behavior before claiming success.

## Workspace-specific guidance
- The current repository contains only `.github/agents/implementation-specialist.agent.md`.
- Do not assume there is application code, tests, or build tooling present unless the user provides it.
- If additional project files are added, keep this file updated with any new agent or workspace conventions.
