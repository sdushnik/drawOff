# DrawOff

DrawOff is a responsive browser-based multiplayer drawing game. The repository
is an npm workspace containing a React, TypeScript, Vite, and Tailwind frontend,
an authoritative Node.js, TypeScript, Fastify, and Socket.IO backend, and shared
runtime contracts. Kysely provides persistent SQLite and PostgreSQL storage.
The production image builds the frontend as static assets and serves the SPA,
`/health`, and same-origin Socket.IO from one Fastify process.

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
`drawoff_test`. The complete standalone PostgreSQL 18 container workflow and
credential-safe deployment examples are in
[`_docs/deployment.md`](_docs/deployment.md).

## Operations and observability

DrawOff's Assignment 2 Part II operations path includes:

- independent Render development and production services and PostgreSQL data;
- automatic deployment of verified `main` pushes to development and an
  explicit manual production workflow;
- OpenTelemetry metrics, traces, and correlated logs;
- a separate local Prometheus, Loki, Tempo, Grafana, and OpenTelemetry
  Collector stack;
- privacy-safe gameplay metrics and a provisioned Grafana dashboard;
- a sustained drawing-operation failure alert with a response runbook; and
- a local-only, read-only Codex on-call responder proof of concept.

The deployed environments are:

- Development: <https://drawoff-development.onrender.com>
- Production: <https://drawoff.onrender.com>

Both expose `/health`. Observability and the AI responder remain local-only;
they are not deployed to either Render environment.

### Backend telemetry

OpenTelemetry is opt-in. Set `DRAWOFF_TELEMETRY_ENABLED=true` and configure an
OTLP/HTTP protobuf receiver with the standard `OTEL_EXPORTER_OTLP_*`
environment variables. For example, a local collector normally uses:

```sh
DRAWOFF_TELEMETRY_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
DATABASE_URL='sqlite:./data/drawoff.sqlite' \
npm run dev --workspace @drawoff/backend
```

The backend exports traces, bounded operation metrics and correlated logs, plus
label-free gameplay counters/gauges for rooms, connected players, matches, and
accepted drawing operations. Resource identity uses `OTEL_SERVICE_NAME`
(default `drawoff-backend`),
`DRAWOFF_DEPLOYMENT_ENVIRONMENT`, and `DRAWOFF_SERVICE_VERSION` or Render's
`RENDER_GIT_COMMIT`.

Instrumentation records only bounded operation names, outcomes, durations,
safe HTTP methods, and the `/health` or `unmatched` route class. It never
records request or event payloads, raw URLs, SQL statements, database values,
credentials, player information, room codes, prompts, ratings, or drawing
contents. Keep OTLP authorization values in `OTEL_EXPORTER_OTLP_HEADERS` in a
secret manager, never in source or a frontend `VITE_*` variable. Full setup,
shutdown, validation, and Render guidance is in
[`_docs/deployment.md`](_docs/deployment.md#opentelemetry-export).

For local metrics, logs, traces, and a pre-provisioned Grafana instance, use
the separate [`observability/`](observability/README.md) Compose project. It
accepts the same OTLP endpoint without coupling its lifecycle or storage to the
application stack.

The optional local-only [`on-call-engineer/`](on-call-engineer/README.md)
proof of concept can turn a firing drawing-failure alert into a redacted
dry-run, deterministic fake report, or explicitly enabled read-only Codex
incident report. It is not deployed and performs no remediation or Git action.

### Drawing-operation alert

The `DrawOffSustainedDrawingOperationFailures` alert requires all of the
following conditions:

- more than 20% of drawing operations fail over five minutes;
- at least five failures occur in that interval; and
- the condition remains true for 10 minutes.

The alert groups by environment and deployed version, has `warning` severity,
and is owned by `gameplay-backend`. See the
[`drawing-operation-failures` runbook](observability/runbooks/drawing-operation-failures.md)
for investigation, mitigation, resolution, and safe local test procedures.

### Controlled AI on-call demonstration

The responder defaults to dry-run and does not invoke AI unless explicitly
enabled. To demonstrate the real responder safely, start the loopback-only
synthetic alert API in one terminal:

```sh
npm run oncall:demo-server
```

Then run the locally authenticated Codex provider in another terminal:

```sh
ONCALL_MODE=agent \
ONCALL_PROMETHEUS_URL=http://127.0.0.1:39070 \
npm run oncall
```

The command prints one structured incident report for synthetic evidence. It
does not use an API key from the repository, contact production, modify code,
commit, push, deploy, or perform remediation. Stop the demo server with
`Ctrl-C`. See [`on-call-engineer/README.md`](on-call-engineer/README.md) for
dry-run, fake-agent, authentication-failure, and containment details.

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

## Deployment and CI/CD

DrawOff uses Docker Compose for production-like local and CI verification.
Render does not execute the repository's Compose file directly. The root
[`render.yaml`](render.yaml) remains the existing production Blueprint, whose
application is available at <https://drawoff.onrender.com>. The separate
[`render-development.yaml`](render-development.yaml) Blueprint defines an
independent development web service and PostgreSQL database. Both use the same
application [`Dockerfile`](Dockerfile), free plans, and secret-free resource
references, but they do not share database state.

The [GitHub Actions workflow](.github/workflows/ci-cd.yml) runs workspace unit
and integration tests, builds the production application and Docker image, and
runs the complete Playwright suite against an isolated Compose stack with
PostgreSQL 18. A verified push to `main` can deploy only to the GitHub
`development` environment. Production deployment requires an explicit manual
workflow run from `main` through the GitHub `production` environment. Render's
own automatic deploys remain disabled so CI/CD is the only automated deployment
path.

Environment setup, production promotion, browser/Socket.IO smoke testing,
rollback, and measured capacity workflows are documented in
[`_docs/deployment.md`](_docs/deployment.md).
See
[`_docs/deployment.md`](_docs/deployment.md#github-actions-cicd) for setup,
failure artifacts, health verification, and rollback.
