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
type RequestResult<Event extends keyof ClientToServerPayloads> =
  | { ok: true; response: ClientToServerResponses[Event] }
  | { ok: false; error: ServiceErrorPayload };

interface FakeTimer {
  callback: () => void;
  dueAt: number;
}

function createClock() {
  let now = 1_000;
  let nextId = 0;
  const active = new Map<number, FakeTimer>();
  const history = new Map<number, FakeTimer>();
  const setTimer = (callback: () => void, delayMs: number) => {
    const id = ++nextId;
    const timer = { callback, dueAt: now + delayMs };
    active.set(id, timer);
    history.set(id, timer);
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
    active.delete(handle as unknown as number);
  };

  return {
    now: () => now,
    advanceTo(deadline: number) {
      now = deadline;
    },
    setTimer,
    clearTimer,
    runNext() {
      const [id, timer] = [...active.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0] ?? [];
      assert.ok(timer, "an active server timer exists");
      active.delete(id!);
      now = Math.max(now, timer.dueAt);
      timer.callback();
      return id!;
    },
    runHistorical(id: number) {
      const timer = history.get(id);
      assert.ok(timer, "the historical server timer exists");
      timer.callback();
    },
  };
}

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
    socket.emit(event, payload, (response: ClientToServerResponses[Event]) => {
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

async function openThreePlayerMatch() {
  const clock = createClock();
  let nextPlayer = 0;
  const roomService = new RoomService({
    now: clock.now,
    generateId: () => `player-${++nextPlayer}`,
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
  const sockets = await Promise.all([connect(address), connect(address), connect(address)]);
  const created = await request(sockets[0]!, "room:create", { name: "Judge" });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("Could not create the integration test room.");
  const judge = created.response.session;
  const joinedArtist = await request(sockets[1]!, "room:join", {
    code: judge.roomCode,
    name: "Artist One",
  });
  const joinedArtistTwo = await request(sockets[2]!, "room:join", {
    code: judge.roomCode,
    name: "Artist Two",
  });
  assert.equal(joinedArtist.ok, true);
  assert.equal(joinedArtistTwo.ok, true);
  if (!joinedArtist.ok || !joinedArtistTwo.ok) {
    throw new Error("Could not join the integration test room.");
  }
  return {
    app,
    io,
    address,
    clock,
    sockets,
    sessions: [judge, joinedArtist.response.session, joinedArtistTwo.response.session] as const,
  };
}

async function closeServer(
  sockets: readonly TestSocket[],
  io: ReturnType<typeof createServer>["io"],
) {
  sockets.forEach((socket) => socket.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
}

test("Socket.IO prompt requests enforce privacy, authorization, normalization, and reconnect consistency", async () => {
  const fixture = await openThreePlayerMatch();
  const [judgeSocket, artistSocket, otherArtistSocket] = fixture.sockets;
  const [judge, artist, otherArtist] = fixture.sessions;

  try {
    assert.deepEqual(await request(judgeSocket!, "match:start", { session: judge }), {
      ok: true,
      response: {},
    });
    const selectionViews = [
      waitForView(judgeSocket!, (view) => view.phase === "WORD_SELECTION"),
      waitForView(artistSocket!, (view) => view.phase === "WORD_SELECTION"),
      waitForView(otherArtistSocket!, (view) => view.phase === "WORD_SELECTION"),
    ];
    fixture.clock.runNext();
    const [judgeSelection, artistSelection, otherArtistSelection] =
      await Promise.all(selectionViews);
    const suggestions = judgeSelection.suggestions;
    assert.equal(suggestions?.length, 3);
    assert.equal(new Set(suggestions).size, 3);
    assert.equal(judgeSelection.role, "judge");
    assert.equal(judgeSelection.prompt, null);
    for (const view of [artistSelection, otherArtistSelection]) {
      assert.equal(view.role, "artist");
      assert.equal(view.suggestions, null);
      assert.equal(view.prompt, null);
    }

    const malformed = await request(judgeSocket!, "prompt:select", {
      session: judge,
      prompt: "<unsafe>",
    });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.code, "INVALID_INPUT");

    const unauthorized = await request(artistSocket!, "prompt:select", {
      session: artist,
      prompt: suggestions![0]!,
    });
    assert.equal(unauthorized.ok, false);
    if (!unauthorized.ok) assert.equal(unauthorized.error.code, "FORBIDDEN");
    assert.equal(judgeSelection.phase, "WORD_SELECTION");
    assert.equal(judgeSelection.suggestions?.length, 3);

    const drawingViews = [
      waitForView(judgeSocket!, (view) => view.phase === "DRAWING"),
      waitForView(artistSocket!, (view) => view.phase === "DRAWING"),
      waitForView(otherArtistSocket!, (view) => view.phase === "DRAWING"),
    ];
    assert.deepEqual(
      await request(judgeSocket!, "prompt:select", {
        session: judge,
        prompt: "   forty \n  cats   together ",
      }),
      { ok: true, response: {} },
    );
    const drawings = await Promise.all(drawingViews);
    assert.deepEqual(drawings.map(({ prompt }) => prompt), [
      "forty cats together",
      "forty cats together",
      "forty cats together",
    ]);
    assert.ok(drawings.every(({ suggestions }) => suggestions === null));

    const latePhaseRequest = await request(judgeSocket!, "prompt:select", {
      session: judge,
      prompt: suggestions![0]!,
    });
    assert.equal(latePhaseRequest.ok, false);
    if (!latePhaseRequest.ok) assert.equal(latePhaseRequest.error.code, "WRONG_PHASE");

    const judgingViews = [
      waitForView(judgeSocket!, (view) => view.phase === "JUDGING"),
      waitForView(artistSocket!, (view) => view.phase === "JUDGING"),
      waitForView(otherArtistSocket!, (view) => view.phase === "JUDGING"),
    ];
    fixture.clock.runNext();
    const judging = await Promise.all(judgingViews);
    assert.ok(judging.every((view) => view.prompt === "forty cats together"));

    judgeSocket!.disconnect();
    const resumedSocket = await connect(fixture.address);
    fixture.sockets.push(resumedSocket);
    const resumedView = waitForView(resumedSocket, (view) => view.phase === "JUDGING");
    await request(resumedSocket, "session:resume", { session: judge });
    assert.equal((await resumedView).prompt, "forty cats together");
    resumedSocket.disconnect();
  } finally {
    await closeServer(fixture.sockets, fixture.io);
  }
});

test("Socket.IO selection timeout publishes one already-shown suggestion to every player exactly once", async () => {
  const fixture = await openThreePlayerMatch();
  const [judgeSocket, artistSocket, otherArtistSocket] = fixture.sockets;
  const [judge] = fixture.sessions;
  const seen: PlayerView[][] = [[], [], []];
  fixture.sockets.forEach((socket, index) =>
    socket.on("state:update", (view) => seen[index]!.push(view)),
  );

  try {
    await request(judgeSocket!, "match:start", { session: judge });
    const selectionViews = [
      waitForView(judgeSocket!, (view) => view.phase === "WORD_SELECTION"),
      waitForView(artistSocket!, (view) => view.phase === "WORD_SELECTION"),
      waitForView(otherArtistSocket!, (view) => view.phase === "WORD_SELECTION"),
    ];
    fixture.clock.runNext();
    const [judgeSelection] = await Promise.all(selectionViews);
    const suggestions = judgeSelection.suggestions!;
    const before = seen.map((views) => views.length);

    const drawingViews = [
      waitForView(judgeSocket!, (view) => view.phase === "DRAWING"),
      waitForView(artistSocket!, (view) => view.phase === "DRAWING"),
      waitForView(otherArtistSocket!, (view) => view.phase === "DRAWING"),
    ];
    const selectionTimerId = fixture.clock.runNext();
    const drawings = await Promise.all(drawingViews);
    assert.ok(suggestions.includes(drawings[0]!.prompt!));
    assert.deepEqual(
      drawings.map(({ prompt }) => prompt),
      [drawings[0]!.prompt, drawings[0]!.prompt, drawings[0]!.prompt],
    );

    const countsAfterFallback = seen.map((views) => views.length);
    fixture.clock.runHistorical(selectionTimerId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.map((views) => views.length), countsAfterFallback);
    assert.ok(countsAfterFallback.every((count, index) => count === before[index]! + 1));
  } finally {
    await closeServer(fixture.sockets, fixture.io);
  }
});

test("a late Socket.IO prompt request is rejected without overriding the timeout fallback", async () => {
  const fixture = await openThreePlayerMatch();
  const [judgeSocket, artistSocket, otherArtistSocket] = fixture.sockets;
  const [judge] = fixture.sessions;
  const updateCounts = [0, 0, 0];
  fixture.sockets.forEach((socket, index) =>
    socket.on("state:update", () => {
      updateCounts[index] += 1;
    }),
  );

  try {
    await request(judgeSocket!, "match:start", { session: judge });
    const selectionViews = [
      waitForView(judgeSocket!, (view) => view.phase === "WORD_SELECTION"),
      waitForView(artistSocket!, (view) => view.phase === "WORD_SELECTION"),
      waitForView(otherArtistSocket!, (view) => view.phase === "WORD_SELECTION"),
    ];
    fixture.clock.runNext();
    const [judgeSelection] = await Promise.all(selectionViews);
    const selectionDeadline = judgeSelection.deadline!;
    const suggestions = judgeSelection.suggestions!;
    const before = [...updateCounts];

    fixture.clock.advanceTo(selectionDeadline);
    const lateRequest = await request(judgeSocket!, "prompt:select", {
      session: judge,
      prompt: suggestions[0]!,
    });
    assert.equal(lateRequest.ok, false);
    if (!lateRequest.ok) assert.equal(lateRequest.error.code, "DEADLINE_PASSED");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(updateCounts, before);

    const drawingViews = [
      waitForView(judgeSocket!, (view) => view.phase === "DRAWING"),
      waitForView(artistSocket!, (view) => view.phase === "DRAWING"),
      waitForView(otherArtistSocket!, (view) => view.phase === "DRAWING"),
    ];
    fixture.clock.runNext();
    const drawings = await Promise.all(drawingViews);
    assert.ok(suggestions.includes(drawings[0]!.prompt!));
    assert.ok(drawings.every((view) => view.prompt === drawings[0]!.prompt));
  } finally {
    await closeServer(fixture.sockets, fixture.io);
  }
});
