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

test("Socket.IO ratings finalize atomically, reveal results to everyone, and retry idempotently", async () => {
  const clock = createClock();
  let nextPlayerId = 0;
  const roomService = new RoomService({
    now: clock.now,
    generateId: () => `player-${++nextPlayerId}`,
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
  const sockets = await Promise.all(Array.from({ length: 4 }, () => connect(address)));
  const latestViews = new Map<TestSocket, PlayerView>();
  sockets.forEach((socket) => socket.on("state:update", (view) => latestViews.set(socket, view)));

  const waitForView = (socket: TestSocket, predicate: (view: PlayerView) => boolean) => {
    const current = latestViews.get(socket);
    if (current && predicate(current)) return Promise.resolve(current);
    return new Promise<PlayerView>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("state:update", onView);
        reject(new Error("Timed out waiting for a personalized view."));
      }, 2_000);
      const onView = (view: PlayerView) => {
        latestViews.set(socket, view);
        if (!predicate(view)) return;
        clearTimeout(timer);
        socket.off("state:update", onView);
        resolve(view);
      };
      socket.on("state:update", onView);
    });
  };

  try {
    const created = await request(sockets[0]!, "room:create", { name: "Judge Name" });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("Could not create the ratings test room.");
    const judge = created.response.session;
    const sessions = [judge];
    for (let index = 1; index < sockets.length; index += 1) {
      const joined = await request(sockets[index]!, "room:join", {
        code: judge.roomCode,
        name: `Artist ${index}`,
      });
      assert.equal(joined.ok, true);
      if (!joined.ok) throw new Error("Could not join the ratings test room.");
      sessions.push(joined.response.session);
    }

    const roleRevealViews = sockets.map((socket) => waitForView(socket, (view) => view.phase === "ROLE_REVEAL"));
    assert.equal((await request(sockets[0]!, "match:start", { session: judge })).ok, true);
    await Promise.all(roleRevealViews);
    const wordSelectionViews = sockets.map((socket) =>
      waitForView(socket, (view) => view.phase === "WORD_SELECTION"),
    );
    clock.runNext();
    await Promise.all(wordSelectionViews);

    const drawingViews = sockets.map((socket) => waitForView(socket, (view) => view.phase === "DRAWING"));
    assert.equal(
      (await request(sockets[0]!, "prompt:select", { session: judge, prompt: "lighthouse" })).ok,
      true,
    );
    await Promise.all(drawingViews);
    const judgingViews = sockets.map((socket) => waitForView(socket, (view) => view.phase === "JUDGING"));
    clock.runNext();
    const beforeViews = await Promise.all(judgingViews);
    const judgeView = beforeViews[0]!;
    const labels = judgeView.gallery?.map(({ label }) => label);
    assert.deepEqual(labels, ["Drawing 1", "Drawing 2", "Drawing 3"]);
    assert.deepEqual(judgeView.liveCanvases?.map(({ label }) => label), labels);
    for (const view of beforeViews) {
      assert.equal(view.phase, "JUDGING");
      assert.equal(view.roundResult, null);
      assert.deepEqual(Object.values(view.match!.scores), [0, 0, 0, 0]);
    }
    const anonymousJudgeView = JSON.stringify(judgeView);
    for (const session of sessions.slice(1)) {
      assert.equal(anonymousJudgeView.includes(session.playerId), false);
    }
    for (let index = 1; index < sockets.length; index += 1) {
      assert.equal(anonymousJudgeView.includes(`Artist ${index}`), false);
      assert.equal(latestViews.get(sockets[index]!)!.gallery, null);
      assert.equal(latestViews.get(sockets[index]!)!.liveCanvases, null);
    }

    const assertInvalidRatings = async (ratings: unknown) => {
      const result = await request(sockets[0]!, "ratings:submit", {
        session: judge,
        ratings,
      } as ClientToServerPayloads["ratings:submit"]);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
      for (const socket of sockets) {
        assert.equal(latestViews.get(socket)?.phase, "JUDGING");
        assert.equal(latestViews.get(socket)?.roundResult, null);
      }
    };
    await assertInvalidRatings({ "Drawing 1": 10, "Drawing 2": 20 });
    await assertInvalidRatings({
      "Drawing 1": 10,
      "Drawing 2": 20,
      "Drawing 3": 30,
      extra: 40,
    });
    await assertInvalidRatings({ "Drawing 1": 10, "Drawing 2": 20.5, "Drawing 3": 30 });
    await assertInvalidRatings({ "Drawing 1": 10, "Drawing 2": -1, "Drawing 3": 30 });
    await assertInvalidRatings({ "Drawing 1": 10, "Drawing 2": 101, "Drawing 3": 30 });

    const clientAwards = await request(sockets[0]!, "ratings:submit", {
      session: judge,
      ratings: { "Drawing 1": 10, "Drawing 2": 20, "Drawing 3": 30 },
      awards: { [sessions[1]!.playerId]: 999 },
    } as ClientToServerPayloads["ratings:submit"]);
    assert.equal(clientAwards.ok, false);
    if (!clientAwards.ok) assert.equal(clientAwards.error.code, "INVALID_INPUT");
    assert.equal(latestViews.get(sockets[0]!)?.phase, "JUDGING");

    const unauthorized = await request(sockets[1]!, "ratings:submit", {
      session: sessions[1]!,
      ratings: { "Drawing 1": 0, "Drawing 2": 100, "Drawing 3": 100 },
    });
    assert.equal(unauthorized.ok, false);
    if (!unauthorized.ok) assert.equal(unauthorized.error.code, "FORBIDDEN");
    assert.equal(latestViews.get(sockets[0]!)?.phase, "JUDGING");

    const submittedRatings = { "Drawing 1": 0, "Drawing 2": 100, "Drawing 3": 100 };
    const resultViews = sockets.map((socket) => waitForView(socket, (view) => view.phase === "ROUND_RESULT"));
    const submitted = await request(sockets[0]!, "ratings:submit", {
      session: judge,
      ratings: submittedRatings,
    });
    assert.equal(submitted.ok, true);
    const firstResults = await Promise.all(resultViews);
    const firstResult = firstResults[0]!.roundResult!;
    assert.equal(firstResult.entries[0]!.rating, 0);
    assert.equal(firstResult.entries[1]!.rating, 100);
    assert.equal(firstResult.entries[2]!.rating, 100);
    assert.deepEqual(
      firstResult.winners,
      firstResult.entries.slice(1).map(({ artistId }) => artistId),
    );
    for (const view of firstResults) {
      assert.deepEqual(view.roundResult, firstResult);
      assert.deepEqual(view.roundResult?.entries.map(({ label }) => label), labels);
      assert.deepEqual(view.roundResult?.entries.map(({ canvas }) => canvas), judgeView.gallery?.map(({ canvas }) => canvas));
    }
    const firstTotals = firstResults[0]!.match!.scores;
    assert.equal(firstTotals[judge.playerId], 0);
    assert.deepEqual(
      firstResult.entries.map(({ artistId, rating }) => firstTotals[artistId] === rating),
      [true, true, true],
    );

    assert.equal(
      (
        await request(sockets[0]!, "ratings:submit", {
          session: judge,
          ratings: submittedRatings,
        })
      ).ok,
      true,
    );
    const changedRetry = await request(sockets[0]!, "ratings:submit", {
      session: judge,
      ratings: { "Drawing 1": 1, "Drawing 2": 100, "Drawing 3": 100 },
    });
    assert.equal(changedRetry.ok, false);
    if (!changedRetry.ok) assert.equal(changedRetry.error.code, "WRONG_PHASE");
    for (const socket of sockets) {
      assert.deepEqual(latestViews.get(socket)?.roundResult, firstResult);
      assert.deepEqual(latestViews.get(socket)?.match?.scores, firstTotals);
    }

    const nextRoundViews = sockets.map((socket) =>
      waitForView(socket, (view) => view.phase === "ROLE_REVEAL" && view.match?.roundIndex === 1),
    );
    clock.runNext();
    await Promise.all(nextRoundViews);
    const nextWordViews = sockets.map((socket) => waitForView(socket, (view) => view.phase === "WORD_SELECTION"));
    clock.runNext();
    await Promise.all(nextWordViews);
    const nextJudgeSocket = sockets[1]!;
    const nextJudge = sessions[1]!;
    const nextDrawingViews = sockets.map((socket) => waitForView(socket, (view) => view.phase === "DRAWING"));
    assert.equal(
      (await request(nextJudgeSocket, "prompt:select", { session: nextJudge, prompt: "bluebird" })).ok,
      true,
    );
    await Promise.all(nextDrawingViews);
    const nextJudgingViews = sockets.map((socket) => waitForView(socket, (view) => view.phase === "JUDGING"));
    clock.runNext();
    await Promise.all(nextJudgingViews);
    const nextResultViews = sockets.map((socket) =>
      waitForView(socket, (view) => view.phase === "ROUND_RESULT" && view.match?.roundIndex === 1),
    );
    assert.equal(
      (
        await request(nextJudgeSocket, "ratings:submit", {
          session: nextJudge,
          ratings: { "Drawing 1": 10, "Drawing 2": 20, "Drawing 3": 30 },
        })
      ).ok,
      true,
    );
    const cumulativeViews = await Promise.all(nextResultViews);
    const cumulativeScores = cumulativeViews[0]!.match!.scores;
    assert.equal(cumulativeScores[judge.playerId], 10);
    assert.equal(cumulativeScores[nextJudge.playerId], 0);
    assert.equal(cumulativeScores[firstResult.entries[1]!.artistId], 120);
    assert.equal(cumulativeScores[firstResult.entries[2]!.artistId], 130);
    assert.ok(cumulativeViews.every((view) => view.roundResult?.entries.length === 3));
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
