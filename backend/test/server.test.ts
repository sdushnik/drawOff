import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import Fastify from "fastify";
import { io as createSocketClient } from "socket.io-client";
import {
  healthResponseSchema,
  serviceErrorPayloadSchema,
} from "@drawoff/contracts";
import {
  createServer,
  resolveCorsOrigins,
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
    databaseUrl: "sqlite::memory:",
  });

  try {
    assert.ok(new URL(address).port);
    assert.ok(io.engine);
  } finally {
    await closeServer(io);
  }
});

test("configured frontend origin can use HTTP and create a room over Socket.IO polling", async () => {
  const frontendOrigin = "http://127.0.0.1:8080";
  const { app, io } = createServer({
    logger: false,
    corsOrigins: [frontendOrigin],
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const socket = createSocketClient(address, {
    autoConnect: false,
    reconnection: false,
    extraHeaders: { Origin: frontendOrigin },
  });

  try {
    const health = await fetch(`${address}/health`, {
      headers: { Origin: frontendOrigin },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), frontendOrigin);
    assert.equal(health.headers.get("access-control-allow-credentials"), "true");

    const preflight = await fetch(`${address}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: frontendOrigin,
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), frontendOrigin);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");

    const polling = await fetch(
      `${address}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`,
      { headers: { Origin: frontendOrigin } },
    );
    assert.equal(polling.status, 200);
    assert.equal(polling.headers.get("access-control-allow-origin"), frontendOrigin);
    assert.equal(polling.headers.get("access-control-allow-credentials"), "true");
    const handshake = await polling.text();
    assert.match(handshake, /^0\{/);
    const pollingSessionId = (JSON.parse(handshake.slice(1)) as { sid: string }).sid;
    await fetch(
      `${address}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(pollingSessionId)}`,
      {
        method: "POST",
        headers: {
          Origin: frontendOrigin,
          "Content-Type": "text/plain;charset=UTF-8",
        },
        body: "1",
      },
    );

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
      socket.connect();
    });
    const created = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Room creation timed out.")), 2_000);
      socket.emit("room:create", { name: "QA Artist" }, (response: unknown) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
    assert.equal(typeof created, "object");
    assert.ok(created !== null && "session" in created);

    const rejectedOrigin = await fetch(`${address}/health`, {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(rejectedOrigin.headers.has("access-control-allow-origin"), false);
  } finally {
    socket.disconnect();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});

test("CORS origins are explicit in production and reject wildcard origins", () => {
  assert.deepEqual(
    resolveCorsOrigins({
      NODE_ENV: "production",
      FRONTEND_ORIGINS: "https://draw.example,https://admin.example",
    }),
    ["https://draw.example", "https://admin.example"],
  );
  assert.throws(
    () => resolveCorsOrigins({ NODE_ENV: "production" }),
    /FRONTEND_ORIGINS must be configured in production/,
  );
  assert.throws(
    () =>
      resolveCorsOrigins({
        NODE_ENV: "production",
        FRONTEND_ORIGINS: "*",
      }),
    /Invalid frontend origin/,
  );
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
