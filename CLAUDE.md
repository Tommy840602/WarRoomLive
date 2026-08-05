# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

This workspace is effectively empty — it contains only agent configuration, no application code, tests, or build tooling. It is a git repository, but has **no commits yet**; the only tracked files are the agent/config docs below. Do not assume any language, framework, build command, or test runner exists until files that establish one are added. If asked to scaffold a project, confirm scope and requirements first.

## Repository contents

- `AGENTS.md` — workspace-level agent conventions and guidance.
- `.github/agents/implementation-specialist.agent.md` — definition of the `implementation-specialist` agent (frontmatter `name`/`description` + system prompt body).
- No `README.md`, no Cursor rules (`.cursor/rules/`, `.cursorrules`), and no Copilot instructions (`.github/copilot-instructions.md`) exist — do not search for project docs beyond this file and `AGENTS.md`.

## Agents

The `implementation-specialist` agent (defined in `.github/agents/implementation-specialist.agent.md`) is the intended agent for code changes, refactors, bug fixes, adding tests, and workspace setup. Its operating contract, which should also guide default work here:

- Read before editing; make the smallest change that satisfies the request rather than large rewrites.
- Verify the result with a relevant command, test, or build check before reporting success — do not claim success without evidence.
- State assumptions explicitly when requirements are unclear; keep changes easy to review and revert.

## Maintaining this file

When real project structure (source, tests, build/lint/test commands) is added, update this file and `AGENTS.md` with the concrete commands and architecture, and record any new agents or workspace conventions.
