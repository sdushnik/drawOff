# DrawOff Development Guide

## Project status and stack

DrawOff is a responsive browser-based multiplayer drawing game. The selected MVP stack is React, TypeScript, Vite, and Tailwind CSS for the client, with Node.js, TypeScript, Fastify, and Socket.IO on one authoritative backend process. Initial game state is in memory.

The application has not been scaffolded yet. Once the project setup task creates the npm workspace and scripts, use:

- `npm install` to install dependencies.
- `npm run dev` to start local development.
- `npm test` to run the test suite.
- `npm run build` to verify production builds.

Keep these scripts available at the repository root. If the workspace layout requires separate package scripts, make the root scripts run the corresponding client and server commands.

## Key documents
- `_docs/plan.md` - product behavior and feature specification
- `_docs/tasks.md` - project backlog and implementation tasks
- `_docs/process.md` - how work and agent execution is organized

## Project rules

- Read `_docs/plan.md` for product behavior and `_docs/tasks.md` for the backlog before making broad changes.
- Keep changes focused, typed, and consistent with existing patterns. Prefer small, testable modules and avoid adding dependencies without a clear need.
- Validate all client and Socket.IO input at the server boundary. Return explicit errors; do not silently ignore invalid state or use success-shaped fallbacks.
- Treat the server as authoritative for room membership, player roles, game phases, deadlines, drawing permissions, prompt choice, and score calculation.
- Only the Judge may receive live drawing updates. Never broadcast an Artist's drawing data to other Artists. The Judge is read-only and receives anonymous drawing identifiers; do not reveal Artist identities until ratings are finalized.
- Keep Grid View and Focus View synchronized from the same server-held canvas state. Bound and validate drawing event sizes and rates, and preserve synchronized progress for reconnection.
- Freeze the roster for a match. Maintain deterministic Judge rotation so each player Judges once per cycle and draws in every other round.
- Preserve the confirmed product rules: private rooms, at least three players, no fixed six-player gameplay cap, no spectator role, one to three cycles, 60-second drawing rounds, and integer ratings from 0 through 100.
- Add or update focused tests for behavior changes. Before finishing, run the relevant tests and `npm run build` when those scripts are available; report commands that could not be run.
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

# DrawOff architecture

- All backend calls go through the `GameService` interface in `src/services/gameService.ts`; components get it via `useGameService()` / `useGameRoom()` and never touch a transport directly — so the backend can be swapped in one place (`src/services/index.ts`).
- `src/services/mock/` is the default backend: it runs the authoritative `GameEngine` in the browser with simulated latency, timers, demo players and sessionStorage persistence — so the whole app works with no server.
- `src/game/engine.ts` holds every game rule and builds privacy-filtered per-player views; it is pure (injected clock/random, `tick()` for deadlines) — so a real server can reuse it and tests can drive it deterministically.
- Pure rules/validation live in `src/game/rules.ts`; canvas ops are validated and applied by `src/game/canvasOps.ts` on both artist and backend side — so every viewer replays an identical op sequence.
- Drawing sync uses ordered ops (stroke append, fill, clear, undo) rendered incrementally by `src/game/render.ts`; bucket fill is one op replayed via the pure `floodFill` — never per-pixel network events.
- tsconfig is very strict (noUncheckedIndexedAccess, noPropertyAccessFromIndexSignature); keep code compliant rather than loosening it.
- Tests live next to the code (`*.test.ts[x]`) and run with `bunx vitest run`.
