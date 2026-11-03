import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ClientToServerPayloads,
  ClientToServerResponses,
  PlayerView,
  ServiceErrorPayload,
} from "@drawoff/contracts";
import { io as createSocketClient, type Socket as ClientSocket } from "socket.io-client";
import {
  DEFAULT_RESOURCE_LIMITS,
  FixedWindowRateLimiter,
  resourceLimitOptionsFromEnvironment,
  resolveResourceLimits,
} from "../src/resource-limits.js";
import { RoomService, RoomServiceError } from "../src/room-service.js";
import { createServer } from "../src/server.js";

type ClientEvents = {
  [Event in keyof ClientToServerPayloads]: (
    payload: ClientToServerPayloads[Event],
    acknowledge: (response: ClientToServerResponses[Event]) => void,
  ) => void;
};
type ServerEvents = {
  error: (payload: ServiceErrorPayload) => void;
  "state:update": (payload: PlayerView) => void;
};
type TestSocket = ClientSocket<ServerEvents, ClientEvents>;

async function connect(address: string): Promise<TestSocket> {
  const socket = createSocketClient(address, { autoConnect: false, reconnection: false }) as TestSocket;
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    socket.connect();
  });
  return socket;
}

function request<Event extends keyof ClientToServerPayloads>(
  socket: TestSocket,
  event: Event,
  payload: ClientToServerPayloads[Event],
): Promise<ClientToServerResponses[Event] | ServiceErrorPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}.`)), 2_000);
    const onError = (error: ServiceErrorPayload) => {
      clearTimeout(timer);
      resolve(error);
    };
    socket.once("error", onError);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(response);
    });
  });
}

test("resource defaults are configurable, positive, and do not define a player cap", () => {
  assert.equal(DEFAULT_RESOURCE_LIMITS.maxInboundMessageBytes, 512 * 1024);
  assert.equal(DEFAULT_RESOURCE_LIMITS.maxCanvasActionsPerRoom, 50_000);
  assert.equal("maxPlayers" in DEFAULT_RESOURCE_LIMITS, false);
  assert.deepEqual(resolveResourceLimits({ drawingPerSession: { max: 7 } }).drawingPerSession, {
    max: 7,
    windowMs: DEFAULT_RESOURCE_LIMITS.drawingPerSession.windowMs,
  });
  assert.throws(() => resolveResourceLimits({ maxInboundMessageBytes: 0 }), RangeError);
  assert.throws(
    () => resolveResourceLimits({ roomCodeGuessesPerCode: { windowMs: Number.NaN } }),
    RangeError,
  );
  assert.deepEqual(
    resourceLimitOptionsFromEnvironment({
      MAX_INBOUND_MESSAGE_BYTES: "4096",
      DRAWING_SESSION_RATE_MAX: "7",
      DRAWING_SESSION_RATE_WINDOW_MS: "250",
    }),
    {
      maxInboundMessageBytes: 4096,
      maxCanvasActionsPerRoom: undefined,
      roomCleanupIntervalMs: undefined,
      drawingPerSession: { max: 7, windowMs: 250 },
      drawingPerRoom: undefined,
      submissionsPerSession: undefined,
      submissionsPerRoom: undefined,
      roomCreatesPerConnection: undefined,
      roomCodeGuessesPerConnection: undefined,
      roomCodeGuessesPerCode: undefined,
    },
  );
  assert.throws(
    () => resourceLimitOptionsFromEnvironment({ MAX_INBOUND_MESSAGE_BYTES: "1.5" }),
    RangeError,
  );
});

test("fixed-window rate limits accept the exact boundary, reject explicitly, and recover", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter(() => now);
  const rule = { max: 2, windowMs: 100 };
  limiter.consume("drawing:p1", rule, "drawing events");
  limiter.consume("drawing:p1", rule, "drawing events");
  assert.throws(
    () => limiter.consume("drawing:p1", rule, "drawing events"),
    (error: unknown) =>
      error instanceof RoomServiceError &&
      error.code === "REQUEST_FAILED" &&
      /retry in 100 ms/.test(error.message),
  );
  now = 1_100;
  limiter.consume("drawing:p1", rule, "drawing events");
});

test("expired and abandoned rooms are proactively purged at the inclusive deadline", () => {
  let now = 1_000;
  const rooms = new RoomService({ idleTtlMs: 100, now: () => now });
  const session = rooms.createRoom("Host Player");
  now = 1_099;
  assert.equal(rooms.purgeExpiredRooms(), 0);
  assert.equal(rooms.getRoom(session.roomCode).code, session.roomCode);
  now = 1_100;
  assert.equal(rooms.purgeExpiredRooms(), 1);
  assert.throws(() => rooms.getRoom(session.roomCode), RoomServiceError);
});

test("Socket.IO applies the byte ceiling and room abuse limits before mutation", async () => {
  let now = 1_000;
  let nextCode = 0;
  const roomService = new RoomService({
    now: () => now,
    generateRoomCode: () => `AA000${nextCode++}`,
  });
  const { app, io } = createServer({
    logger: false,
    roomService,
    resourceLimits: {
      now: () => now,
      maxInboundMessageBytes: 4_096,
      roomCreatesPerConnection: { max: 1, windowMs: 100 },
      roomCodeGuessesPerConnection: { max: 2, windowMs: 100 },
      roomCodeGuessesPerCode: { max: 2, windowMs: 100 },
    },
  });
  assert.equal((io.engine as unknown as { opts: { maxHttpBufferSize: number } }).opts.maxHttpBufferSize, 4_096);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const creator = await connect(address);
  const guesser = await connect(address);
  const oversized = await connect(address);
  try {
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Oversized transport was not closed.")), 2_000);
      oversized.once("disconnect", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    oversized.emit("room:create", { name: "x".repeat(5_000) }, () => undefined);
    await disconnected;

    const created = await request(creator, "room:create", { name: "Host Player" });
    assert.ok("session" in created);
    const rejectedCreate = await request(creator, "room:create", { name: "Other Host" });
    assert.deepEqual(rejectedCreate, {
      code: "REQUEST_FAILED",
      message: "Rate limit exceeded for room creation; retry in 100 ms.",
    });

    for (const code of ["ZZZZZ1", "ZZZZZ2"]) {
      const result = await request(guesser, "room:join", { code, name: "Guess Player" });
      assert.equal("code" in result && result.code, "ROOM_NOT_FOUND");
    }
    const rejectedGuess = await request(guesser, "room:join", {
      code: "ZZZZZ3",
      name: "Guess Player",
    });
    assert.equal("message" in rejectedGuess && /Rate limit exceeded/.test(rejectedGuess.message), true);
    now = 1_100;
    const afterWindow = await request(guesser, "room:join", {
      code: "ZZZZZ3",
      name: "Guess Player",
    });
    assert.equal("code" in afterWindow && afterWindow.code, "ROOM_NOT_FOUND");
  } finally {
    creator.disconnect();
    guesser.disconnect();
    oversized.disconnect();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});

test("drawing and submission rates reject atomically per session and room, then recover", async () => {
  let now = 1_000;
  let nextPlayer = 0;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const roomService = new RoomService({
    now: () => now,
    generateId: () => `player-${++nextPlayer}`,
  });
  const { app, io } = createServer({
    logger: false,
    roomService,
    resourceLimits: {
      now: () => now,
      drawingPerSession: { max: 2, windowMs: 100 },
      drawingPerRoom: { max: 2, windowMs: 100 },
      submissionsPerSession: { max: 1, windowMs: 100 },
      submissionsPerRoom: { max: 10, windowMs: 100 },
    },
    matchStateMachineOptions: {
      now: () => now,
      random: () => 0,
      setTimer: (callback) => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => timers.delete(timer as unknown as number),
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const sockets = await Promise.all([connect(address), connect(address), connect(address)]);
  const [judgeSocket, firstArtistSocket, secondArtistSocket] = sockets as [TestSocket, TestSocket, TestSocket];
  let judgeUpdates = 0;
  judgeSocket.on("state:update", () => { judgeUpdates += 1; });
  try {
    const created = await request(judgeSocket, "room:create", { name: "Judge Player" });
    assert.ok("session" in created);
    if (!("session" in created)) throw new Error("Room creation failed.");
    const judge = created.session;
    const firstJoined = await request(firstArtistSocket, "room:join", {
      code: judge.roomCode,
      name: "First Artist",
    });
    const secondJoined = await request(secondArtistSocket, "room:join", {
      code: judge.roomCode,
      name: "Second Artist",
    });
    assert.ok("session" in firstJoined && "session" in secondJoined);
    if (!("session" in firstJoined) || !("session" in secondJoined)) {
      throw new Error("Room joins failed.");
    }
    const firstArtist = firstJoined.session;
    const secondArtist = secondJoined.session;
    assert.deepEqual(await request(judgeSocket, "match:start", { session: judge }), {});
    const firstTimer = [...timers.entries()][0];
    assert.ok(firstTimer);
    timers.delete(firstTimer[0]);
    now += 4_000;
    firstTimer[1]();
    assert.deepEqual(
      await request(judgeSocket, "prompt:select", { session: judge, prompt: "lighthouse" }),
      {},
    );

    const oversizedBatch = await request(firstArtistSocket, "drawing:ops", {
      session: firstArtist,
      ops: Array.from({ length: 61 }, (_, index) => ({ type: "clear", id: `batch-${index}` })),
    } as ClientToServerPayloads["drawing:ops"]);
    assert.equal("code" in oversizedBatch && oversizedBatch.code, "INVALID_INPUT");

    assert.deepEqual(
      await request(firstArtistSocket, "drawing:ops", {
        session: firstArtist,
        ops: [{ type: "clear", id: "first" }],
      }),
      {},
    );
    assert.deepEqual(
      await request(secondArtistSocket, "drawing:ops", {
        session: secondArtist,
        ops: [{ type: "clear", id: "second" }],
      }),
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updatesBeforeRejection = judgeUpdates;
    const rejected = await request(firstArtistSocket, "drawing:ops", {
      session: firstArtist,
      ops: [{ type: "clear", id: "room-over-limit" }],
    });
    assert.equal("code" in rejected && rejected.code, "REQUEST_FAILED");
    assert.equal("message" in rejected && /in this room/.test(rejected.message), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(judgeUpdates, updatesBeforeRejection, "rejected drawing was not relayed");

    now += 100;
    assert.deepEqual(
      await request(firstArtistSocket, "drawing:ops", {
        session: firstArtist,
        ops: [{ type: "clear", id: "after-window" }],
      }),
      {},
    );
    assert.deepEqual(await request(firstArtistSocket, "drawing:submit", { session: firstArtist }), {});
    const duplicateSubmit = await request(firstArtistSocket, "drawing:submit", { session: firstArtist });
    assert.equal("code" in duplicateSubmit && duplicateSubmit.code, "REQUEST_FAILED");
    assert.equal("message" in duplicateSubmit && /submissions/.test(duplicateSubmit.message), true);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
