# Single-image deployment

DrawOff builds and runs as one Docker image with one Node.js/Fastify process.
The production frontend is a TanStack Start static SPA: the existing Lovable
configuration disables Nitro for this build, prerenders `_shell.html`, and
emits fingerprinted browser assets. Fastify serves those files, owns `/health`
and `/socket.io`, and returns the SPA shell for application routes such as
`/room/ABC123`.

There is no second frontend server, process supervisor, or reverse proxy. The
browser and Socket.IO use the same public origin. The image can be run directly
with SQLite or as the single application process in the local PostgreSQL
Compose topology below. PostgreSQL is never installed inside the DrawOff image.
GitHub Actions verifies the same topology. A verified `main` push can deploy
the exact commit to development only; production promotion is a separate,
manual action as described below.

## Render environments

The root [`render.yaml`](../render.yaml) is the existing **production**
Blueprint. Its `drawoff` service, `drawoff-postgres` database, and
<https://drawoff.onrender.com> origin remain production. Do not reconnect or
apply this Blueprint as part of development setup.

[`render-development.yaml`](../render-development.yaml) is the
**development** Blueprint. It declares a distinct `drawoff-development` web
service and `drawoff-development-postgres` PostgreSQL 18 database. The service
and database names, database name, generated connection string, public origin,
deploy hook, and service ID are separate from production, so development
activity cannot read or modify production database state. Never copy a
production `DATABASE_URL` into development.

Each Blueprint describes one free Render Web Service built from the root
`Dockerfile` and one free PostgreSQL 18 database. Each application is fixed at
one instance. Neither Blueprint creates a second frontend service, worker, AWS
infrastructure, CI/CD automation, or multi-instance coordination. Render's
commit-triggered auto-deploys are disabled for both services; GitHub Actions is
the only automated deploy path.

`DATABASE_URL` comes from Render's `connectionString` resource reference, so
the generated database credentials are never stored in Git. `PORT` is set to
`10000`, and Fastify already binds that value on `0.0.0.0`. Because Render's
pre-deploy command is unavailable on free web services, the Docker command runs
the compiled, repeatable Kysely migration entry point and starts Fastify only
after migration succeeds. Render checks `GET /health` before routing traffic.

`FRONTEND_ORIGINS` self-references each service's automatically supplied
`RENDER_EXTERNAL_URL`. The SPA already selects `window.location.origin`
when no separate game server is configured, so HTTP and Socket.IO share the
service's `https://*.onrender.com` origin. Render redirects HTTP to HTTPS,
terminates TLS, and supports WebSocket upgrades; browsers therefore use secure
WSS without a committed `VITE_GAME_SERVER_URL` or any database value in a
`VITE_*` variable.

### Validate and apply manually

The repository tests parse both Blueprints and enforce their free-plan
topology, distinct resource/database names, resource references, migration
command, port, health path, and lack of committed connection strings:

```sh
npm run test:orchestration
```

With Render CLI 2.7.1 or newer authenticated to the intended workspace, run
Render's schema and semantic validation. This command validates only; it does
not create, update, sync, or deploy resources:

```sh
render blueprints validate render.yaml
render blueprints validate render-development.yaml
```

To provision development, connect the repository as a new Blueprint in the
Render Dashboard and select `render-development.yaml`. Review that the plan
contains only the named free development web service and free development
database before applying it. If the Render workspace cannot allocate another
free database, stop; do not select a paid plan or reuse production. A different
workspace that is eligible for free resources is safe because CI/CD uses
environment-specific configuration. No secret values need to be entered in the
Blueprint. The CI/CD workflow does not provision, replace, or reconfigure live
Render resources.

After a successful manual deployment, replace the example hostname and verify
the public readiness endpoint and a forced same-origin WebSocket connection:

```sh
curl --fail --silent https://drawoff-example.onrender.com/health
CONTAINER_SMOKE_ORIGIN=https://drawoff-example.onrender.com \
  npm run verify:compose:websocket
```

The expected health body is `{"status":"ready"}`. The WebSocket check rejects
polling fallback, so success confirms that `/socket.io` upgrades over WSS on
the same public origin. A custom domain is outside this Blueprint; if one is
added later, add its exact HTTPS origin to `FRONTEND_ORIGINS` in Render.

## GitHub Actions CI/CD

The [CI/CD workflow](../.github/workflows/ci-cd.yml) runs for every pull
request and every push to `main`. Its verification job installs the locked npm
dependency graph, runs all orchestration and workspace unit/integration tests,
builds the production application, explicitly builds the production Docker
image, installs Chromium, and runs the complete Playwright suite through the
isolated Docker Compose stack with PostgreSQL 18. A failed run uploads the
Playwright HTML report and any retained traces, screenshots, and videos for 14
days.

After verification, a push to `main` can run only the development deploy job,
and only when the repository variable `DEVELOPMENT_RENDER_DEPLOY_ENABLED` is
exactly `true`. The production job does not accept push events. It runs only
when a maintainer starts **CI/CD → Run workflow** on `main` and checks
`deploy_production`. Both jobs are serialized per environment, add the verified
GitHub commit SHA to the selected environment's deploy hook, wait for that
exact commit to reach `live`, and require the configured health URL to return
exactly `{"status":"ready"}`.

### Required Actions configuration

Create GitHub environments named `development` and `production`. In each
environment, add these **environment secrets** using values from that
environment's Render service:

- `DRAWOFF_RENDER_DEPLOY_HOOK_URL` — that service's secret deploy hook URL.
- `DRAWOFF_RENDER_API_KEY` — a Render API key allowed to read that service's
  deploy status. The hook, not this key, triggers the deployment.
- `DRAWOFF_RENDER_SERVICE_ID` — that environment's web service ID. It is kept
  as a secret under the repository's conservative policy.

Also add the environment variable `DRAWOFF_RENDER_HEALTH_URL`, containing only
that service's public HTTPS `/health` URL. The deployment script rejects a
non-HTTPS URL or one containing credentials. Do not create repository-level
secrets with the new `DRAWOFF_RENDER_*` names: environment scope is what keeps
development and production configuration independent. Existing legacy
repository secrets are not referenced by the workflow and can be removed after
both environments are configured and tested. The legacy repository variable
`RENDER_DEPLOY_ENABLED` is also no longer referenced.

Before enabling automatic development deployment, confirm its Blueprint has
`autoDeployTrigger: off`, verify all three development secrets and its health
variable, then create the public repository gate:

```sh
gh variable set DEVELOPMENT_RENDER_DEPLOY_ENABLED --body true
```

The next successful push to `main` deploys development and cannot start the
production job. A missing or invalid value fails safely without printing
response bodies, hook URLs, authorization headers, or secret values. To pause
development deployment:

```sh
gh variable set DEVELOPMENT_RENDER_DEPLOY_ENABLED --body false
```

For production, configure the `production` environment with the existing
`drawoff` service's values and set its health URL to
`https://drawoff.onrender.com/health`. Add required reviewers to the production
environment when the repository plan supports that protection. Promote only a
commit already observed in development: open the CI/CD workflow, select `main`,
check `deploy_production`, and run it. The workflow repeats the full
verification before deployment; it never copies development database state.

## OpenTelemetry export

The backend includes manual, allowlisted OpenTelemetry instrumentation for the
three authoritative operation boundaries:

- Fastify request spans, metrics, and completion logs include a safe HTTP
  method and only the `/health` or `unmatched` route class. Raw paths and query
  strings are never attributes.
- Socket.IO telemetry includes only the declared inbound event name and
  success/error outcome. It never receives or serializes the event payload.
- Kysely repository telemetry includes only `migrate`, `load`, `replace`, or
  `close`. SQL text, connection strings, table rows, and durable snapshots are
  never attributes, span events, or log bodies.

All completion logs use the fixed body `Backend operation completed.` and the
same active span context as their operation. The exported operation metrics are
`drawoff.backend.operations`, `drawoff.backend.operation.duration`, and
`drawoff.backend.operation.failures`. The failure counter uses only bounded
operation kind/name labels. Label-free gameplay metrics report committed room
creations and match starts, accepted drawing operations, non-expired rooms
with connected participants, and connected players. Resource attributes carry
the deployment environment and version. Do not add player names or IDs,
session tokens, room codes, prompts, ratings, drawing contents, arbitrary
errors, request URLs, or database data to telemetry.

Telemetry is disabled unless `DRAWOFF_TELEMETRY_ENABLED` is exactly `true`.
When disabled, the OpenTelemetry APIs remain no-op and no collector connection
is attempted. When enabled, traces, metrics, and logs use the official
OTLP/HTTP protobuf exporters. Configure their receiver with the standard
OpenTelemetry variables:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — base collector/backend URL; the exporters use
  the signal-specific `/v1/traces`, `/v1/metrics`, and `/v1/logs` endpoints.
- `OTEL_EXPORTER_OTLP_HEADERS` — optional authorization headers. Treat the
  entire value as a secret and configure it only in the hosting platform or a
  local untracked environment.
- Signal-specific `OTEL_EXPORTER_OTLP_TRACES_*`,
  `OTEL_EXPORTER_OTLP_METRICS_*`, and `OTEL_EXPORTER_OTLP_LOGS_*` variables may
  override the shared endpoint, headers, timeout, or compression when needed.

Resource attributes are always supplied from a narrow allowlist:

- `service.name` comes from `OTEL_SERVICE_NAME` and defaults to
  `drawoff-backend`.
- `deployment.environment.name` comes from
  `DRAWOFF_DEPLOYMENT_ENVIRONMENT`, then `NODE_ENV`, and defaults to
  `development`.
- `service.version` comes from `DRAWOFF_SERVICE_VERSION`, then Render's
  automatically supplied `RENDER_GIT_COMMIT`, and defaults to `development`
  for local work.

Values are trimmed, length-bounded, and limited to identifier-safe characters.
Automatic resource detection is off, so unrelated process or host environment
values cannot become resource attributes. The Render Blueprints set the shared
service name and distinct `production`/`development` environment attributes.
In each Render service, add the OTLP endpoint and optional headers as secrets or
private environment values, verify they reference the intended environment's
collector, and only then set `DRAWOFF_TELEMETRY_ENABLED=true`. Do not commit
collector credentials or place them in GitHub workflow output.

For local validation, start an OTLP/HTTP receiver on port `4318`, then run:

```sh
DRAWOFF_TELEMETRY_ENABLED=true \
OTEL_SERVICE_NAME=drawoff-backend \
DRAWOFF_DEPLOYMENT_ENVIRONMENT=development \
DRAWOFF_SERVICE_VERSION=local \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
DATABASE_URL='sqlite:./data/drawoff-telemetry.sqlite' \
npm run dev --workspace @drawoff/backend
```

Exercise `/health` and one Socket.IO action, then confirm all three OTLP
pipelines receive the same resource identity and that completion logs contain
the operation span's trace and span IDs. Stop the process with `SIGINT` or
`SIGTERM`; DrawOff closes Socket.IO, Fastify, the repository, and the
OpenTelemetry SDK so buffered telemetry can flush. Collector unavailability
does not change request, acknowledgement, or persistence results.

Focused privacy and correlation coverage is available without a collector:

```sh
npx tsx --test backend/test/telemetry.test.ts
```

### Rollback

First set `DEVELOPMENT_RENDER_DEPLOY_ENABLED=false` if development also needs
to be paused. For a development rollback, open the
`drawoff-development` service's **Deploys** page, roll back to the previous
successful deployment, then verify its configured health URL and same-origin
WebSocket connection. Development rollback never changes the production
service or either database.

A push cannot start production deployment. For a production rollback, open the
`drawoff` service's **Deploys** page, select the previous successful deployment,
and choose **Rollback**. Wait for Render to mark it live, then verify:

```sh
curl --fail --silent https://drawoff.onrender.com/health
```

The exact expected body is `{"status":"ready"}`. A Render rollback restores a
prior application build but does not reverse PostgreSQL migrations; DrawOff's
forward-only migrations therefore need to remain compatible with the preceding
application version. Fix or revert the repository change, let the full workflow
pass in development, and then perform a new explicit production promotion.

### Free-tier limits

Render's free service tier is suitable for evaluation, not production. The web
service spins down after 15 minutes without inbound HTTP requests or WebSocket
messages and can take about a minute to wake. Its local filesystem is
ephemeral, which is why this Blueprint uses PostgreSQL instead of the image's
SQLite default. Free Render PostgreSQL is limited to 1 GB, expires 30 days
after creation, has no backups, and is limited to one free database per Render
workspace. Render can also restart either free resource, and free web-service
usage is subject to the workspace's monthly free-instance allowance.

## Build the image

Use Docker Engine and build from the repository root:

```sh
docker build --pull --tag drawoff:local .
```

The multi-stage Dockerfile uses Node.js 20 and `npm ci` with the root
`package-lock.json`. It builds `@drawoff/contracts`, the backend, and frontend.
The final image contains the compiled backend, contracts, static SPA artifact,
and backend production dependencies only. Development dependencies, source
trees, repository SQLite files, credentials, `.env*`, tests, and local build
caches are excluded. Native `better-sqlite3` dependencies are installed in the
same Node 20 Debian image family as the runtime. The runtime also includes the
`pg` client driver, but no PostgreSQL server binaries.

## Local PostgreSQL 18 Compose deployment

The root `compose.yaml` uses Docker Compose v2 to run three ordered services:

1. `postgres` runs exactly `postgres:18-alpine`, stores PostgreSQL's versioned
   data layout in the `postgres-data` named volume, and must pass a bounded
   `pg_isready` health check.
2. `migration` uses the same DrawOff image as the application and runs the
   compiled `dist/database/migrate.js` entry point only after PostgreSQL is
   healthy. It is safe to run again against an up-to-date database.
3. `app` uses that DrawOff image and starts only after `migration` exits zero.
   Its bounded health check requires an exact `{"status":"ready"}` response
   before Compose considers it healthy.

Only the application is published, at <http://localhost:8080>. PostgreSQL has
no host port in the default configuration. The SPA, fingerprinted assets,
`/health`, and `/socket.io` are all served from that one application origin;
there is no proxy or second long-running DrawOff process.

The Compose defaults (`drawoff_local`, `local-only-password`, and `drawoff`)
are disposable local credentials, not production secrets. Override them in
the shell or an untracked `.env` file; do not commit that file. When values are
changed, set the raw PostgreSQL variables and a matching URL whose username,
password, and database components are percent-encoded when necessary:

```sh
POSTGRES_USER=drawoff_dev \
POSTGRES_PASSWORD='replace-this-local-password' \
POSTGRES_DB=drawoff_dev \
DRAWOFF_DATABASE_URL='postgresql://drawoff_dev:replace-this-local-password@postgres:5432/drawoff_dev' \
  docker compose up --detach --wait --wait-timeout 180
```

`DRAWOFF_DATABASE_URL` is passed only to the server-side migration and app
containers. Never put database values in a `VITE_*` variable.

### Validate, build, and start

From the repository root, validate the resolved configuration, build the
existing production image, and start the ordered stack:

```sh
docker compose config --quiet
docker compose build app
docker compose up --detach --wait --wait-timeout 180
```

The startup command fails instead of reporting a healthy application if
PostgreSQL exhausts its health-check retries or migration exits nonzero.
Fastify is not started until the successful migration container is recorded.
Inspect the ordering and current health with:

```sh
docker compose ps --all
docker compose logs --tail 100 postgres migration app
```

Verify readiness and force Socket.IO to use WebSocket transport with no
polling fallback:

```sh
curl --fail --silent http://localhost:8080/health
CONTAINER_SMOKE_ORIGIN=http://127.0.0.1:8080 npm run verify:compose:websocket
```

The expected HTTP body is exactly `{"status":"ready"}`. The WebSocket check
fails if `/socket.io` is intercepted by the SPA, the upgrade is unavailable,
or Socket.IO selects any transport other than `websocket`.

Run the migration again to prove that an up-to-date database is accepted
without resetting existing data:

```sh
docker compose run --rm migration
```

### PostgreSQL 18 contract test

The optional `compose.postgres-test.yaml` publishes PostgreSQL only on the
loopback interface and only when explicitly included. Start the stack with
that verification override, create a disposable guarded test database, and
run the same shared persistence/restart/rematch/expiry/idempotency/concurrency/
privacy contract used by the PostgreSQL adapter:

```sh
docker compose -f compose.yaml -f compose.postgres-test.yaml \
  up --detach --wait --wait-timeout 180
docker compose exec -T postgres \
  dropdb --if-exists --force --username drawoff_local drawoff_test_compose
docker compose exec -T postgres \
  createdb --username drawoff_local drawoff_test_compose
POSTGRES_TEST_DATABASE_URL='postgresql://drawoff_local:local-only-password@127.0.0.1:55432/drawoff_test_compose' \
  npm run test:postgres --workspace @drawoff/backend
```

The default `compose.yaml` still exposes no PostgreSQL port. Set
`POSTGRES_TEST_PORT` if port `55432` is unavailable, and use the same port in
`POSTGRES_TEST_DATABASE_URL`. The test database name must continue to begin
with `drawoff_test`; the test harness rejects other targets before its
destructive schema reset.

### Persistence and Chromium verification

With the default stack healthy, run the persistence check:

```sh
CONTAINER_SMOKE_ORIGIN=http://127.0.0.1:8080 npm run verify:compose:persistence
```

It creates a room over a forced WebSocket connection, retains its session,
force-recreates the PostgreSQL, migration, and application containers without
removing the named volume, waits for the ordered stack to become healthy, and
resumes the same room. A successful result proves both that migrations ran
during recreation and that they did not erase the persisted room.

Install Chromium once for the locked workspace dependencies, then run the
existing real-browser multiplayer smoke against the same origin:

```sh
npm ci
npm exec --workspace frontend -- playwright install chromium
CONTAINER_SMOKE_ORIGIN=http://127.0.0.1:8080 npm run smoke:container
```

That smoke checks `/health`, forced WebSocket transport, static assets, direct
SPA invite navigation and refresh, room creation, an isolated second browser
context joining, and the shared two-player lobby.

Run the repository checks and inspect application logs for accidental URL or
local-password output:

```sh
npm test
npm run build
docker compose logs --tail 100 app migration
if docker compose logs app migration 2>&1 | grep -E 'postgresql://|local-only-password'
then
  echo 'database credentials appeared in application logs' >&2
  exit 1
else
  echo 'application logs are credential-safe'
fi
```

### Stop, restart, and clean up

Stop and remove the Compose containers and network while retaining PostgreSQL
data in the named volume:

```sh
docker compose down
```

Restart against that retained data and wait for PostgreSQL, a fresh successful
migration run, and Fastify readiness:

```sh
docker compose up --detach --wait --wait-timeout 180
```

Only when the local database is intentionally disposable, remove the named
volume as a separate, explicitly destructive action:

```sh
docker compose down --volumes
```

This Compose topology is a local deployment of one DrawOff application
process. It does not complete issue #29's production provisioning, backups,
monitoring, rollout, recovery, secret management, or multi-instance runtime
coordination.

## Direct SQLite container start and verification

Create the persistent SQLite volume once:

```sh
docker volume create drawoff-data
```

Start the application on <http://localhost:8080>:

```sh
docker run --detach \
  --name drawoff \
  --publish 8080:3000 \
  --env FRONTEND_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 \
  --mount source=drawoff-data,target=/var/lib/drawoff \
  drawoff:local
```

The image configures `DATABASE_URL` as
`sqlite:/var/lib/drawoff/drawoff.sqlite`. The named volume therefore preserves
rooms and matches when the container is replaced. `FRONTEND_ORIGINS` is an
exact comma-separated allowlist; wildcards are rejected. Set it to the actual
HTTP(S) public origin outside local testing.

Verify readiness through the same public origin:

```sh
curl --fail --silent http://localhost:8080/health
```

The expected response is `{"status":"ready"}`. View runtime logs with:

```sh
docker logs --tail 100 drawoff
```

Stop and remove the container without deleting SQLite data:

```sh
docker rm --force drawoff
```

Only when local persisted data is intentionally disposable, remove its volume:

```sh
docker volume rm drawoff-data
```

## Real-browser container smoke

The smoke driver runs on the host against the already-running container. From
a locked dependency install, ensure Chromium is available and execute it:

```sh
npm ci
npm exec --workspace frontend -- playwright install chromium
npm run smoke:container
```

The smoke verifies `/health`, forces a same-origin Socket.IO WebSocket
connection, loads the static SPA in Chromium, creates a room, directly opens
and refreshes its `/room/:code` invite link in an isolated browser context,
joins as a second player, and confirms both players appear in the same lobby.
It fails if assets or SPA fallback routing are broken, the frontend falls back
to its browser mock, health is unavailable, or Socket.IO cannot connect.

Override the target only when the container is published at a different local
origin:

```sh
CONTAINER_SMOKE_ORIGIN=http://127.0.0.1:8080 npm run smoke:container
```

The complete repeatable verification sequence is:

```sh
npm ci
npm test
npm run build
docker build --pull --tag drawoff:local .
docker volume create drawoff-data
docker run --detach \
  --name drawoff \
  --publish 8080:3000 \
  --env FRONTEND_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 \
  --mount source=drawoff-data,target=/var/lib/drawoff \
  drawoff:local
curl --fail --silent http://localhost:8080/health
npm run smoke:container
docker logs --tail 100 drawoff
docker rm --force drawoff
```

Terminate TLS at the hosting platform, keep `/health` and `/socket.io` routed
to this process, preserve WebSocket upgrade headers, and set the idle timeout
above the longest game phase. Do not place secrets in `VITE_*` variables:
frontend build values are public.

## Standalone PostgreSQL 16 verification

The commands below use disposable local-only credentials and a database name
reserved for tests. Replace them through a secret manager for a real
environment; never commit a real `DATABASE_URL` or place one in a frontend
`VITE_*` variable. Docker Compose is not used.

Create an isolated network and PostgreSQL 16 container:

```sh
docker network create drawoff-postgres-test
docker run --detach \
  --name drawoff-postgres-16 \
  --network drawoff-postgres-test \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_USER=drawoff_test_user \
  --env POSTGRES_PASSWORD=local-only-password \
  --env POSTGRES_DB=drawoff_test \
  postgres:16-bookworm
```

Wait until PostgreSQL reports ready:

```sh
until docker exec drawoff-postgres-16 \
  pg_isready --username drawoff_test_user --dbname drawoff_test
do
  sleep 1
done
```

Run the shared PostgreSQL contract. The destructive test reset is guarded and
rejects a database whose name does not begin with `drawoff_test`:

```sh
POSTGRES_TEST_DATABASE_URL='postgresql://drawoff_test_user:local-only-password@127.0.0.1:55432/drawoff_test' \
  npm run test:postgres --workspace @drawoff/backend
```

Run the same forward-only Kysely migrations twice to verify repeatability:

```sh
DATABASE_URL='postgresql://drawoff_test_user:local-only-password@127.0.0.1:55432/drawoff_test' \
  npm run db:migrate
DATABASE_URL='postgresql://drawoff_test_user:local-only-password@127.0.0.1:55432/drawoff_test' \
  npm run db:migrate
```

Build and start DrawOff on the isolated network. Inside that network the
database hostname is the PostgreSQL container name:

```sh
docker build --pull --tag drawoff:postgres .
docker run --detach \
  --name drawoff-postgres \
  --network drawoff-postgres-test \
  --publish 8080:3000 \
  --env DATABASE_URL='postgresql://drawoff_test_user:local-only-password@drawoff-postgres-16:5432/drawoff_test' \
  --env FRONTEND_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 \
  drawoff:postgres
```

The image can also run its compiled migration entry point without starting the
application:

```sh
docker run --rm \
  --network drawoff-postgres-test \
  --env DATABASE_URL='postgresql://drawoff_test_user:local-only-password@drawoff-postgres-16:5432/drawoff_test' \
  --entrypoint node \
  drawoff:postgres dist/database/migrate.js
```

Verify health and the real Chromium create/direct-invite/refresh/join flow:

```sh
curl --fail --silent http://localhost:8080/health
CONTAINER_SMOKE_ORIGIN=http://127.0.0.1:8080 npm run smoke:container
```

Inspect logs and fail the local check if the distinctive test username or
password appears. Expected application database failures use fixed sanitized
messages without URLs, SQL, driver errors, stacks, or filesystem details:

```sh
docker logs --tail 100 drawoff-postgres
if docker logs drawoff-postgres 2>&1 | grep -E 'drawoff_test_user|local-only-password'
then
  echo 'database credentials appeared in application logs' >&2
  exit 1
else
  echo 'application logs are credential-safe'
fi
```

Remove the disposable application, database, and network:

```sh
docker rm --force drawoff-postgres
docker rm --force drawoff-postgres-16
docker network rm drawoff-postgres-test
```

For SQLite, keep using `sqlite:/var/lib/drawoff/drawoff.sqlite` and the named
volume documented above. Both URL schemes use the same versioned migrations;
existing SQLite data is migrated in place without a schema reset.

## Capacity verification

The existing non-container capacity harness remains available:

```sh
npm run capacity --workspace @drawoff/backend
```

It defaults to 3, 5, 8, 12, and 16 players and writes
`_docs/capacity-results.json` plus `_docs/capacity-report.md`. The checked-in
report predates the authoritative 75-second drawing rule, so rerun it on the
target host before changing resource guards. Measured limits are operational
controls, not fixed gameplay player caps.
