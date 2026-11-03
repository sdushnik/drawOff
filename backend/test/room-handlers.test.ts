import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import {
  clientToServerPayloadSchemas,
  clientToServerResponseSchemas,
  serviceErrorPayloadSchema,
  type ClientToServerPayloads,
  type ClientToServerResponses,
  type ServiceErrorPayload,
} from "@drawoff/contracts";
import { io as createSocketClient, type Socket as ClientSocket } from "socket.io-client";
import { RoomService } from "../src/room-service.js";
import { createServer } from "../src/server.js";

type ClientEvents = {
  [Event in keyof ClientToServerPayloads]: (
    payload: ClientToServerPayloads[Event],
    acknowledge: (response: ClientToServerResponses[Event]) => void,
  ) => void;
};

type ServerEvents = {
  error: (payload: ServiceErrorPayload) => void;
};

type TestSocket = ClientSocket<ServerEvents, ClientEvents>;
type RequestResult<Event extends keyof ClientToServerPayloads> =
  | { ok: true; response: ClientToServerResponses[Event] }
  | { ok: false; error: ServiceErrorPayload };

function request<Event extends keyof ClientToServerPayloads>(
  socket: TestSocket,
  event: Event,
  payload: ClientToServerPayloads[Event],
): Promise<RequestResult<Event>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}.`));
    }, 2_000);
    const onError = (error: ServiceErrorPayload) => {
      cleanup();
      resolve({ ok: false, error });
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
    };

    socket.once("error", onError);
    const acknowledge = (response: ClientToServerResponses[Event]) => {
      cleanup();
      resolve({ ok: true, response });
    };
    const args = [payload, acknowledge] as Parameters<ClientEvents[Event]>;
    socket.emit(event, ...args);
  });
}

async function connect(address: string): Promise<TestSocket> {
  const socket = createSocketClient(address, {
    autoConnect: false,
    reconnection: false,
  }) as TestSocket;
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    socket.connect();
  });
  return socket;
}

test("room create, join, and resume requests return and authenticate room-scoped sessions", async () => {
  const service = new RoomService();
  const { app, io } = createServer({ logger: false, roomService: service });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const hostSocket = await connect(address);
  const guestSocket = await connect(address);
  const otherRoomSocket = await connect(address);

  try {
    const created = await request(hostSocket, "room:create", { name: "Host" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.deepEqual(
      clientToServerResponseSchemas["room:create"].parse(created.response),
      created.response,
    );
    const host = created.response.session;

    const joined = await request(guestSocket, "room:join", {
      code: host.roomCode.toLowerCase(),
      name: "Guest",
    });
    assert.equal(joined.ok, true);
    if (!joined.ok) return;
    assert.deepEqual(
      clientToServerResponseSchemas["room:join"].parse(joined.response),
      joined.response,
    );
    const guest = joined.response.session;

    const resumed = await request(guestSocket, "session:resume", { session: guest });
    assert.deepEqual(resumed, { ok: true, response: { session: guest } });

    const secondRoom = await request(otherRoomSocket, "room:create", { name: "Other Host" });
    assert.equal(secondRoom.ok, true);
    if (!secondRoom.ok) return;

    const wrongRoom = await request(guestSocket, "session:resume", {
      session: { ...guest, roomCode: secondRoom.response.session.roomCode },
    });
    assert.deepEqual(wrongRoom, {
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Your session is no longer valid. Rejoin the room.",
      },
    });

    const forgedPlayer = await request(guestSocket, "session:resume", {
      session: { ...guest, playerId: host.playerId },
    });
    assert.equal(forgedPlayer.ok, false);
    if (!forgedPlayer.ok) {
      assert.equal(serviceErrorPayloadSchema.safeParse(forgedPlayer.error).success, true);
      assert.equal(forgedPlayer.error.code, "UNAUTHORIZED");
    }

    const invalidToken = "raw-invalid-session-token";
    const rejectedToken = await request(guestSocket, "session:resume", {
      session: { ...guest, token: invalidToken },
    });
    assert.equal(rejectedToken.ok, false);
    if (!rejectedToken.ok) {
      assert.equal(rejectedToken.error.code, "UNAUTHORIZED");
      assert.equal(JSON.stringify(rejectedToken.error).includes(invalidToken), false);
    }

    let now = 10;
    const expiredRoomService = new RoomService({
      idleTtlMs: 1,
      now: () => now,
    });
    const expiringSession = expiredRoomService.createRoom("Expiry Host");
    now = 11;
    const { app: expiryApp, io: expiryIo } = createServer({
      logger: false,
      roomService: expiredRoomService,
    });
    const expiryAddress = await expiryApp.listen({ host: "127.0.0.1", port: 0 });
    const expirySocket = await connect(expiryAddress);
    try {
      const expired = await request(expirySocket, "session:resume", {
        session: expiringSession,
      });
      assert.equal(expired.ok, false);
      if (!expired.ok) assert.equal(expired.error.code, "ROOM_NOT_FOUND");
    } finally {
      expirySocket.disconnect();
      await new Promise<void>((resolve) => expiryIo.close(() => resolve()));
    }
  } finally {
    hostSocket.disconnect();
    guestSocket.disconnect();
    otherRoomSocket.disconnect();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});

test("leave and kick requests require valid sessions and revoke the removed player's token", async () => {
  const service = new RoomService();
  const { app, io } = createServer({ logger: false, roomService: service });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const hostSocket = await connect(address);
  const guestSocket = await connect(address);

  try {
    const hostResult = await request(hostSocket, "room:create", { name: "Host" });
    assert.equal(hostResult.ok, true);
    if (!hostResult.ok) return;
    const host = hostResult.response.session;

    const guestResult = await request(guestSocket, "room:join", {
      code: host.roomCode,
      name: "Guest",
    });
    assert.equal(guestResult.ok, true);
    if (!guestResult.ok) return;
    const guest = guestResult.response.session;

    const forgedKick = await request(hostSocket, "player:kick", {
      session: { ...host, token: "forged-token" },
      playerId: guest.playerId,
    });
    assert.equal(forgedKick.ok, false);
    if (!forgedKick.ok) assert.equal(forgedKick.error.code, "UNAUTHORIZED");
    assert.deepEqual(await request(guestSocket, "session:resume", { session: guest }), {
      ok: true,
      response: { session: guest },
    });

    const forbiddenKick = await request(guestSocket, "player:kick", {
      session: guest,
      playerId: host.playerId,
    });
    assert.equal(forbiddenKick.ok, false);
    if (!forbiddenKick.ok) assert.equal(forbiddenKick.error.code, "FORBIDDEN");

    assert.deepEqual(
      await request(hostSocket, "player:kick", {
        session: host,
        playerId: guest.playerId,
      }),
      { ok: true, response: {} },
    );
    const revoked = await request(guestSocket, "session:resume", { session: guest });
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.error.code, "UNAUTHORIZED");

    assert.deepEqual(await request(hostSocket, "room:leave", { session: host }), {
      ok: true,
      response: {},
    });
    const departed = await request(hostSocket, "session:resume", { session: host });
    assert.equal(departed.ok, false);
    if (!departed.ok) assert.equal(departed.error.code, "ROOM_NOT_FOUND");
  } finally {
    hostSocket.disconnect();
    guestSocket.disconnect();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});

test("raw tokens are only returned to the requester and absent from state, errors, and logs", async () => {
  let logOutput = "";
  const logStream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      logOutput += chunk.toString();
      callback();
    },
  });
  const service = new RoomService();
  const { app, io } = createServer({
    logger: { level: "trace", stream: logStream },
    roomService: service,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const ownerSocket = await connect(address);
  const guestSocket = await connect(address);
  const observerSocket = await connect(address);
  const eventsOnObserverSocket: Array<{ event: string; args: unknown[] }> = [];
  observerSocket.onAny((event, ...args) => eventsOnObserverSocket.push({ event, args }));

  try {
    const created = await request(ownerSocket, "room:create", { name: "Owner" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const host = created.response.session;
    assert.equal(
      clientToServerPayloadSchemas["session:resume"].safeParse({ session: host }).success,
      true,
    );

    const joined = await request(guestSocket, "room:join", {
      code: host.roomCode,
      name: "Guest",
    });
    assert.equal(joined.ok, true);
    if (!joined.ok) return;
    const guest = joined.response.session;
    assert.notEqual(guest.token, host.token);

    const snapshot = JSON.stringify(service.getRoom(host.roomCode));
    assert.equal(snapshot.includes(host.token), false);
    assert.equal(snapshot.includes(guest.token), false);
    assert.deepEqual(eventsOnObserverSocket, []);

    const rejectedToken = "never-log-or-echo-this-token";
    const rejected = await request(ownerSocket, "session:resume", {
      session: { ...guest, token: rejectedToken },
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(JSON.stringify(rejected.error).includes(rejectedToken), false);
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(logOutput.includes(host.token), false);
    assert.equal(logOutput.includes(guest.token), false);
    assert.equal(logOutput.includes(rejectedToken), false);
  } finally {
    ownerSocket.disconnect();
    guestSocket.disconnect();
    observerSocket.disconnect();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
