import assert from "node:assert/strict";
import { test } from "node:test";
import { io as createSocketClient, type Socket } from "socket.io-client";
import type { PlayerView, Session } from "@drawoff/contracts";
import {
  RoomPersistenceError,
  type DurableGameState,
  type GameStateRepository,
} from "../src/database/repository.js";
import { createServer } from "../src/server.js";

class DeterministicFailingRepository implements GameStateRepository {
  state: DurableGameState = { rooms: [], matches: [] };
  calls = 0;
  failOnCall: number | null = null;

  async migrate(): Promise<void> {}

  async load(): Promise<DurableGameState> {
    return structuredClone(this.state);
  }

  async replace(state: DurableGameState): Promise<void> {
    this.calls += 1;
    if (this.calls === this.failOnCall) throw new RoomPersistenceError();
    this.state = structuredClone(state);
  }

  async close(): Promise<void> {}
}

async function connect(address: string) {
  const socket = createSocketClient(address, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  const views: PlayerView[] = [];
  socket.on("state:update", (view: PlayerView) => views.push(view));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return { socket, views };
}

async function request<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} timed out`)), 4_000);
    const onError = (error: { code?: string; message?: string }) => {
      clearTimeout(timeout);
      reject(Object.assign(new Error(error.message ?? `${event} failed`), { code: error.code }));
    };
    socket.once("error", onError);
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve(response);
    });
  });
}

async function expectServiceUnavailable(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<void> {
  await assert.rejects(
    request(socket, event, payload),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "SERVICE_UNAVAILABLE",
  );
}

async function waitForView(
  views: PlayerView[],
  predicate: (view: PlayerView) => boolean,
): Promise<PlayerView> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const view = views.findLast(predicate);
    if (view) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for view; latest phase was ${views.at(-1)?.phase ?? "none"}`);
}

test("rating and rematch transitions roll memory back when their sole durable write fails", async () => {
  const repository = new DeterministicFailingRepository();
  const server = createServer({
    repository,
    logger: false,
    corsOrigins: ["http://127.0.0.1:8080"],
    matchStateMachineOptions: {
      random: () => 0,
      phaseDurationsMs: {
        ROLE_REVEAL: 20,
        WORD_SELECTION: 500,
        DRAWING: 40,
        ROUND_RESULT: 20,
        JUDGE_MINIMUM: 500,
        JUDGE_PER_ARTIST: 100,
      },
    },
  });
  const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const connected = await Promise.all([connect(address), connect(address), connect(address)]);
  try {
    const host = (await request<{ session: Session }>(connected[0]!.socket, "room:create", {
      name: "Atomic Host",
    })).session;
    const artistOne = (await request<{ session: Session }>(connected[1]!.socket, "room:join", {
      code: host.roomCode,
      name: "Atomic Artist One",
    })).session;
    const artistTwo = (await request<{ session: Session }>(connected[2]!.socket, "room:join", {
      code: host.roomCode,
      name: "Atomic Artist Two",
    })).session;
    const players = new Map([
      [host.playerId, { session: host, ...connected[0]! }],
      [artistOne.playerId, { session: artistOne, ...connected[1]! }],
      [artistTwo.playerId, { session: artistTwo, ...connected[2]! }],
    ]);
    const ratings = { "Drawing 1": 25, "Drawing 2": 75 };

    await request(connected[0]!.socket, "match:start", { session: host });
    const firstSelection = await waitForView(
      connected[0]!.views,
      (view) => view.phase === "WORD_SELECTION" && view.match?.roundIndex === 0,
    );
    const firstJudge = players.get(firstSelection.match!.judgeId)!;
    await request(firstJudge.socket, "prompt:select", {
      session: firstJudge.session,
      prompt: "atomic ratings",
    });
    await waitForView(firstJudge.views, (view) => view.phase === "JUDGING");

    const callsBeforeRating = repository.calls;
    repository.failOnCall = callsBeforeRating + 1;
    await expectServiceUnavailable(firstJudge.socket, "ratings:submit", {
      session: firstJudge.session,
      ratings,
    });
    assert.equal(repository.calls, callsBeforeRating + 1);
    const ratingMemory = server.matchStateMachine.getPlayerView(host);
    assert.equal(ratingMemory.phase, "JUDGING");
    assert.equal(ratingMemory.roundResult, null);
    assert.deepEqual(Object.values(ratingMemory.match!.scores), [0, 0, 0]);
    assert.equal(repository.state.matches[0]?.phase, "JUDGING");
    assert.equal(repository.state.matches[0]?.roundResult, null);
    assert.deepEqual(Object.values(repository.state.matches[0]!.scores), [0, 0, 0]);

    repository.failOnCall = null;
    await request(firstJudge.socket, "ratings:submit", {
      session: firstJudge.session,
      ratings,
    });
    await waitForView(connected[0]!.views, (view) => view.phase === "ROUND_RESULT");

    for (let roundIndex = 1; roundIndex < 3; roundIndex += 1) {
      const selection = await waitForView(
        connected[0]!.views,
        (view) => view.phase === "WORD_SELECTION" && view.match?.roundIndex === roundIndex,
      );
      const judge = players.get(selection.match!.judgeId)!;
      await request(judge.socket, "prompt:select", {
        session: judge.session,
        prompt: `atomic round ${roundIndex + 1}`,
      });
      await waitForView(
        judge.views,
        (view) => view.phase === "JUDGING" && view.match?.roundIndex === roundIndex,
      );
      await request(judge.socket, "ratings:submit", { session: judge.session, ratings });
      await waitForView(
        connected[0]!.views,
        (view) => view.phase === "ROUND_RESULT" && view.match?.roundIndex === roundIndex,
      );
    }
    await waitForView(connected[0]!.views, (view) => view.phase === "FINAL_RESULT");

    const durableFinal = structuredClone(repository.state);
    const callsBeforeRematch = repository.calls;
    repository.failOnCall = callsBeforeRematch + 1;
    await expectServiceUnavailable(connected[0]!.socket, "match:rematch", { session: host });
    assert.equal(repository.calls, callsBeforeRematch + 1);
    assert.equal(server.matchStateMachine.getPlayerView(host).phase, "FINAL_RESULT");
    assert.deepEqual(repository.state, durableFinal);
    assert.equal(repository.state.rooms[0]?.matchInProgress, true);
    assert.equal(repository.state.matches[0]?.phase, "FINAL_RESULT");

    repository.failOnCall = null;
    await request(connected[0]!.socket, "match:rematch", { session: host });
    const lobby = await waitForView(
      connected[0]!.views,
      (view) => view.phase === "LOBBY" && !view.matchStarted,
    );
    assert.equal(lobby.match, null);
    assert.equal(repository.state.rooms[0]?.matchInProgress, false);
    assert.equal(repository.state.matches.length, 0);
  } finally {
    connected.forEach(({ socket }) => socket.disconnect());
    await new Promise<void>((resolve) => server.io.close(() => resolve()));
    await server.app.close();
  }
});
