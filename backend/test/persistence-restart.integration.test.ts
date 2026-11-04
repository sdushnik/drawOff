import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io as createSocketClient, type Socket } from "socket.io-client";
import type { PlayerView, Session } from "@drawoff/contracts";
import { KyselyGameStateRepository } from "../src/database/repository.js";
import type { MatchPhaseDurations } from "../src/match-state-machine.js";
import { createPersistentServer } from "../src/server.js";

type TestServer = Awaited<ReturnType<typeof createPersistentServer>> & { address: string };

async function start(
  databaseUrl: string,
  options: {
    now?: () => number;
    phaseDurationsMs?: Partial<MatchPhaseDurations>;
  } = {},
): Promise<TestServer> {
  const server = await createPersistentServer({
    databaseUrl,
    logger: false,
    corsOrigins: ["http://127.0.0.1:8080"],
    matchStateMachineOptions: {
      now: options.now,
      random: () => 0,
      phaseDurationsMs: {
        ROLE_REVEAL: 50,
        WORD_SELECTION: 2_000,
        DRAWING: 3_000,
        ROUND_RESULT: 2_000,
        JUDGE_MINIMUM: 2_000,
        JUDGE_PER_ARTIST: 500,
        ...options.phaseDurationsMs,
      },
    },
  });
  const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
  return { ...server, address };
}

async function stop(server: TestServer): Promise<void> {
  await new Promise<void>((resolve) => server.io.close(() => resolve()));
  await server.app.close();
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
    const onError = (error: unknown) => {
      clearTimeout(timeout);
      reject(new Error(`${event} failed: ${JSON.stringify(error)}`));
    };
    socket.once("error", onError);
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve(response);
    });
  });
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

test("a complete Socket.IO backend restart restores state, timers, privacy, and idempotency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drawoff-restart-"));
  const databaseUrl = `sqlite:${join(directory, "restart.sqlite")}`;
  const clients: Socket[] = [];
  let first: TestServer | undefined;
  let second: TestServer | undefined;
  let third: TestServer | undefined;
  try {
    first = await start(databaseUrl);
    const hostClient = await connect(first.address);
    const firstArtistClient = await connect(first.address);
    const secondArtistClient = await connect(first.address);
    clients.push(hostClient.socket, firstArtistClient.socket, secondArtistClient.socket);

    const host = (await request<{ session: Session }>(
      hostClient.socket,
      "room:create",
      { name: "Restart Host" },
    )).session;
    const artistOne = (await request<{ session: Session }>(
      firstArtistClient.socket,
      "room:join",
      { code: host.roomCode, name: "Restart Artist One" },
    )).session;
    const artistTwo = (await request<{ session: Session }>(
      secondArtistClient.socket,
      "room:join",
      { code: host.roomCode, name: "Restart Artist Two" },
    )).session;
    await request(hostClient.socket, "match:start", { session: host });
    await waitForView(hostClient.views, (view) => view.phase === "WORD_SELECTION");
    await request(hostClient.socket, "prompt:select", { session: host, prompt: "lighthouse" });
    const clear = { type: "clear", id: "restart-clear" };
    await request(firstArtistClient.socket, "drawing:ops", {
      session: artistOne,
      ops: [clear],
    });
    await waitForView(hostClient.views, (view) =>
      view.phase === "DRAWING" && view.liveCanvases?.[0]?.canvas.rev === 1);
    await stop(first);
    first = undefined;
    clients.splice(0).forEach((socket) => socket.disconnect());

    second = await start(databaseUrl);
    assert.equal(
      second.roomService.getRoom(host.roomCode).players.every((player) => !player.connected),
      true,
    );
    const restoredHost = await connect(second.address);
    const restoredArtistOne = await connect(second.address);
    const restoredArtistTwo = await connect(second.address);
    clients.push(restoredHost.socket, restoredArtistOne.socket, restoredArtistTwo.socket);
    await request(restoredHost.socket, "session:resume", { session: host });
    await request(restoredArtistOne.socket, "session:resume", { session: artistOne });
    await request(restoredArtistTwo.socket, "session:resume", { session: artistTwo });

    const judgeView = await waitForView(restoredHost.views, (view) => view.phase === "DRAWING");
    const artistOneView = await waitForView(restoredArtistOne.views, (view) => view.phase === "DRAWING");
    const artistTwoView = await waitForView(restoredArtistTwo.views, (view) => view.phase === "DRAWING");
    assert.equal(judgeView.liveCanvases?.[0]?.canvas.rev, 1);
    assert.equal(judgeView.players.some((player) => player.id === artistOne.playerId), false);
    assert.equal(artistOneView.myCanvas?.canvas.rev, 1);
    assert.equal(artistOneView.liveCanvases, null);
    assert.equal(artistTwoView.myCanvas?.canvas.rev, 0);
    assert.equal(artistTwoView.liveCanvases, null);

    await request(restoredArtistOne.socket, "drawing:ops", {
      session: artistOne,
      ops: [clear],
    });
    const duplicateView = await waitForView(restoredArtistOne.views, (view) =>
      view.myCanvas?.canvas.rev === 1);
    assert.equal(duplicateView.myCanvas?.canvas.rev, 1);

    await waitForView(restoredHost.views, (view) => view.phase === "JUDGING");
    const ratings = { "Drawing 1": 55, "Drawing 2": 55 };
    await request(restoredHost.socket, "ratings:submit", { session: host, ratings });
    await request(restoredHost.socket, "ratings:submit", { session: host, ratings });
    const scored = await waitForView(restoredHost.views, (view) => view.phase === "ROUND_RESULT");
    assert.equal(scored.match?.scores[artistOne.playerId], 55);
    assert.equal(scored.match?.scores[artistTwo.playerId], 55);

    await stop(second);
    second = undefined;
    clients.splice(0).forEach((socket) => socket.disconnect());
    third = await start(databaseUrl);
    const finalHost = await connect(third.address);
    clients.push(finalHost.socket);
    await request(finalHost.socket, "session:resume", { session: host });
    const restoredScores = await waitForView(finalHost.views, (view) => view.phase === "ROUND_RESULT");
    assert.equal(restoredScores.match?.scores[artistOne.playerId], 55);
    await request(finalHost.socket, "ratings:submit", { session: host, ratings });
    const afterRetry = finalHost.views.at(-1)!;
    assert.equal(afterRetry.match?.scores[artistOne.playerId], 55);
  } finally {
    clients.forEach((socket) => socket.disconnect());
    if (first) await stop(first);
    if (second) await stop(second);
    if (third) await stop(third);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline-expired deadlines transition during a complete backend restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drawoff-overdue-restart-"));
  const databaseUrl = `sqlite:${join(directory, "overdue.sqlite")}`;
  const clients: Socket[] = [];
  let first: TestServer | undefined;
  let second: TestServer | undefined;
  try {
    const phaseDurationsMs = { ROLE_REVEAL: 250, WORD_SELECTION: 2_000 };
    first = await start(databaseUrl, { phaseDurationsMs });
    const hostClient = await connect(first.address);
    const artistOneClient = await connect(first.address);
    const artistTwoClient = await connect(first.address);
    clients.push(hostClient.socket, artistOneClient.socket, artistTwoClient.socket);
    const host = (await request<{ session: Session }>(hostClient.socket, "room:create", {
      name: "Offline Host",
    })).session;
    await request(artistOneClient.socket, "room:join", {
      code: host.roomCode,
      name: "Offline Artist One",
    });
    await request(artistTwoClient.socket, "room:join", {
      code: host.roomCode,
      name: "Offline Artist Two",
    });
    await request(hostClient.socket, "match:start", { session: host });
    const roleReveal = await waitForView(hostClient.views, (view) => view.phase === "ROLE_REVEAL");
    const originalDeadline = roleReveal.deadline!;
    await stop(first);
    first = undefined;
    clients.splice(0).forEach((socket) => socket.disconnect());

    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, originalDeadline - Date.now() + 100)));
    second = await start(databaseUrl, { phaseDurationsMs });
    const restoredHost = await connect(second.address);
    clients.push(restoredHost.socket);
    await request(restoredHost.socket, "session:resume", { session: host });
    const recovered = await waitForView(
      restoredHost.views,
      (view) => view.phase === "WORD_SELECTION",
    );
    assert.equal(recovered.deadline, originalDeadline + phaseDurationsMs.WORD_SELECTION);
    assert.ok(recovered.deadline! - recovered.serverNow < phaseDurationsMs.WORD_SELECTION);
  } finally {
    clients.forEach((socket) => socket.disconnect());
    if (first) await stop(first);
    if (second) await stop(second);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a persisted rematch remains a clean lobby after a complete backend restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drawoff-rematch-restart-"));
  const databaseUrl = `sqlite:${join(directory, "rematch.sqlite")}`;
  const clients: Socket[] = [];
  let first: TestServer | undefined;
  let second: TestServer | undefined;
  try {
    const phaseDurationsMs = {
      ROLE_REVEAL: 20,
      WORD_SELECTION: 500,
      DRAWING: 40,
      ROUND_RESULT: 20,
      JUDGE_MINIMUM: 500,
      JUDGE_PER_ARTIST: 100,
    };
    first = await start(databaseUrl, { phaseDurationsMs });
    const connected = await Promise.all([
      connect(first.address),
      connect(first.address),
      connect(first.address),
    ]);
    clients.push(...connected.map(({ socket }) => socket));
    const host = (await request<{ session: Session }>(connected[0]!.socket, "room:create", {
      name: "Rematch Host",
    })).session;
    const artistOne = (await request<{ session: Session }>(connected[1]!.socket, "room:join", {
      code: host.roomCode,
      name: "Rematch Artist One",
    })).session;
    const artistTwo = (await request<{ session: Session }>(connected[2]!.socket, "room:join", {
      code: host.roomCode,
      name: "Rematch Artist Two",
    })).session;
    const players = new Map([
      [host.playerId, { session: host, ...connected[0]! }],
      [artistOne.playerId, { session: artistOne, ...connected[1]! }],
      [artistTwo.playerId, { session: artistTwo, ...connected[2]! }],
    ]);

    await request(connected[0]!.socket, "match:start", { session: host });
    const ratings = { "Drawing 1": 25, "Drawing 2": 75 };
    for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
      const selection = await waitForView(
        connected[0]!.views,
        (view) => view.phase === "WORD_SELECTION" && view.match?.roundIndex === roundIndex,
      );
      const judge = players.get(selection.match!.judgeId)!;
      await request(judge.socket, "prompt:select", {
        session: judge.session,
        prompt: `rematch round ${roundIndex + 1}`,
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
    await request(connected[0]!.socket, "match:rematch", { session: host });
    const lobby = await waitForView(
      connected[0]!.views,
      (view) => view.phase === "LOBBY" && !view.matchStarted,
    );
    assert.equal(lobby.match, null);
    await stop(first);
    first = undefined;
    clients.splice(0).forEach((socket) => socket.disconnect());

    second = await start(databaseUrl, { phaseDurationsMs });
    const restored = await connect(second.address);
    clients.push(restored.socket);
    await request(restored.socket, "session:resume", { session: host });
    const restoredLobby = await waitForView(
      restored.views,
      (view) => view.phase === "LOBBY" && !view.matchStarted,
    );
    assert.equal(restoredLobby.match, null);
    assert.equal(restoredLobby.players.length, 3);
    assert.equal(restoredLobby.cycles, 1);
  } finally {
    clients.forEach((socket) => socket.disconnect());
    if (first) await stop(first);
    if (second) await stop(second);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lazy room expiry deletes persisted rows before returning not found", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drawoff-lazy-expiry-"));
  const databaseUrl = `sqlite:${join(directory, "expiry.sqlite")}`;
  let now = 1_000;
  const clients: Socket[] = [];
  let server: TestServer | undefined;
  let repository: KyselyGameStateRepository | undefined;
  try {
    server = await start(databaseUrl, { now: () => now });
    const client = await connect(server.address);
    clients.push(client.socket);
    const session = (await request<{ session: Session }>(client.socket, "room:create", {
      name: "Expiring Host",
    })).session;
    now += 30 * 60 * 1_000;
    await assert.rejects(
      request(client.socket, "session:resume", { session }),
      /ROOM_NOT_FOUND/,
    );

    repository = KyselyGameStateRepository.open(databaseUrl);
    await repository.migrate();
    assert.deepEqual(await repository.load(), { rooms: [], matches: [] });
  } finally {
    clients.forEach((socket) => socket.disconnect());
    await repository?.close();
    if (server) await stop(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disconnect pause state commits before remaining players receive it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drawoff-disconnect-persist-"));
  const databaseUrl = `sqlite:${join(directory, "disconnect.sqlite")}`;
  const clients: Socket[] = [];
  let server: TestServer | undefined;
  let repository: KyselyGameStateRepository | undefined;
  try {
    server = await start(databaseUrl);
    const hostClient = await connect(server.address);
    const artistOneClient = await connect(server.address);
    const artistTwoClient = await connect(server.address);
    clients.push(hostClient.socket, artistOneClient.socket, artistTwoClient.socket);
    const host = (await request<{ session: Session }>(hostClient.socket, "room:create", {
      name: "Disconnect Host",
    })).session;
    const disconnectedArtist = (await request<{ session: Session }>(
      artistOneClient.socket,
      "room:join",
      { code: host.roomCode, name: "Disconnect Artist" },
    )).session;
    await request(artistTwoClient.socket, "room:join", {
      code: host.roomCode,
      name: "Remaining Artist",
    });
    await request(hostClient.socket, "match:start", { session: host });
    await waitForView(hostClient.views, (view) => view.phase === "WORD_SELECTION");
    artistOneClient.socket.disconnect();
    const paused = await waitForView(hostClient.views, (view) => view.pause !== null);
    assert.equal(paused.pause?.playerName, "Disconnect Artist");

    repository = KyselyGameStateRepository.open(databaseUrl);
    await repository.migrate();
    const durable = await repository.load();
    assert.equal(durable.matches[0]?.pause?.playerId, disconnectedArtist.playerId);
  } finally {
    clients.forEach((socket) => socket.disconnect());
    await repository?.close();
    if (server) await stop(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
