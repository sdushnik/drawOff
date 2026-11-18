import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const composeFile = "observability/compose.yaml";
const project = process.env["DRAWOFF_OBSERVABILITY_PROJECT"] ??
  "drawoff-observability-smoke";
const compose = (...args) =>
  execFileSync(
    "docker",
    ["compose", "--project-name", project, "--file", composeFile, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function poll(description, operation, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw new Error(
    `${description} did not become observable within ${timeout}ms`,
    { cause: lastError },
  );
}

async function json(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json();
}

function waitForExit(child, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("backend did not stop after SIGTERM"));
    }, timeout);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

let backend;
let backendOutput = "";
let temporaryDirectory;
let failed = false;

try {
  compose("config", "--quiet");
  console.log("Starting the isolated observability stack...");
  compose("up", "--detach", "--wait", "--quiet-pull");

  temporaryDirectory = await mkdtemp(join(tmpdir(), "drawoff-observability-"));
  backend = spawn("node_modules/.bin/tsx", ["backend/src/index.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: `sqlite:${join(temporaryDirectory, "smoke.sqlite")}`,
      DRAWOFF_DEPLOYMENT_ENVIRONMENT: "smoke",
      DRAWOFF_SERVICE_VERSION: "smoke",
      DRAWOFF_TELEMETRY_ENABLED: "true",
      HOST: "127.0.0.1",
      OTEL_BLRP_SCHEDULE_DELAY: "250",
      OTEL_BSP_SCHEDULE_DELAY: "250",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_METRIC_EXPORT_INTERVAL: "1000",
      OTEL_SERVICE_NAME: "drawoff-backend-smoke",
      PORT: "39001",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.on("data", (chunk) => {
    backendOutput += chunk.toString();
  });
  backend.stderr.on("data", (chunk) => {
    backendOutput += chunk.toString();
  });

  await poll("DrawOff health endpoint", async () => {
    const response = await fetch("http://127.0.0.1:39001/health");
    return response.ok;
  });
  await fetch("http://127.0.0.1:39001/health");
  await delay(1_500);
  backend.kill("SIGTERM");
  const exit = await waitForExit(backend);
  backend = undefined;
  assert.equal(exit.code, 0, `backend exited with ${JSON.stringify(exit)}`);

  const prometheusQuery = new URL("http://127.0.0.1:9090/api/v1/query");
  prometheusQuery.searchParams.set(
    "query",
    'sum({__name__=~"drawoff_backend_operations.*",service_name="drawoff-backend-smoke"})',
  );
  await poll("DrawOff metrics in Prometheus", async () => {
    const result = await json(prometheusQuery);
    return result.data?.result?.length > 0;
  });

  const lokiQuery = new URL("http://127.0.0.1:3100/loki/api/v1/query_range");
  lokiQuery.searchParams.set("query", '{service_name="drawoff-backend-smoke"}');
  lokiQuery.searchParams.set("since", "5m");
  lokiQuery.searchParams.set("limit", "20");
  await poll("DrawOff logs in Loki", async () => {
    const result = await json(lokiQuery);
    return result.data?.result?.length > 0;
  });

  const tempoQuery = new URL("http://127.0.0.1:3200/api/search");
  tempoQuery.searchParams.set(
    "q",
    '{resource.service.name="drawoff-backend-smoke"}',
  );
  await poll("DrawOff traces in Tempo", async () => {
    const result = await json(tempoQuery);
    return result.traces?.length > 0;
  });

  const grafanaSources = await json("http://127.0.0.1:3001/api/datasources");
  assert.deepEqual(
    grafanaSources.map((source) => source.uid).sort(),
    ["loki", "prometheus", "tempo"],
  );
  console.log("PASS: Prometheus metrics, Loki logs, Tempo traces, and Grafana data sources verified.");
} catch (error) {
  failed = true;
  console.error(error);
  if (backendOutput) console.error(`Backend output:\n${backendOutput}`);
  try {
    console.error(compose("logs", "--no-color", "--tail", "120"));
  } catch {
    // The stack may not have started far enough to provide logs.
  }
} finally {
  if (backend) {
    backend.kill("SIGTERM");
    await waitForExit(backend).catch(() => undefined);
  }
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  try {
    compose("down", "--volumes", "--remove-orphans");
  } catch (error) {
    failed = true;
    console.error(error);
  }
}

if (failed) process.exitCode = 1;
