#!/usr/bin/env node
import {
  AgentUnavailableError,
  OnCallResponder,
} from "./responder.mjs";

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const prometheusBaseUrl = process.env["ONCALL_PROMETHEUS_URL"] ??
  "http://127.0.0.1:9090";
const alertsUrl = new URL("/api/v1/alerts", prometheusBaseUrl);
const mode = process.env["ONCALL_MODE"] ?? "dry-run";
const model = process.env["ONCALL_CODEX_MODEL"] || undefined;
const continuous = process.env["ONCALL_CONTINUOUS"] === "true";
const pollIntervalMs = positiveInteger(
  process.env["ONCALL_POLL_INTERVAL_MS"],
  30_000,
);

const responder = new OnCallResponder({
  alertsUrl,
  prometheusBaseUrl,
  mode,
  model,
});

try {
  do {
    await responder.poll();
    if (continuous) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  } while (continuous);
} catch (error) {
  const message = error instanceof AgentUnavailableError
    ? error.message
    : "The on-call responder stopped safely after an investigation error.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
