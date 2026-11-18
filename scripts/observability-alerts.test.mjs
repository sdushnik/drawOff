import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const prometheusImage = "prom/prometheus:v3.7.3";
const prometheusDirectory = resolve("observability/prometheus");
const rulePath = "observability/prometheus/rules/drawing-operation-failures.yaml";
const fixturePath = "/etc/prometheus/tests/drawing-operation-failures.test.yaml";
const rule = parse(readFileSync(rulePath, "utf8")).groups[0].rules[0];

function promtool(...args) {
  return execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "/bin/promtool",
      "--volume",
      `${prometheusDirectory}:/etc/prometheus:ro`,
      prometheusImage,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("drawing failure alert is actionable and low-cardinality", () => {
  assert.equal(rule.alert, "DrawOffSustainedDrawingOperationFailures");
  assert.equal(rule.for, "10m");
  assert.equal(rule.labels.severity, "warning");
  assert.equal(rule.labels.owner, "gameplay-backend");
  assert.match(rule.expr, /> 0\.20/u);
  assert.match(rule.expr, />= 5/u);
  assert.match(rule.expr, /drawoff_operation_name="drawing:ops"/u);
  assert.match(rule.annotations.dashboard_url, /drawoff-gameplay/u);
  assert.match(rule.annotations.runbook_url, /drawing-operation-failures\.md/u);

  const serialized = JSON.stringify(rule);
  for (const forbidden of [
    "player_id",
    "player_name",
    "room_code",
    "prompt",
    "drawing_content",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("promtool validates syntax and inactive, firing, and resolved states", () => {
  assert.match(
    promtool("check", "rules", "/etc/prometheus/rules/drawing-operation-failures.yaml"),
    /SUCCESS/u,
  );
  assert.match(promtool("test", "rules", fixturePath), /SUCCESS/u);
});
