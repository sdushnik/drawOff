import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ClientToServerPayloads,
  ClientToServerResponses,
  PlayerView,
  ServiceErrorPayload,
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
  "state:update": (view: PlayerView) => void;
};

type TestSocket = ClientSocket<ServerEvents, ClientEvents>;
type Result<Event extends keyof ClientToServerPayloads> =
  | { ok: true; response: ClientToServerResponses[Event] }
  | { ok: false; error: ServiceErrorPayload };

function request<Event extends keyof ClientToServerPayloads>(
  socket: TestSocket,
  event: Event,
  payload: ClientToServerPayloads[Event],
): Promise<Result<Event>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}.`));
    }, 2_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
    };
    const onError = (error: ServiceErrorPayload) => {
      cleanup();
      resolve({ ok: false, error });
    };
    socket.once("error", onError);
    socket.emit(event, payload, (response) => {
      cleanup();
      resolve({ ok: true, response });
    });
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

function waitForView(
  socket: TestSocket,
  predicate: (view: PlayerView) => boolean,
): Promise<PlayerView> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("state:update", onView);
      reject(new Error("Timed out waiting for a personalized view."));
    }, 2_000);
    const onView = (view: PlayerView) => {
      if (!predicate(view)) return;
      clearTimeout(timer);
      socket.off("state:update", onView);
      resolve(view);
    };
    socket.on("state:update", onView);
  });
}

interface FakeTimer {
  callback: () => void;
  dueAt: number;
}

function createClock() {
  let now = 1_000;
  let nextId = 0;
  const timers = new Map<number, FakeTimer>();
  return {
    now: () => now,
    advanceTo(deadline: number) {
      now = deadline;
    },
    setTimer(callback: () => void, delayMs: number) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: now + delayMs });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      timers.delete(handle as unknown as number);
    },
    runNext() {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0] ?? [];
      assert.ok(timer);
      timers.delete(id!);
      now = Math.max(now, timer.dueAt);
      timer.callback();
    },
  };
}

test("live drawing ops are private, ordered, idempotent, and recover from a missed update", async () => {
  const clock = createClock();
  let playerSequence = 0;
  const roomService = new RoomService({
    now: clock.now,
    generateId: () => `player-${++playerSequence}`,
  });
  const { app, io } = createServer({
    logger: false,
    roomService,
    matchStateMachineOptions: {
      now: clock.now,
      random: () => 0,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const judgeSocket = await connect(address);
  const artistSocket = await connect(address);
  const otherArtistSocket = await connect(address);
  const otherRoomSocket = await connect(address);
  const sockets = [judgeSocket, artistSocket, otherArtistSocket, otherRoomSocket];
  const received = new Map(sockets.map((socket) => [socket, 0]));
  sockets.forEach((socket) => socket.on("state:update", () => received.set(socket, received.get(socket)! + 1)));

  try {
    const created = await request(judgeSocket, "room:create", { name: "Judge Name" });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("Could not create the drawing test room.");
    const judge = created.response.session;
    const joinedArtist = await request(artistSocket, "room:join", {
      code: judge.roomCode,
      name: "Artist One",
    });
    const joinedOtherArtist = await request(otherArtistSocket, "room:join", {
      code: judge.roomCode,
      name: "Artist Two",
    });
    const otherRoom = await request(otherRoomSocket, "room:create", { name: "Other Room" });
    assert.equal(joinedArtist.ok, true);
    assert.equal(joinedOtherArtist.ok, true);
    assert.equal(otherRoom.ok, true);
    if (!joinedArtist.ok || !joinedOtherArtist.ok || !otherRoom.ok) {
      throw new Error("Could not set up drawing test sessions.");
    }
    const artist = joinedArtist.response.session;
    const otherArtist = joinedOtherArtist.response.session;
    const otherRoomSession = otherRoom.response.session;

    const started = await request(judgeSocket, "match:start", { session: judge });
    assert.equal(started.ok, true);
    const outOfPhase = await request(artistSocket, "drawing:ops", {
      session: artist,
      ops: [{ type: "clear", id: "before-drawing" }],
    });
    assert.equal(outOfPhase.ok, false);
    if (!outOfPhase.ok) assert.equal(outOfPhase.error.code, "WRONG_PHASE");

    clock.runNext();
    assert.equal(
      (await request(judgeSocket, "prompt:select", { session: judge, prompt: "lighthouse" })).ok,
      true,
    );

    const judgeAttempt = await request(judgeSocket, "drawing:ops", {
      session: judge,
      ops: [{ type: "clear", id: "judge-clear" }],
    });
    assert.equal(judgeAttempt.ok, false);
    if (!judgeAttempt.ok) assert.equal(judgeAttempt.error.code, "FORBIDDEN");

    const spoofedSession = await request(artistSocket, "drawing:ops", {
      session: otherArtist,
      ops: [{ type: "clear", id: "spoofed-artist" }],
    });
    assert.equal(spoofedSession.ok, false);
    if (!spoofedSession.ok) assert.equal(spoofedSession.error.code, "UNAUTHORIZED");
    const spoofedRoom = await request(artistSocket, "drawing:ops", {
      session: { ...artist, roomCode: otherRoomSession.roomCode },
      ops: [{ type: "clear", id: "spoofed-room" }],
    });
    assert.equal(spoofedRoom.ok, false);
    if (!spoofedRoom.ok) assert.equal(spoofedRoom.error.code, "UNAUTHORIZED");

    const malformed = await request(artistSocket, "drawing:ops", {
      session: artist,
      ops: [{ type: "clear", id: "malformed", recipientId: "player-1" }],
    } as unknown as ClientToServerPayloads["drawing:ops"]);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.code, "INVALID_INPUT");

    const receivedBefore = new Map(received);
    const judgeSnapshot = waitForView(
      judgeSocket,
      (view) => view.liveCanvases?.some((canvas) => canvas.sequence === 4) ?? false,
    );
    const artistSnapshot = waitForView(
      artistSocket,
      (view) => view.myCanvas?.canvas.rev === 4,
    );
    const committed = await request(artistSocket, "drawing:ops", {
      session: artist,
      ops: [
        {
          type: "stroke",
          id: "stroke-1",
          tool: "pen",
          color: "#e5484d",
          size: 8,
          points: [10, 10, 30, 40],
        },
        { type: "fill", id: "fill-1", x: 300, y: 200, color: "#0090ff" },
        { type: "clear", id: "clear-1" },
        { type: "undo", id: "undo-1" },
      ],
    });
    assert.equal(committed.ok, true);

    const [judgeView, artistView] = await Promise.all([judgeSnapshot, artistSnapshot]);
    const liveCanvas = judgeView.liveCanvases?.find((canvas) => canvas.sequence === 4)!;
    assert.equal(liveCanvas.label, "Artist 1");
    assert.deepEqual(liveCanvas.canvas.actions.map(({ type }) => type), ["stroke", "fill"]);
    assert.equal(liveCanvas.canvas.rev, 4);
    assert.equal(liveCanvas.canvas.resets, 1);
    assert.equal(artistView.liveCanvases, null);
    assert.equal(artistView.myCanvas?.canvas.actions.length, 2);
    assert.equal(JSON.stringify(judgeView.liveCanvases).includes(artist.playerId), false);
    assert.equal(JSON.stringify(judgeView.liveCanvases).includes("Artist One"), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(received.get(otherArtistSocket), receivedBefore.get(otherArtistSocket));
    assert.equal(received.get(otherRoomSocket), receivedBefore.get(otherRoomSocket));

    const beforeDuplicate = received.get(judgeSocket);
    assert.equal(
      (
        await request(artistSocket, "drawing:ops", {
          session: artist,
          ops: [{ type: "clear", id: "clear-1" }],
        })
      ).ok,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(received.get(judgeSocket), beforeDuplicate);
    assert.equal(received.get(otherArtistSocket), receivedBefore.get(otherArtistSocket));

    const beforeConflict = received.get(judgeSocket);
    const conflictingId = await request(artistSocket, "drawing:ops", {
      session: artist,
      ops: [{ type: "fill", id: "clear-1", x: 1, y: 2, color: "#000000" }],
    });
    assert.equal(conflictingId.ok, false);
    if (!conflictingId.ok) assert.equal(conflictingId.error.code, "INVALID_INPUT");
    assert.equal(received.get(judgeSocket), beforeConflict);

    const lockedView = waitForView(
      judgeSocket,
      (view) => view.liveCanvases?.find(({ label }) => label === "Artist 1")?.locked === true,
    );
    assert.equal((await request(artistSocket, "drawing:submit", { session: artist })).ok, true);
    assert.equal((await lockedView).liveCanvases?.[0]?.sequence, 5);
    const afterLock = await request(artistSocket, "drawing:ops", {
      session: artist,
      ops: [{ type: "clear", id: "after-lock" }],
    });
    assert.equal(afterLock.ok, false);
    if (!afterLock.ok) assert.equal(afterLock.error.code, "FORBIDDEN");
    const duplicateSubmit = await request(artistSocket, "drawing:submit", { session: artist });
    assert.equal(duplicateSubmit.ok, false);

    judgeSocket.disconnect();
    const artistTwoSnapshot = waitForView(
      otherArtistSocket,
      (view) => view.phase === "DRAWING" && view.myCanvas?.canvas.rev === 1,
    );
    const secondArtistCommit = await request(otherArtistSocket, "drawing:ops", {
      session: otherArtist,
      ops: [{ type: "clear", id: "second-artist-clear" }],
    });
    assert.equal(secondArtistCommit.ok, true);
    await artistTwoSnapshot;
    const reconnectingJudge = await connect(address);
    sockets.push(reconnectingJudge);
    const recovered = waitForView(
      reconnectingJudge,
      (view) =>
        view.role === "judge" &&
        (view.liveCanvases?.some((canvas) => canvas.sequence === 5) ?? false) &&
        (view.liveCanvases?.some((canvas) => canvas.sequence === 1) ?? false),
    );
    assert.equal((await request(reconnectingJudge, "session:resume", { session: judge })).ok, true);
    assert.equal((await recovered).liveCanvases?.[0]?.canvas.rev, 4);

    const deadline = judgeView.deadline!;
    clock.advanceTo(deadline);
    const atDeadline = await request(otherArtistSocket, "drawing:ops", {
      session: otherArtist,
      ops: [{ type: "clear", id: "at-deadline" }],
    });
    assert.equal(atDeadline.ok, false);
    if (!atDeadline.ok) assert.equal(atDeadline.error.code, "DEADLINE_PASSED");

    const otherRoomView = await request(otherRoomSocket, "state:subscribe", {
      session: otherRoomSession,
    });
    assert.equal(otherRoomView.ok, true);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
