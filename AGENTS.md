# DrawOff Development Guide

## Project status and stack

DrawOff is a responsive browser-based multiplayer drawing game. The repository currently contains a React, TypeScript, Vite, and Tailwind CSS frontend with a browser-based mock game service. The planned MVP backend is Node.js, TypeScript, Fastify, and Socket.IO, with initial game state in memory; that backend and the root workspace have not been scaffolded yet.

Run frontend commands from `frontend/`:

- `npm ci` to install the locked dependencies.
- `npm run dev` to start local development.
- `npm test` to run the Vitest suite.
- `npm run build` to verify the production build.

When adding the backend workspace, keep documented root-level install, development, test, and build commands available and aligned with the actual workspace layout.

## Key documents
- `_docs/plan.md` - product behavior and feature specification
- `_docs/tasks.md` - project backlog and implementation tasks
- `_docs/process.md` - task lifecycle and orchestrator workflow
- `_docs/team/` - PM, Engineer, and QA role responsibilities
- `_docs/task-template.md` - issue grooming template

## Issue workflow

- For issue or backlog work, follow `_docs/process.md`: the main session orchestrates one issue at a time through PM grooming, Engineer implementation, and QA verification.
- Use the role instructions in `_docs/team/`; do not implement an issue before it has been groomed.
- Keep each handoff sequential: the Engineer works from the groomed acceptance criteria, QA checks the resulting implementation, and a FAIL returns to the Engineer for correction.
- The Engineer does not close issues. The orchestrator closes an issue only after QA reports PASS.
- Do not bundle work from other issues into the current task.

## Project rules

- Read `_docs/plan.md` for product behavior and `_docs/tasks.md` for the backlog before making broad changes.
- Keep changes focused, typed, and consistent with existing patterns. Prefer small, testable modules and avoid adding dependencies without a clear need.
- Validate all client and Socket.IO input at the server boundary. Return explicit errors; do not silently ignore invalid state or use success-shaped fallbacks.
- Treat the server as authoritative for room membership, player roles, game phases, deadlines, drawing permissions, prompt choice, and score calculation.
- Only the Judge may receive live drawing updates. Never broadcast an Artist's drawing data to other Artists. The Judge is read-only and receives anonymous drawing identifiers; do not reveal Artist identities until ratings are finalized.
- Keep Grid View and Focus View synchronized from the same server-held canvas state. Bound and validate drawing event sizes and rates, and preserve synchronized progress for reconnection.
- Freeze the roster for a match. Maintain deterministic Judge rotation so each player Judges once per cycle and draws in every other round.
- Preserve the confirmed product rules: private rooms, at least three players, no fixed six-player gameplay cap, no spectator role, one to three cycles, 60-second drawing rounds, and integer ratings from 0 through 100.
- Add or update focused tests for behavior changes. Run the relevant tests and production build using the actual workspace scripts (currently `cd frontend && npm test` and `cd frontend && npm run build`); report commands that could not be run.
- Do not commit secrets, credentials, or local environment files. Keep operational capacity limits based on measurement, not an arbitrary gameplay cap.

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

# Current frontend architecture

- Frontend backend calls go through `frontend/src/services/gameService.ts`; components use the service/provider hooks rather than accessing a transport directly. `frontend/src/services/index.ts` currently selects the mock implementation.
- `frontend/src/services/mock/` is a browser-only demo service. It runs the game engine locally with simulated latency, timers, demo players, and session storage; it is not a networked or authoritative backend.
- `frontend/src/game/engine.ts` contains the current deterministic game rules and privacy-filtered player views. It injects clock/random sources for testing and is a candidate for reuse by a future authoritative server.
- Pure rules and validation live in `frontend/src/game/rules.ts`; drawing operations are validated/applied in `frontend/src/game/canvasOps.ts` and rendered by `frontend/src/game/render.ts`.
- Drawing uses ordered operations (stroke append, fill, clear, undo); bucket fill is a single operation replayed by the pure `floodFill`, never a per-pixel network event.
- TypeScript is strict (`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`); keep the configuration strict rather than loosening it to accommodate code.
- Tests live next to the code (`*.test.ts[x]`) and run with `cd frontend && npm test`.
