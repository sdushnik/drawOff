import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const read = (path) => readFileSync(path, "utf8");
const composeText = read("observability/compose.yaml");
const compose = parse(composeText);
const collector = parse(read("observability/otel-collector.yaml"));
const grafana = parse(
  read("observability/grafana/provisioning/datasources/datasources.yaml"),
);
const dashboardProvider = parse(
  read("observability/grafana/provisioning/dashboards/dashboards.yaml"),
);
const dashboard = JSON.parse(
  read("observability/grafana/dashboards/drawoff-overview.json"),
);

test("observability Compose project is isolated, pinned, and health checked", () => {
  execFileSync(
    "docker",
    ["compose", "--file", "observability/compose.yaml", "config", "--quiet"],
    { stdio: "pipe" },
  );

  assert.equal(compose.name, "drawoff-observability");
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "grafana",
    "loki",
    "otel-collector",
    "prometheus",
    "tempo",
  ]);

  for (const [name, service] of Object.entries(compose.services)) {
    assert.ok(service.image.includes(":${") || /:[^$]+$/u.test(service.image), `${name} image is pinned`);
    assert.ok(service.healthcheck, `${name} has a health check`);
    for (const port of service.ports ?? []) {
      assert.match(port, /^127\.0\.0\.1:/u, `${name} binds ${port} to loopback`);
    }
  }

  assert.deepEqual(Object.keys(compose.volumes).sort(), [
    "grafana-data",
    "loki-data",
    "prometheus-data",
    "tempo-data",
  ]);
  assert.doesNotMatch(
    composeText,
    /(password|secret|token|authorization)\s*:/iu,
    "Compose must not contain credentials",
  );
});

test("collector routes each OTLP signal to its intended backend", () => {
  assert.equal(collector.receivers.otlp.protocols.http.endpoint, "0.0.0.0:4318");
  assert.equal(collector.receivers.otlp.protocols.grpc.endpoint, "0.0.0.0:4317");
  assert.deepEqual(collector.service.pipelines.metrics.exporters, ["prometheus"]);
  assert.deepEqual(collector.service.pipelines.logs.exporters, ["otlphttp/loki"]);
  assert.deepEqual(collector.service.pipelines.traces.exporters, ["otlphttp/tempo"]);
  assert.equal(collector.exporters["otlphttp/loki"].endpoint, "http://loki:3100/otlp");
  assert.equal(collector.exporters["otlphttp/tempo"].endpoint, "http://tempo:4318");
});

test("Grafana provisions linked Prometheus, Loki, and Tempo data sources", () => {
  const byUid = Object.fromEntries(
    grafana.datasources.map((source) => [source.uid, source]),
  );
  assert.deepEqual(Object.keys(byUid).sort(), ["loki", "prometheus", "tempo"]);
  assert.equal(byUid.prometheus.url, "http://prometheus:9090");
  assert.equal(byUid.loki.url, "http://loki:3100");
  assert.equal(byUid.tempo.url, "http://tempo:3200");
  assert.equal(
    byUid.tempo.jsonData.tracesToLogsV2.datasourceUid,
    "loki",
  );
  assert.equal(
    byUid.tempo.jsonData.tracesToMetrics.datasourceUid,
    "prometheus",
  );
  assert.equal(
    byUid.loki.jsonData.derivedFields[0].datasourceUid,
    "tempo",
  );
});

test("Grafana provisions the filtered DrawOff gameplay dashboard", () => {
  assert.equal(dashboardProvider.providers[0].options.path, "/etc/grafana/dashboards");
  assert.equal(dashboard.uid, "drawoff-gameplay");
  assert.deepEqual(
    dashboard.templating.list.map((variable) => variable.name),
    ["environment", "version"],
  );

  const panels = Object.fromEntries(
    dashboard.panels.map((panel) => [panel.title, panel]),
  );
  for (const title of [
    "Rooms created",
    "Active rooms",
    "Active players",
    "Matches started",
    "Drawing operations / second",
    "Operation failures / second",
  ]) {
    assert.ok(panels[title], `${title} panel is provisioned`);
    const query = panels[title].targets.map((target) => target.expr).join(" ");
    assert.match(query, /deployment_environment_name=~"\$environment"/u);
    assert.match(query, /service_version=~"\$version"/u);
  }
});
