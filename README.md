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

Install the Chromium binary once, then run the production-like multi-browser
suite through the checked-in Compose stack:

```sh
npx playwright install chromium
npm run test:e2e:compose
```

Pass arguments after `--` to select any file, title, project, or other
Playwright option without changing the orchestration command:

```sh
npm run test:e2e:compose -- e2e/multiplayer.spec.ts
npm run test:e2e:compose -- --grep "private match" --project chromium
```

The command creates a unique Compose project and PostgreSQL volume for each
invocation, builds and starts the production container, waits for PostgreSQL
18, the one-shot migrations, and the application health check, and then points
Playwright at the container's real HTTP and Socket.IO endpoint. It does not run
the browser mock service, the in-memory repository, the standalone E2E backend,
or a Vite development server. An available loopback port is selected
automatically; set `DRAWOFF_E2E_PORT` to use a specific port.

Every multiplayer test creates its own room and session state and uses the
shared isolated-player fixture, which gives each simulated player a separate
browser context and closes all contexts during fixture teardown. Tests never
reuse a room from another test. Combined with the per-invocation PostgreSQL
volume, this prevents state from a prior test command or scenario affecting a
later one.

The runner always attempts scoped `docker compose down --volumes` cleanup after
success, startup/readiness errors, Playwright failures, `SIGINT`, or `SIGTERM`.
Only that invocation's generated project, containers, network, and volume are
removed; an unrelated developer Compose project is not addressed. The original
failure exit code is preserved unless cleanup is the only failure.

Failed-test traces, screenshots, and videos remain under
`frontend/test-results/`; the HTML report remains under
`frontend/playwright-report/`. These repository-local artifacts are not part of
Compose cleanup. Open the report with:

```sh
npx playwright show-report frontend/playwright-report
```

Troubleshooting:

- If Docker startup fails, confirm `docker compose version` works and Docker
  Engine is running. The startup command's PostgreSQL, migration, build, and app
  output is written to the terminal before cleanup.
- A migration or PostgreSQL health failure stops the run before Playwright and
  returns a non-zero status. Fix the reported database/container error and run
  the same command again; the failed invocation's volume is not reused.
- If a fixed `DRAWOFF_E2E_PORT` is occupied, unset it to restore automatic port
  selection or choose another port.
- If Chromium cannot launch, run `npx playwright install chromium` (and the
  platform dependency installation requested by Playwright) before retrying.

`npm run test:e2e` runs Playwright only and assumes a compatible application is
already available at `DRAWOFF_E2E_BASE_URL` or <http://127.0.0.1:8080>. The
canonical self-contained local and CI workflow is `npm run test:e2e:compose`.

## Production build

Build all workspaces:

```sh
npm run build
```

The backend build is emitted to `backend/dist`; start it with
`npm run start --workspace=@drawoff/backend`.

Production-like deployment, browser/Socket.IO smoke testing, and measured
capacity workflows are documented in [`_docs/deployment.md`](_docs/deployment.md).
