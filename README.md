# DrawOff

DrawOff is a multiplayer drawing game project. The repository contains a React,
TypeScript, Vite, and Tailwind frontend and a minimal Node.js, TypeScript,
Fastify, and Socket.IO backend entry point.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Docker Engine with Docker Compose v2 for container workflows

## Install

From the repository root, install all workspace dependencies from the root
`package-lock.json`:

```sh
npm ci
```

## Development

Start the frontend and backend development servers together:

```sh
npm run dev
```

The frontend is served by Vite. The backend listens on port `3000` by default;
set `PORT` or `HOST` to override its listener.

The backend allows the local Vite origins on ports 5173 and 8080 in
development. In production, set `FRONTEND_ORIGINS` to a comma-separated list
of exact frontend origins (for example, `https://draw.example`). The same
allowlist is used for HTTP and Socket.IO, with credentialed CORS enabled; a
wildcard origin is not accepted.

## Persistence

The backend requires `DATABASE_URL` outside the production container default
and supports exactly these formats:

```text
sqlite:./data/drawoff.sqlite
sqlite:/absolute/path/drawoff.sqlite
sqlite::memory:
postgresql://USER:PASSWORD@HOST:5432/DATABASE
postgres://USER:PASSWORD@HOST:5432/DATABASE
```

SQLite remains fully supported. Relative paths resolve from the current
working directory, parent directories are created automatically, and existing
databases from the initial SQLite persistence release migrate in place. Never
commit a real URL or credential; set it in the process environment.

Run the versioned migrations explicitly before startup. The command is safe to
repeat on either dialect:

```sh
DATABASE_URL='sqlite:./data/drawoff.sqlite' npm run db:migrate
DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE' npm run db:migrate
```

PostgreSQL verification uses the same parameterized repository and restart
contract as SQLite:

```sh
POSTGRES_TEST_DATABASE_URL='postgresql://drawoff_test_user:LOCAL_TEST_PASSWORD@127.0.0.1:55432/drawoff_test' \
  npm run test:postgres --workspace @drawoff/backend
```

The test command refuses PostgreSQL databases whose name does not begin with
`drawoff_test`. The complete standalone PostgreSQL 16 container workflow and
credential-safe deployment examples are in
[`_docs/deployment.md`](_docs/deployment.md).

## Local PostgreSQL Compose stack

The root [`compose.yaml`](compose.yaml) builds the existing DrawOff production
image, starts `postgres:18-alpine` with named-volume storage, runs the compiled
Kysely migrations as a one-shot service, and starts Fastify only after those
migrations succeed. The complete SPA, `/health`, and Socket.IO endpoint are
then available from <http://localhost:8080>.

The checked-in database values are local-only defaults. Validate, build, and
start the stack from the repository root:

```sh
docker compose config --quiet
docker compose build app
docker compose up --detach --wait --wait-timeout 180
curl --fail --silent http://localhost:8080/health
npm run verify:compose:websocket
npm run verify:compose:persistence
CONTAINER_SMOKE_ORIGIN=http://127.0.0.1:8080 npm run smoke:container
```

`docker compose down` removes the containers and network but retains the
PostgreSQL volume. `docker compose down --volumes` is the explicit destructive
cleanup command. See [`_docs/deployment.md`](_docs/deployment.md) for exact
PostgreSQL contract-test, status, log, restart, credential-override, and cleanup
commands. This is a local single-application-process topology; the production
and multi-instance work tracked by issue #29 remains out of scope.

## Test

Run the test suites for all workspaces:

```sh
npm test
```

Run the real multi-browser frontend/backend flow:

```sh
npx playwright install chromium
npm run test:e2e
```

The end-to-end command starts an isolated Fastify/Socket.IO backend and Vite
frontend, then drives separate Chromium browser contexts through the full game
loop and recovery scenarios. It uses state-based waits, cleans up contexts and
servers on failure, and retains traces, screenshots, and video for diagnostics.

## Production build

Build all workspaces:

```sh
npm run build
```

The backend build is emitted to `backend/dist`; start it with
`npm run start --workspace=@drawoff/backend`.

Production-like deployment, browser/Socket.IO smoke testing, and measured
capacity workflows are documented in [`_docs/deployment.md`](_docs/deployment.md).
