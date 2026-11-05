# Production-like deployment

DrawOff deploys as two artifacts: the built frontend and one persistent
Node.js backend that owns database-backed rooms and Socket.IO connections. The
backend must run on a host that supports long-lived WebSocket connections and
sticky process lifetime. A request-per-invocation serverless function is not a
compatible backend target.

## Build and configure

Use Node.js 20+ and npm 10+. Install exactly the locked dependencies, then
build the contracts, backend, and frontend:

```sh
npm ci
VITE_GAME_SERVER_URL=https://api.draw.example npm run build
```

`VITE_GAME_SERVER_URL` is compiled into the frontend and must be the public
HTTP(S) origin of the backend; Socket.IO upgrades it to WebSocket when
available. The repository's default frontend adapter emits a Cloudflare Worker
plus static public assets. Deploy `frontend/.output` with its generated
`wrangler.json`, or select a compatible Nitro adapter for another provider.
The repeatable local smoke uses `NITRO_PRESET=node-server` so the same
production frontend bundle can run without a vendor account; its immutable
assets remain separately cacheable.

Run the persistent backend with:

```sh
NODE_ENV=production \
HOST=0.0.0.0 \
PORT=3000 \
FRONTEND_ORIGINS=https://draw.example \
DATABASE_URL=sqlite:/var/lib/drawoff/drawoff.sqlite \
npm start --workspace @drawoff/backend
```

`FRONTEND_ORIGINS` is a comma-separated allowlist of exact frontend origins.
Wildcards are rejected. Terminate TLS at the platform proxy or load balancer,
forward WebSocket upgrade headers, and set its idle timeout above the longest
game phase. Route all Socket.IO traffic for the MVP to the same backend
process; horizontal coordination is not part of the current architecture.

The optional resource-limit environment variables are documented in
[`backend/README.md`](../backend/README.md#realtime-resource-limits). They are
operational controls, not gameplay player limits. Keep defaults until the
capacity harness has been rerun on the target host and changes are supported by
measurements.

## Health, readiness, and rollout

After startup, poll `GET /health`. A ready process returns HTTP 200 and
`{"status":"ready"}`; do not send room traffic before that response. A safe
single-process rollout is:

1. Build immutable artifacts with the intended public backend URL.
2. Start the new backend revision and wait for `/health`.
3. Run the documented database migrations, then switch traffic to the backend
   revision using the same durable database.
4. Publish the matching static frontend revision.
5. Run the production-like smoke command below against the built artifacts.
6. Retain the previous artifacts and a compatible database backup for rollback.

Do not place session tokens, credentials, or service secrets in `VITE_*`
variables: frontend variables are public. Store platform credentials in the
host's secret manager, restrict logs to metadata, and never log Socket.IO
payloads containing guest session tokens.

## Reproducible verification

The smoke command builds both artifacts, starts the built backend and frontend
on real local ports, drives a rendered Chromium client plus independent
Socket.IO clients, and verifies create/join, late-join rejection, Judge-only
live drawing, Artist privacy, and room cleanup:

```sh
npm run smoke:production --workspace @drawoff/backend
```

Run the full 75-second capacity matrix on the actual deployment class before
changing operational limits:

```sh
npm run capacity --workspace @drawoff/backend
```

The matrix defaults to 3, 5, 8, 12, and 16 players and writes
`_docs/capacity-results.json` plus `_docs/capacity-report.md`. Override ports or
room sizes with `CAPACITY_BACKEND_PORT`, `CAPACITY_FRONTEND_PORT`, and
`CAPACITY_ROOM_SIZES`. Changing `CAPACITY_DRAWING_DURATION_MS` is useful for
debugging only; published evidence must use the authoritative 75-second
default.

The checked-in capacity report predates the 75-second rule and records the
former 60-second workload. Rerun the matrix on the deployment host before
treating that report as current evidence.

On the measured Apple M1 host, 16-player representative traffic crossed the
predeclared CPU threshold while 12-player traffic passed. The report therefore
recommends the configurable per-room rate guard
`DRAWING_ROOM_RATE_MAX=500` / `DRAWING_ROOM_RATE_WINDOW_MS=10000`, not a
player-count restriction. Treat that value as host-specific and remeasure it
for the actual deployment class.
