import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runComposePlaywright } from "./e2e-compose.mjs";

const quietLog = { log() {}, error() {} };

function successfulRun(calls) {
  return async (command) => {
    calls.push(command);
    return { exitCode: 0, signal: null, error: null };
  };
}

function options(run, overrides = {}) {
  return {
    run,
    environment: {},
    projectName: "drawoff-e2e-test",
    allocatePort: async () => 49_123,
    waitForApplication: async () => undefined,
    log: quietLog,
    ...overrides,
  };
}

describe("Compose Playwright orchestrator", () => {
  it("forwards selected Playwright arguments between successful startup and cleanup", async () => {
    const calls = [];
    const exitCode = await runComposePlaywright(
      [
        "e2e/multiplayer.spec.ts",
        "--grep",
        "private match",
        "--project",
        "chromium",
      ],
      options(successfulRun(calls)),
    );

    assert.equal(exitCode, 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].args, [
      "run",
      "test:e2e",
      "--workspace",
      "frontend",
      "--",
      "e2e/multiplayer.spec.ts",
      "--grep",
      "private match",
      "--project",
      "chromium",
    ]);
    assert.equal(calls[1].env.DRAWOFF_E2E_BASE_URL, "http://127.0.0.1:49123");
    assert.deepEqual(calls[2].args.slice(-5), [
      "down",
      "--volumes",
      "--remove-orphans",
      "--timeout",
      "10",
    ]);
  });

  it("does not start Playwright when application readiness fails and still cleans up", async () => {
    const calls = [];
    const exitCode = await runComposePlaywright(
      [],
      options(successfulRun(calls), {
        waitForApplication: async () => {
          throw new Error("health failed");
        },
      }),
    );

    assert.equal(exitCode, 1);
    assert.equal(calls.length, 2);
    assert.equal(
      calls.some(
        ({ command }) => command.endsWith("npm") || command.endsWith("npm.cmd"),
      ),
      false,
    );
    assert.equal(calls.at(-1).args.includes("down"), true);
  });

  it("preserves a Playwright failure exit code while cleaning up", async () => {
    const calls = [];
    const run = async (command) => {
      calls.push(command);
      if (
        command.command.endsWith("npm") ||
        command.command.endsWith("npm.cmd")
      ) {
        return { exitCode: 7, signal: null, error: null };
      }
      return { exitCode: 0, signal: null, error: null };
    };

    const exitCode = await runComposePlaywright([], options(run));

    assert.equal(exitCode, 7);
    assert.equal(calls.at(-1).args.includes("down"), true);
  });

  it("preserves startup failure and runs scoped volume cleanup", async () => {
    const calls = [];
    const run = async (command) => {
      calls.push(command);
      return {
        exitCode: command.args.includes("up") ? 42 : 0,
        signal: null,
        error: null,
      };
    };

    const exitCode = await runComposePlaywright([], options(run));

    assert.equal(exitCode, 42);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.includes("--project-name"), true);
    assert.equal(calls[1].args.includes("--volumes"), true);
  });

  it("preserves an interrupt exit code and cleans up without starting Playwright", async () => {
    const calls = [];
    const exitCode = await runComposePlaywright(
      [],
      options(successfulRun(calls), {
        isInterrupted: () => true,
        interruptedSignal: () => "SIGINT",
      }),
    );

    assert.equal(exitCode, 130);
    assert.equal(calls.length, 2);
    assert.equal(
      calls.some(
        ({ command }) => command.endsWith("npm") || command.endsWith("npm.cmd"),
      ),
      false,
    );
    assert.equal(calls.at(-1).args.includes("down"), true);
  });

  it("reports cleanup failure when the test run itself succeeded", async () => {
    let invocation = 0;
    const exitCode = await runComposePlaywright(
      [],
      options(async () => {
        invocation += 1;
        return {
          exitCode: invocation === 3 ? 9 : 0,
          signal: null,
          error: null,
        };
      }),
    );

    assert.equal(exitCode, 9);
  });
});
