import assert from "node:assert/strict";
import { test } from "node:test";
import { runRenderStartup } from "../src/render-startup.js";
import type { RunningServer } from "../src/server.js";

const runningServer = { address: "http://127.0.0.1:3000" } as RunningServer;

test("Render startup completes migrations before starting Fastify", async () => {
  const events: string[] = [];

  const result = await runRenderStartup({
    migrate: async () => {
      events.push("migration started");
      await Promise.resolve();
      events.push("migration completed");
    },
    startServer: async () => {
      events.push("server started");
      return runningServer;
    },
  });

  assert.equal(result, runningServer);
  assert.deepEqual(events, [
    "migration started",
    "migration completed",
    "server started",
  ]);
});

test("Render startup does not start Fastify when migration fails", async () => {
  const migrationError = new Error("migration failed");
  let serverStarts = 0;

  await assert.rejects(
    runRenderStartup({
      migrate: async () => {
        throw migrationError;
      },
      startServer: async () => {
        serverStarts += 1;
        return runningServer;
      },
    }),
    migrationError,
  );
  assert.equal(serverStarts, 0);
});
