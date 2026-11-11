import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { io } from "socket.io-client";

const publicOrigin = process.env["CONTAINER_SMOKE_ORIGIN"] ?? "http://127.0.0.1:8080";
const composeFiles = process.env["COMPOSE_FILE"]
  ? []
  : ["--file", "compose.yaml"];

function runCompose(args) {
  const result = spawnSync("docker", ["compose", ...composeFiles, ...args], {
    encoding: "utf8",
    stdio: "inherit",
  });
  assert.equal(result.error, undefined, "Docker Compose could not be executed.");
  assert.equal(result.status, 0, `docker compose ${args.join(" ")} failed.`);
}

async function connect() {
  const socket = io(publicOrigin, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connection timed out.")), 10_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(socket.io.engine.transport.name, "websocket");
  return socket;
}

function request(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out.`)), 10_000);
    const onError = (error) => {
      clearTimeout(timer);
      reject(new Error(`${event} failed: ${error?.message ?? "unknown Socket.IO error"}`));
    };
    socket.once("error", onError);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(response);
    });
  });
}

async function verifyHealth() {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch(`${publicOrigin}/health`, {
        headers: { connection: "close" },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"status":"ready"}');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

await verifyHealth();
const beforeRestart = await connect();
const created = await request(beforeRestart, "room:create", { name: "Persistence Host" });
assert.ok(created?.session, "Room creation did not return a session.");
const session = created.session;
assert.match(session.roomCode, /^[A-Z0-9]{6}$/);
beforeRestart.disconnect();

runCompose([
  "up",
  "--detach",
  "--force-recreate",
  "--wait",
  "--wait-timeout",
  "180",
  "postgres",
  "migration",
  "app",
]);

await verifyHealth();
const afterRestart = await connect();
try {
  const resumed = await request(afterRestart, "session:resume", { session });
  assert.deepEqual(resumed?.session, session);
  console.log(
    `Compose persistence check passed for room ${session.roomCode}; PostgreSQL, migrations, and the app were recreated with the named volume retained.`,
  );
} finally {
  afterRestart.disconnect();
}
