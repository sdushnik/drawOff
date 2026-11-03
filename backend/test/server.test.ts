import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import Fastify from "fastify";
import {
  healthResponseSchema,
  serviceErrorPayloadSchema,
} from "@drawoff/contracts";
import {
  createServer,
  registerHealthRoute,
  startServer,
} from "../src/server.js";

async function closeServer(io: ReturnType<typeof createServer>["io"]): Promise<void> {
  await new Promise<void>((resolve) => io.close(() => resolve()));
}

test("backend starts with Fastify and Socket.IO", async () => {
  const { app, io, address } = await startServer({
    host: "127.0.0.1",
    port: 0,
  });

  try {
    assert.ok(new URL(address).port);
    assert.ok(io.engine);
  } finally {
    await closeServer(io);
  }
});

test("GET /health reports ready after Fastify initialization", async () => {
  const { app, io } = createServer({ logger: false });

  try {
    const response = await app.inject({ method: "GET", url: "/health" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ready" });
    assert.equal(healthResponseSchema.safeParse(response.json()).success, true);
  } finally {
    await closeServer(io);
  }
});

test("GET /health reports a documented unavailable error when not ready", async () => {
  const app = Fastify({ logger: false });
  registerHealthRoute(app, () => false);

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    code: "SERVICE_UNAVAILABLE",
    message: "Service is not ready.",
  });
  assert.equal(serviceErrorPayloadSchema.safeParse(response.json()).success, true);
  await app.close();
});

test("expected client errors use the safe shared error payload", async () => {
  const { app, io } = createServer({ logger: false });
  app.get("/client-error", async () => {
    throw Object.assign(new Error("do not expose this"), { statusCode: 400 });
  });

  try {
    const response = await app.inject({ method: "GET", url: "/client-error" });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      code: "INVALID_INPUT",
      message: "The request is invalid.",
    });
    assert.equal(serviceErrorPayloadSchema.safeParse(response.json()).success, true);
    assert.equal(response.body.includes("do not expose this"), false);
  } finally {
    await closeServer(io);
  }
});

test("unexpected errors return a generic response and are logged", async () => {
  let logOutput = "";
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      logOutput += chunk.toString();
      callback();
    },
  });
  const { app, io } = createServer({
    logger: { level: "error", stream: output },
  });
  app.get("/server-error", async () => {
    throw new Error("sensitive internal detail");
  });

  try {
    const response = await app.inject({ method: "GET", url: "/server-error" });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected server error occurred.",
    });
    assert.equal(serviceErrorPayloadSchema.safeParse(response.json()).success, true);
    assert.equal(response.body.includes("sensitive internal detail"), false);
    assert.equal(response.body.includes("Error:"), false);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(logOutput, /Unhandled HTTP error/);
    assert.match(logOutput, /sensitive internal detail/);
  } finally {
    await closeServer(io);
  }
});

test("unknown routes use the safe shared not-found error payload", async () => {
  const { app, io } = createServer({ logger: false });

  try {
    const response = await app.inject({ method: "GET", url: "/missing" });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
    assert.equal(serviceErrorPayloadSchema.safeParse(response.json()).success, true);
  } finally {
    await closeServer(io);
  }
});
