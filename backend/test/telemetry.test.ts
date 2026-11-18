import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { logs, metrics, trace } from "@opentelemetry/api";
import { io as createSocketClient } from "socket.io-client";
import { KyselyGameStateRepository } from "../src/database/repository.js";
import { createServer } from "../src/server.js";
import { backendTelemetry } from "../src/telemetry.js";
import {
  initializeTelemetry,
  telemetryConfigurationFromEnvironment,
  telemetryResourceAttributes,
} from "../src/telemetry-sdk.js";

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })],
});
assert.equal(trace.setGlobalTracerProvider(tracerProvider), true);

const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});
const meterProvider = new MeterProvider({ readers: [metricReader] });
assert.equal(metrics.setGlobalMeterProvider(meterProvider), true);

const logExporter = new InMemoryLogRecordExporter();
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
});
assert.equal(logs.setGlobalLoggerProvider(loggerProvider), true);

after(async () => {
  await Promise.all([
    tracerProvider.shutdown(),
    meterProvider.shutdown(),
    loggerProvider.shutdown(),
  ]);
});

test("telemetry is opt-in and resource identity accepts only bounded safe values", async () => {
  assert.deepEqual(telemetryConfigurationFromEnvironment({}), {
    enabled: false,
    serviceName: "drawoff-backend",
    environment: "development",
    version: "development",
  });

  const enabled = telemetryConfigurationFromEnvironment({
      DRAWOFF_TELEMETRY_ENABLED: "true",
      OTEL_SERVICE_NAME: "drawoff-backend",
      DRAWOFF_DEPLOYMENT_ENVIRONMENT: "production",
      RENDER_GIT_COMMIT: "abc123",
      DATABASE_URL: "postgresql://secret-user:secret-password@private/db",
    });
  assert.deepEqual(enabled, {
      enabled: true,
      serviceName: "drawoff-backend",
      environment: "production",
      version: "abc123",
  });
  assert.deepEqual(telemetryResourceAttributes(enabled), {
    "service.name": "drawoff-backend",
    "service.version": "abc123",
    "deployment.environment.name": "production",
  });

  const invalid = telemetryConfigurationFromEnvironment({
    DRAWOFF_TELEMETRY_ENABLED: "true",
    OTEL_SERVICE_NAME: "secret user password",
    DRAWOFF_DEPLOYMENT_ENVIRONMENT: "production\nsecret",
    DRAWOFF_SERVICE_VERSION: "version with secret",
  });
  assert.deepEqual(invalid, {
    enabled: true,
    serviceName: "drawoff-backend",
    environment: "development",
    version: "development",
  });

  const disabledRuntime = initializeTelemetry({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.invalid",
  });
  assert.equal(disabledRuntime.configuration.enabled, false);
  await disabledRuntime.shutdown();
});

test("Fastify, Socket.IO, and database telemetry is correlated and payload-free", async () => {
  spanExporter.reset();
  logExporter.reset();
  const telemetry = backendTelemetry;
  const server = createServer({ logger: false, telemetry });
  const privatePath = "PRIVATE-ROOM-CODE";
  const privatePlayerName = "PRIVATE-PLAYER-NAME";

  await server.app.inject({ method: "GET", url: "/health" });
  await server.app.inject({ method: "GET", url: `/room/${privatePath}` });

  const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const client = createSocketClient(address, {
    transports: ["websocket"],
    reconnection: false,
  });
  const roomCode = await new Promise<string>((resolve, reject) => {
    client.on("connect_error", reject);
    client.emit("room:create", { name: privatePlayerName }, (response) => {
      if ("error" in response) reject(new Error(response.error.message));
      else resolve(response.session.roomCode);
    });
  });

  telemetry.recordMatchStarted();
  telemetry.recordDrawingOperations(3);
  telemetry.startSocketEvent("room:join").end("error");

  const repository = KyselyGameStateRepository.open("sqlite::memory:", telemetry);
  await repository.migrate();
  await repository.load();
  await repository.replace({ rooms: [], matches: [] });
  await repository.close();

  await meterProvider.forceFlush();

  client.close();
  await new Promise<void>((resolve) => server.io.close(() => resolve()));
  await server.app.close();
  await Promise.all([
    tracerProvider.forceFlush(),
    meterProvider.forceFlush(),
    loggerProvider.forceFlush(),
  ]);

  const spans = spanExporter.getFinishedSpans();
  const spanNames = spans.map((span) => span.name);
  assert.ok(spanNames.includes("http.request"));
  assert.ok(spanNames.includes("socket.io.room:create"));
  assert.ok(spanNames.includes("database.migrate"));
  assert.ok(spanNames.includes("database.load"));
  assert.ok(spanNames.includes("database.replace"));
  assert.ok(spanNames.includes("database.close"));

  const httpRoutes = spans
    .filter((span) => span.name === "http.request")
    .map((span) => span.attributes["http.route"]);
  assert.ok(httpRoutes.includes("/health"));
  assert.ok(httpRoutes.includes("unmatched"));

  const logs = logExporter.getFinishedLogRecords();
  assert.equal(logs.length, spans.length);
  for (const record of logs) {
    assert.equal(record.body, "Backend operation completed.");
    assert.notEqual(record.spanContext?.traceId, undefined);
    assert.ok(
      spans.some(
        (span) => span.spanContext().traceId === record.spanContext?.traceId,
      ),
    );
  }

  const serializedTelemetry = JSON.stringify({
    spans: spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
    })),
    logs: logs.map((record) => ({
      body: record.body,
      attributes: record.attributes,
    })),
    metrics: metricExporter.getMetrics(),
  });
  for (const forbidden of [
    privatePath,
    privatePlayerName,
    roomCode,
    "secret-password",
    "postgresql://",
  ]) {
    assert.equal(serializedTelemetry.includes(forbidden), false);
  }

  const exportedMetrics = metricExporter
    .getMetrics()
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics);
  const metricNames = exportedMetrics.map((metric) => metric.descriptor.name);
  assert.ok(metricNames.includes("drawoff.backend.operations"));
  assert.ok(metricNames.includes("drawoff.backend.operation.duration"));
  assert.ok(metricNames.includes("drawoff.backend.operation.failures"));
  assert.ok(metricNames.includes("drawoff.gameplay.rooms.created"));
  assert.ok(metricNames.includes("drawoff.gameplay.matches.started"));
  assert.ok(metricNames.includes("drawoff.gameplay.drawing.operations"));
  assert.ok(metricNames.includes("drawoff.gameplay.rooms.active"));
  assert.ok(metricNames.includes("drawoff.gameplay.players.active"));

  const gameplayMetrics = exportedMetrics.filter((metric) =>
    metric.descriptor.name.startsWith("drawoff.gameplay."),
  );
  assert.ok(gameplayMetrics.length >= 5);
  for (const metric of gameplayMetrics) {
    for (const point of metric.dataPoints) {
      assert.deepEqual(point.attributes, {});
    }
  }

  const failures = exportedMetrics.find(
    (metric) => metric.descriptor.name === "drawoff.backend.operation.failures",
  );
  assert.ok(failures);
  assert.ok(
    failures.dataPoints.some(
      (point) =>
        point.attributes["drawoff.operation.kind"] === "socket.io" &&
        point.attributes["drawoff.operation.name"] === "room:join" &&
        Object.keys(point.attributes).length === 2,
    ),
  );

  const activeRooms = exportedMetrics.find(
    (metric) => metric.descriptor.name === "drawoff.gameplay.rooms.active",
  );
  const activePlayers = exportedMetrics.find(
    (metric) => metric.descriptor.name === "drawoff.gameplay.players.active",
  );
  assert.ok(activeRooms?.dataPoints.some((point) => point.value === 1));
  assert.ok(activePlayers?.dataPoints.some((point) => point.value === 1));
});
