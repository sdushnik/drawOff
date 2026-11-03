import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ClientToServerPayloads,
  ClientToServerResponses,
  PlayerView,
  ServiceErrorPayload,
  Session,
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

test("Socket.IO final standings and rematches are authoritative and preserve the room", async () => {
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
  const waitForViews = (predicate: (view: PlayerView) => boolean, targets = sockets) =>
    Promise.all(targets.map((socket) => waitForView(socket, predicate)));

  const sessions: Session[] = [];
  try {
    const created = await request(sockets[0]!, "room:create", { name: "Player 0" });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("Could not create the rematch test room.");
    sessions.push(created.response.session);

    for (let index = 1; index < sockets.length; index += 1) {
      const joined = await request(sockets[index]!, "room:join", {
        code: sessions[0]!.roomCode,
        name: `Player ${index}`,
      });
      assert.equal(joined.ok, true);
      if (!joined.ok) throw new Error("Could not join the rematch test room.");
      sessions.push(joined.response.session);
    }

    assert.equal(
      (
        await request(sockets[0]!, "match:set-cycles", {
          session: sessions[0]!,
          cycles: 2,
        })
      ).ok,
      true,
    );
    const firstMatchViews = waitForViews(
      (view) => view.phase === "ROLE_REVEAL" && view.match?.roundIndex === 0,
    );
    assert.equal((await request(sockets[0]!, "match:start", { session: sessions[0]! })).ok, true);
    await firstMatchViews;

    const earlyHostRequest = await request(sockets[0]!, "match:rematch", {
      session: sessions[0]!,
    });
    assert.equal(earlyHostRequest.ok, false);
    if (!earlyHostRequest.ok) assert.equal(earlyHostRequest.error.code, "WRONG_PHASE");
    const earlyGuestRequest = await request(sockets[1]!, "match:rematch", {
      session: sessions[1]!,
    });
    assert.equal(earlyGuestRequest.ok, false);
    if (!earlyGuestRequest.ok) assert.equal(earlyGuestRequest.error.code, "WRONG_PHASE");

    const driveMatch = async (
      players: Session[],
      rounds: number,
      ratingForArtist: (artistId: string) => number,
      drawOnFinalRound = false,
      rejectForgedScore = false,
    ) => {
      const targets = players.map((_, index) => sockets[index]!);
      for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
        const roleRevealViews = waitForViews(
          (view) => view.phase === "ROLE_REVEAL" && view.match?.roundIndex === roundIndex,
          targets,
        );
        await roleRevealViews;

        const wordViews = waitForViews(
          (view) => view.phase === "WORD_SELECTION" && view.match?.roundIndex === roundIndex,
          targets,
        );
        clock.runNext();
        await wordViews;

        const judgeIndex = roundIndex % players.length;
        const judge = players[judgeIndex]!;
        const drawingViews = waitForViews(
          (view) => view.phase === "DRAWING" && view.match?.roundIndex === roundIndex,
          targets,
        );
        const selected = await request(sockets[judgeIndex]!, "prompt:select", {
          session: judge,
          prompt: `round ${roundIndex + 1}`,
        });
        assert.equal(selected.ok, true);
        await drawingViews;

        const artistIds = players
          .map(({ playerId }) => playerId)
          .filter((playerId) => playerId !== judge.playerId);
        if (drawOnFinalRound && roundIndex === rounds - 1) {
          const artistIndex = players.findIndex(({ playerId }) => playerId === artistIds[0]);
          const drawing = await request(sockets[artistIndex]!, "drawing:ops", {
            session: players[artistIndex]!,
            ops: [
              {
                type: "stroke",
                id: "final-drawing",
                tool: "pen",
                color: "#111111",
                size: 3,
                points: [1, 1, 5, 5],
              },
            ],
          });
          assert.equal(drawing.ok, true);
        }

        const judgingViews = waitForViews(
          (view) => view.phase === "JUDGING" && view.match?.roundIndex === roundIndex,
          targets,
        );
        clock.runNext();
        await judgingViews;
        const ratings = Object.fromEntries(
          artistIds.map((artistId, index) => [
            `Drawing ${index + 1}`,
            ratingForArtist(artistId),
          ]),
        );

        if (rejectForgedScore && roundIndex === 0) {
          const forged = await request(sockets[judgeIndex]!, "ratings:submit", {
            session: judge,
            ratings,
            scores: { [artistIds[0]!]: 1_000_000 },
          } as ClientToServerPayloads["ratings:submit"]);
          assert.equal(forged.ok, false);
          if (!forged.ok) assert.equal(forged.error.code, "INVALID_INPUT");
          assert.equal(latestViews.get(sockets[judgeIndex]!)?.phase, "JUDGING");
        }

        const resultViews = waitForViews(
          (view) => view.phase === "ROUND_RESULT" && view.match?.roundIndex === roundIndex,
          targets,
        );
        const submitted = await request(sockets[judgeIndex]!, "ratings:submit", {
          session: judge,
          ratings,
        });
        assert.equal(submitted.ok, true);
        const roundResults = await resultViews;
        assert.ok(roundResults.every((view) => view.roundResult?.entries.length === players.length - 1));
        if (drawOnFinalRound && roundIndex === rounds - 1) {
          assert.ok(roundResults.some((view) =>
            view.roundResult?.entries.some((entry) => entry.canvas.actions.length > 0),
          ));
        }

        const nextPhase = roundIndex + 1 === rounds ? "FINAL_RESULT" : "ROLE_REVEAL";
        const nextRound = roundIndex + 1;
        const nextViews = waitForViews(
          (view) =>
            view.phase === nextPhase &&
            (nextPhase === "FINAL_RESULT" || view.match?.roundIndex === nextRound),
          targets,
        );
        clock.runNext();
        const result = await nextViews;
        if (nextPhase === "FINAL_RESULT") return result;
      }
      throw new Error("Match did not reach its final result.");
    };

    const tieResultViews = await driveMatch(
      sessions,
      8,
      (playerId) => (playerId === sessions[3]!.playerId ? 0 : 100),
      true,
      true,
    );
    const tieResult = tieResultViews[0]!.finalResult!;
    assert.deepEqual(tieResult, {
      winners: sessions.slice(0, 3).map(({ playerId }) => playerId),
      standings: [
        ...sessions.slice(0, 3).map(({ playerId }) => ({ playerId, score: 600 })),
        { playerId: sessions[3]!.playerId, score: 0 },
      ],
      rounds: 8,
      cycles: 2,
    });
    assert.ok(tieResultViews.every((view) => view.finalResult?.rounds === 8));

    const nonHostRequest = await request(sockets[1]!, "match:rematch", {
      session: sessions[1]!,
    });
    assert.equal(nonHostRequest.ok, false);
    if (!nonHostRequest.ok) assert.equal(nonHostRequest.error.code, "FORBIDDEN");
    assert.ok(tieResultViews.every((view) => view.phase === "FINAL_RESULT"));

    const roomCode = sessions[0]!.roomCode;
    sockets[3]!.disconnect();
    await waitForViews(
      (view) => view.phase === "FINAL_RESULT" && view.players[3]?.connected === false,
      sockets.slice(0, 3),
    );
    sockets[3] = await connect(address);
    sockets[3]!.on("state:update", (view) => latestViews.set(sockets[3]!, view));
    const resumed = await request(sockets[3]!, "session:resume", { session: sessions[3]! });
    assert.equal(resumed.ok, true);
    await waitForViews((view) => view.phase === "FINAL_RESULT");

    const cleanLobbyViews = waitForViews((view) => view.phase === "LOBBY");
    const rematch = await request(sockets[0]!, "match:rematch", { session: sessions[0]! });
    assert.equal(rematch.ok, true);
    const lobbyViews = await cleanLobbyViews;
    for (const [index, view] of lobbyViews.entries()) {
      assert.equal(view.roomCode, roomCode);
      assert.equal(view.matchStarted, false);
      assert.equal(view.match, null);
      assert.equal(view.phase, "LOBBY");
      assert.equal(view.roundResult, null);
      assert.equal(view.finalResult, null);
      assert.equal(view.prompt, null);
      assert.equal(view.myCanvas, null);
      assert.equal(view.gallery, null);
      assert.equal(view.liveCanvases, null);
      assert.equal(view.suggestions, null);
      assert.equal(view.cycles, 2);
      assert.equal(view.me.id, sessions[index]!.playerId);
      assert.deepEqual(
        view.players.map(({ id }) => id),
        sessions.map(({ playerId }) => playerId),
      );
      assert.deepEqual(
        view.players.map(({ name }) => name),
        sessions.map((_, index) => `Player ${index}`),
      );
    }
    assert.equal(roomService.getRoom(roomCode).matchInProgress, false);
    assert.equal(roomService.getRoom(roomCode).matchSchedule, null);

    sockets[3]!.disconnect();
    await waitForViews(
      (view) => view.phase === "LOBBY" && view.players[3]?.connected === false,
      sockets.slice(0, 3),
    );
    const nextMatchViews = waitForViews(
      (view) => view.phase === "ROLE_REVEAL" && view.match?.roundIndex === 0,
      sockets.slice(0, 3),
    );
    const nextStart = await request(sockets[0]!, "match:start", { session: sessions[0]! });
    assert.equal(nextStart.ok, true);
    const frozenViews = await nextMatchViews;
    for (const view of frozenViews) {
      assert.deepEqual(
        view.match?.order,
        sessions.slice(0, 3).map(({ playerId }) => playerId),
      );
      assert.equal(view.match?.totalRounds, 6);
      assert.deepEqual(Object.values(view.match?.scores ?? {}), [0, 0, 0]);
      assert.equal(view.roundResult, null);
      assert.equal(view.finalResult, null);
      assert.equal(view.myCanvas, null);
    }

    const uniqueResultViews = await driveMatch(
      sessions.slice(0, 3),
      6,
      (playerId) => (playerId === sessions[0]!.playerId ? 100 : 0),
    );
    assert.deepEqual(uniqueResultViews[0]!.finalResult, {
      winners: [sessions[0]!.playerId],
      standings: [
        { playerId: sessions[0]!.playerId, score: 400 },
        { playerId: sessions[1]!.playerId, score: 0 },
        { playerId: sessions[2]!.playerId, score: 0 },
      ],
      rounds: 6,
      cycles: 2,
    });
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
