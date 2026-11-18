# Local observability

This Compose project runs separately from DrawOff and receives the backend's
existing OTLP telemetry. It provides Prometheus metrics, Loki logs, Tempo
traces, and Grafana with all three data sources pre-provisioned.

## Prerequisites

- Docker with Compose v2
- The repository's locked npm dependencies (`npm ci` from the repository root)
- Free local ports `3001`, `3100`, `3200`, `4317`, `4318`, and `9090`

All published ports bind to `127.0.0.1`. Grafana uses anonymous local admin
access so this development stack needs no checked-in password. Do not expose
these ports to another host or use this project as a production deployment.
Image versions are explicit defaults in `compose.yaml`; override an image only
through the documented Compose environment variables when testing an upgrade.

## Start

From the repository root, validate and start only the observability project:

```sh
npm run test:observability
docker compose --file observability/compose.yaml up --detach --wait
```

Then run DrawOff on the host with telemetry enabled:

```sh
DRAWOFF_TELEMETRY_ENABLED=true \
OTEL_SERVICE_NAME=drawoff-backend \
DRAWOFF_DEPLOYMENT_ENVIRONMENT=development \
DRAWOFF_SERVICE_VERSION=local \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
DATABASE_URL='sqlite:./data/drawoff-telemetry.sqlite' \
npm run dev --workspace @drawoff/backend
```

Exercise `http://127.0.0.1:3000/health` and a Socket.IO game action. The
application stack remains independent: if DrawOff is instead running inside
its own Compose network, configure a host-reachable Collector address for that
container rather than adding it to this project.

## Verify

Open Grafana at <http://127.0.0.1:3001> and use **Explore**:

- Prometheus: query `drawoff_backend_operations_total`.
- Loki: query `{service_name="drawoff-backend"}`.
- Tempo: search with `{ resource.service.name = "drawoff-backend" }`.

Grafana provisions trace links from Loki and configures Tempo links back to
Loki and Prometheus. Direct readiness endpoints are also available at
<http://127.0.0.1:9090/-/ready>, <http://127.0.0.1:3100/ready>, and
<http://127.0.0.1:3200/ready>.

The focused smoke command starts an isolated project, emits real DrawOff
health-operation telemetry, queries all three backends, checks Grafana's data
sources, and removes its containers and volumes afterward:

```sh
npm run smoke:observability
```

## Stop and reset

Stop the regular observability project while retaining its named volumes:

```sh
docker compose --file observability/compose.yaml down
```

To intentionally delete all locally retained metrics, logs, traces, and
Grafana state for this project, add `--volumes`:

```sh
docker compose --file observability/compose.yaml down --volumes
```

Neither command changes the separate DrawOff application stack or its data.
