# Single-container production deployment

DrawOff builds and runs as one Docker image with one Node.js/Fastify process.
The production frontend is a TanStack Start static SPA: the existing Lovable
configuration disables Nitro for this build, prerenders `_shell.html`, and
emits fingerprinted browser assets. Fastify serves those files, owns `/health`
and `/socket.io`, and returns the SPA shell for application routes such as
`/room/ABC123`.

There is no second frontend server, process supervisor, reverse proxy, or
Docker Compose topology. The browser and Socket.IO use the same public origin.
This work does not deploy to an external service and does not add PostgreSQL,
AWS infrastructure, or CI/CD automation.

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
same Node 20 Debian image family as the runtime.

## Start and verify

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
