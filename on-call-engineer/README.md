# Local AI on-call responder proof of concept

This local-only worker polls Prometheus's `/api/v1/alerts` endpoint and handles
only firing `DrawOffSustainedDrawingOperationFailures` alerts. It deduplicates
each environment/version alert in memory until it resolves. A process restart
forgets that state, so this proof of concept is not a durable paging system.

The worker is not included in either Compose project and has no deploy,
production-write, Git, notification, or secret-management integration.

## Safety boundary

The evidence packet contains only:

- alert name, environment, deployed version, severity, owner, and activation
  time;
- numeric five-minute drawing failure count, operation count, and ratio.

Arbitrary labels and annotations, logs, traces, environment variables, player
IDs, room codes, drawing contents, and credentials are never collected. Alert
and API data is treated as untrusted input rather than instructions.

Dry-run is the default. Explicit real-agent mode uses the existing
`@openai/codex-sdk` and locally authenticated Codex CLI; it passes no OpenAI API
key. The agent receives the evidence JSON in an empty temporary directory with
a read-only sandbox, approvals disabled, network disabled, and web search
disabled. Agent filesystem permissions deny the filesystem root and allow read
access only to that empty temporary directory. The temporary directory is
removed after the turn. Reports are JSON on stdout and are never committed,
pushed, deployed, or sent elsewhere.

## Run once

Start the local observability stack, then run the default dry-run:

```sh
docker compose --file observability/compose.yaml up --detach --wait
npm run oncall
```

With no firing alert, it exits successfully without output. A new firing alert
prints one redacted evidence packet. To exercise deterministic report output
without AI or authentication:

```sh
ONCALL_MODE=fake-agent npm run oncall
```

Continuous polling must be explicitly enabled:

```sh
ONCALL_CONTINUOUS=true ONCALL_POLL_INTERVAL_MS=30000 npm run oncall
```

Configuration:

- `ONCALL_MODE`: `dry-run` (default), `fake-agent`, or `agent`.
- `ONCALL_PROMETHEUS_URL`: default `http://127.0.0.1:9090`.
- `ONCALL_CONTINUOUS`: only `true` enables repeated polling.
- `ONCALL_POLL_INTERVAL_MS`: positive interval, default 30000.
- `ONCALL_CODEX_MODEL`: optional model name used only in `agent` mode.

The worker stops safely on malformed/unavailable APIs. If local Codex
authentication or model access is unavailable, real mode prints only a generic
authentication/access message, emits no incident report, and exits nonzero. It
does not fall back to another provider or retry with broader permissions.

## Controlled real local demonstration

This demonstration uses a loopback-only synthetic alert API, so it does not
generate failures, contact production, or modify Prometheus. First confirm the
Codex CLI is locally authenticated using your normal local setup; do not set or
add an API key to this project.

In terminal 1:

```sh
npm run oncall:demo-server
```

In terminal 2, select an available model if desired and explicitly enable the
real provider:

```sh
ONCALL_MODE=agent \
ONCALL_PROMETHEUS_URL=http://127.0.0.1:39070 \
ONCALL_CODEX_MODEL=YOUR_LOCALLY_AVAILABLE_MODEL \
npm run oncall
```

Review the single JSON report on stdout, then stop the demo server with
`Ctrl-C`. The report contains synthetic `controlled-demo` evidence only. If
authentication is unavailable, the safe failure described above is expected.

## Test

```sh
npm run test:oncall
```

Tests use fake HTTP and Codex implementations. They cover alert filtering,
redaction, metric evidence, deduplication, resolution/re-fire, all operating
modes, agent containment options, temporary-workspace cleanup, and sanitized
authentication failure. They require no Codex authentication or network.
