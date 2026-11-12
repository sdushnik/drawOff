# DrawOff Development Guide

## Project status and stack

DrawOff is a responsive browser-based multiplayer drawing game organized as a
root npm workspace:

- `frontend/` - React, TypeScript, TanStack Start/Vite, and Tailwind CSS
- `backend/` - Node.js, TypeScript, Fastify, and Socket.IO
- `packages/contracts/` - shared runtime schemas and TypeScript contracts

The authoritative backend persists through Kysely with SQLite or PostgreSQL.
Production builds one Docker image in which Fastify serves the static frontend,
`/health`, and same-origin Socket.IO. `compose.yaml` runs that image with
PostgreSQL 18 and a migration service. The browser mock service remains for
frontend-only demo and focused test use; it is not the production backend.

Run workspace commands from the repository root:

- `npm ci` - install the locked workspace dependencies.
- `npm run dev` - start Vite and the backend together for local development.
- `npm test` - run orchestration and workspace unit/integration tests.
- `npm run build` - build shared contracts, frontend, and backend.
- `npm run db:migrate` - migrate the database selected by `DATABASE_URL`.
- `docker compose up --build` - run the production-like app and PostgreSQL 18.
- `npm run test:e2e:compose` - run Playwright against an isolated Compose stack.

Additional container, persistence, smoke, and selected-test commands are
documented in `README.md` and `_docs/deployment.md`.

## Key documents

- `_docs/plan.md` - product behavior and feature specification
- `_docs/tasks.md` - project backlog and implementation tasks
- `_docs/process.md` - streamlined task lifecycle
- `_docs/team/` - PM, Engineer, and independent QA responsibilities
- `_docs/task-template.md` - issue grooming template

## Issue workflow

- Process at most one GitHub Issue per user turn and stop after it is closed or
  genuinely blocked. Never continue automatically through the backlog.
- Follow `_docs/process.md`. The main session performs concise PM grooming and
  then Engineering sequentially; implementation never starts before grooming.
- After implementation, launch exactly one independent QA subagent. On FAIL,
  the main session fixes the same issue and returns it to that QA subagent.
- Engineering does not close issues. The main session closes an issue only
  after independent QA reports PASS.
- Do not bundle work from another issue into the current task.

## Project rules

- Read only the product and implementation documentation relevant to the
  current issue; read `_docs/plan.md` and `_docs/tasks.md` before broad changes.
- Keep changes focused, typed, and consistent with existing patterns. Prefer
  small, testable modules and avoid dependencies without a clear need.
- Validate all client and Socket.IO input at the server boundary. Return
  explicit errors; do not silently ignore invalid state or use success-shaped
  fallbacks.
- Treat the server as authoritative for room membership, player roles, game
  phases, deadlines, drawing permissions, prompt choice, and score calculation.
- Only the Judge may receive live drawing updates. Never broadcast an Artist's
  drawing data to other Artists. The Judge is read-only and receives anonymous
  drawing identifiers; do not reveal Artist identities until ratings finalize.
- Keep Grid View and Focus View synchronized from the same server-held canvas
  state. Bound and validate drawing sizes and rates, and preserve synchronized
  progress for reconnection.
- Freeze the roster for a match. Maintain deterministic Judge rotation so each
  player Judges once per cycle and draws in every other round.
- Preserve confirmed product rules: private rooms, at least three players, no
  fixed six-player cap, no spectator role, one to three cycles, drawing rounds
  up to 75 seconds that end when every Artist submits, and integer ratings from
  0 through 100.
- Do not commit secrets, credentials, local environment files, or arbitrary
  gameplay capacity caps.

<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Current architecture

- Frontend backend calls go through `frontend/src/services/gameService.ts` and
  the provider hooks. `frontend/src/services/index.ts` selects Socket.IO when a
  server URL is configured and uses the same browser origin in production; the
  mock service is the fallback for frontend-only development.
- Shared client/server schemas live in `packages/contracts/`.
- The Fastify/Socket.IO backend is authoritative for rooms and matches. Its
  Kysely repository supports SQLite and PostgreSQL, including restart recovery.
- Pure drawing operations live in `frontend/src/game/canvasOps.ts`; ordered
  stroke, fill, clear, and undo operations synchronize through the server.
- The production Docker image serves the static SPA and backend from one
  Fastify process. `compose.yaml` adds PostgreSQL 18 and ordered migrations.
- TypeScript remains strict (`noUncheckedIndexedAccess` and
  `noPropertyAccessFromIndexSignature`). Do not loosen it for convenience.

## Context and verification efficiency

- Reuse the groomed issue as the implementation specification. Do not repeat
  research or restate the full issue in handoffs.
- Inspect only relevant files and their direct dependencies. Avoid unrelated
  refactoring and broad repository rereads.
- Groom 2-4 representative acceptance criteria by default. Add an edge case
  only when essential to the goal or a documented risk.
- Run targeted tests for changed behavior. Independent QA reruns the focused
  verification once; do not repeat successful unaffected checks.
- Run full unit, build, or Compose suites only when the issue requires them,
  shared infrastructure changes, after each five completed `e2e-test` issues,
  or during final backlog verification.
- Report successful commands as command plus concise result. Retain or quote
  full logs only for failures.
- Keep GitHub comments and role handoffs limited to decisions, changed files,
  verification evidence, and blockers needed by the next stage.
