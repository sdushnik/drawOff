import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "../src/server.js";

test("backend starts with Fastify and Socket.IO", async () => {
  const { app, io, address } = await startServer({
    host: "127.0.0.1",
    port: 0,
  });

  try {
    assert.ok(new URL(address).port);
    assert.ok(io.engine);
  } finally {
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
  }
});
