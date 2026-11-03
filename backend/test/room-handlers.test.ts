import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import {
  clientToServerPayloadSchemas,
  clientToServerResponseSchemas,
  serviceErrorPayloadSchema,
  type ClientToServerPayloads,
  type ClientToServerResponses,
  type PlayerView,
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
  "state:update": (view: PlayerView) => void;
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

function waitForRoster(
  socket: TestSocket,
  predicate: (view: PlayerView) => boolean,
): Promise<PlayerView> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("state:update", onView);
      reject(new Error("Timed out waiting for a room roster update."));
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

test("live room rosters cover create, join, leave, disconnect, reconnect, and room isolation", async () => {
  const service = new RoomService();
  const { app, io } = createServer({ logger: false, roomService: service });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const hostSocket = await connect(address);
  const guestSocket = await connect(address);
  const otherRoomSocket = await connect(address);
  const outsiderSocket = await connect(address);
  const hostViews: PlayerView[] = [];
  const guestViews: PlayerView[] = [];
  const otherRoomViews: PlayerView[] = [];
  hostSocket.on("state:update", (view) => hostViews.push(view));
  guestSocket.on("state:update", (view) => guestViews.push(view));
  otherRoomSocket.on("state:update", (view) => otherRoomViews.push(view));

  try {
    const created = await request(hostSocket, "room:create", { name: "Host" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const host = created.response.session;
    const initialHostView = hostViews.at(-1);
    assert.ok(initialHostView);
    assert.equal(initialHostView.roomCode, host.roomCode);
    assert.deepEqual(initialHostView.players.map(({ name, isHost, connected }) => ({
      name,
      isHost,
      connected,
    })), [{ name: "Host", isHost: true, connected: true }]);

    const joinPromise = waitForRoster(
      hostSocket,
      (view) => view.players.some(({ name }) => name === "Guest"),
    );
    const joined = await request(guestSocket, "room:join", {
      code: `https://draw.example/room/${host.roomCode}`,
      name: "Guest",
    });
    assert.equal(joined.ok, true);
    if (!joined.ok) return;
    const guest = joined.response.session;
    const joinedHostView = await joinPromise;
    const joinedGuestView = guestViews.at(-1);
    assert.ok(joinedGuestView);
    assert.deepEqual(
      joinedHostView.players.map(({ name, isHost, connected }) => ({
        name,
        isHost,
        connected,
      })),
      [
        { name: "Host", isHost: true, connected: true },
        { name: "Guest", isHost: false, connected: true },
      ],
    );
    assert.deepEqual(joinedGuestView.players, joinedHostView.players);

    const hostCycleUpdate = waitForRoster(hostSocket, (view) => view.cycles === 2);
    const guestCycleUpdate = waitForRoster(guestSocket, (view) => view.cycles === 2);
    const rejectedCycleChange = await request(guestSocket, "match:set-cycles", {
      session: guest,
      cycles: 2,
    });
    assert.equal(rejectedCycleChange.ok, false);
    if (!rejectedCycleChange.ok) assert.equal(rejectedCycleChange.error.code, "FORBIDDEN");
    assert.deepEqual(
      await request(hostSocket, "match:set-cycles", { session: host, cycles: 2 }),
      { ok: true, response: {} },
    );
    await Promise.all([hostCycleUpdate, guestCycleUpdate]);

    const guestOffline = waitForRoster(
      hostSocket,
      (view) => view.players.some(({ id, connected }) => id === guest.playerId && !connected),
    );
    guestSocket.disconnect();
    await guestOffline;

    await new Promise<void>((resolve, reject) => {
      guestSocket.once("connect", resolve);
      guestSocket.once("connect_error", reject);
      guestSocket.connect();
    });
    const guestOnline = waitForRoster(
      hostSocket,
      (view) => view.players.some(({ id, connected }) => id === guest.playerId && connected),
    );
    const guestReconnectView = waitForRoster(
      guestSocket,
      (view) => view.players.some(({ id, connected }) => id === guest.playerId && connected),
    );
    assert.deepEqual(
      await request(guestSocket, "session:resume", { session: guest }),
      { ok: true, response: { session: guest } },
    );
    await Promise.all([guestOnline, guestReconnectView]);

    const hostViewCountBeforeOtherRoom = hostViews.length;
    const otherCreated = await request(otherRoomSocket, "room:create", { name: "Other Host" });
    assert.equal(otherCreated.ok, true);
    if (!otherCreated.ok) return;
    const otherHost = otherCreated.response.session;
    const otherJoinPromise = waitForRoster(
      otherRoomSocket,
      (view) => view.players.some(({ name }) => name === "Other Guest"),
    );
    const otherJoined = await request(outsiderSocket, "room:join", {
      code: otherHost.roomCode,
      name: "Other Guest",
    });
    assert.equal(otherJoined.ok, true);
    if (!otherJoined.ok) return;
    await otherJoinPromise;
    assert.equal(hostViews.length, hostViewCountBeforeOtherRoom);
    assert.equal(
      hostViews.at(-1)?.players.some(({ name }) => name.startsWith("Other")),
      false,
    );
    assert.equal(
      otherRoomViews.at(-1)?.players.some(({ name }) => name === "Guest"),
      false,
    );

    const guestLeft = waitForRoster(
      hostSocket,
      (view) => !view.players.some(({ id }) => id === guest.playerId),
    );
    assert.deepEqual(await request(guestSocket, "room:leave", { session: guest }), {
      ok: true,
      response: {},
    });
    const afterLeave = await guestLeft;
    assert.deepEqual(afterLeave.players.map(({ name }) => name), ["Host"]);

    const third = await request(guestSocket, "room:join", {
      code: host.roomCode,
      name: "Third",
    });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    const thirdSession = third.response.session;
    const fourthSocket = await connect(address);
    try {
      const fourth = await request(fourthSocket, "room:join", {
        code: host.roomCode,
        name: "Fourth",
      });
      assert.equal(fourth.ok, true);
      if (!fourth.ok) return;

      const beforeRejectedJoin = service.getRoom(host.roomCode);
      const hostUpdateCount = hostViews.length;
      const thirdUpdateCount = guestViews.length;
      service.setMatchInProgress(host.roomCode, true);
      const rejected = await request(outsiderSocket, "room:join", {
        code: host.roomCode,
        name: "Late Entrant",
      });
      assert.equal(rejected.ok, false);
      if (!rejected.ok) {
        assert.equal(rejected.error.code, "MATCH_IN_PROGRESS");
        assert.match(rejected.error.message, /active match/i);
      }
      assert.deepEqual(service.getRoom(host.roomCode).players, beforeRejectedJoin.players);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(hostViews.length, hostUpdateCount);
      assert.equal(guestViews.length, thirdUpdateCount);
      assert.equal(
        hostViews.at(-1)?.players.some(({ name }) => name === "Late Entrant"),
        false,
      );
      assert.deepEqual(await request(guestSocket, "session:resume", { session: thirdSession }), {
        ok: true,
        response: { session: thirdSession },
      });
    } finally {
      fourthSocket.disconnect();
    }
  } finally {
    hostSocket.disconnect();
    guestSocket.disconnect();
    otherRoomSocket.disconnect();
    outsiderSocket.disconnect();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});

test("host lobby controls are enforced server-side and broadcast to every connected member", async () => {
  const service = new RoomService();
  const { app, io } = createServer({ logger: false, roomService: service });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const hostSocket = await connect(address);
  const guestSocket = await connect(address);
  const thirdSocket = await connect(address);
  const fourthSocket = await connect(address);
  const hostViews: PlayerView[] = [];
  const guestViews: PlayerView[] = [];
  const thirdViews: PlayerView[] = [];
  const fourthViews: PlayerView[] = [];
  hostSocket.on("state:update", (view) => hostViews.push(view));
  guestSocket.on("state:update", (view) => guestViews.push(view));
  thirdSocket.on("state:update", (view) => thirdViews.push(view));
  fourthSocket.on("state:update", (view) => fourthViews.push(view));

  try {
    const hostResult = await request(hostSocket, "room:create", { name: "Host" });
    assert.equal(hostResult.ok, true);
    if (!hostResult.ok) return;
    const host = hostResult.response.session;

    const guestHostUpdate = waitForRoster(hostSocket, (view) => view.players.length === 2);
    const guestResult = await request(guestSocket, "room:join", {
      code: host.roomCode,
      name: "Guest",
    });
    assert.equal(guestResult.ok, true);
    if (!guestResult.ok) return;
    const guest = guestResult.response.session;
    await guestHostUpdate;

    const thirdHostUpdate = waitForRoster(hostSocket, (view) => view.players.length === 3);
    const thirdGuestUpdate = waitForRoster(guestSocket, (view) => view.players.length === 3);
    const thirdResult = await request(thirdSocket, "room:join", {
      code: host.roomCode,
      name: "Third",
    });
    assert.equal(thirdResult.ok, true);
    if (!thirdResult.ok) return;
    const third = thirdResult.response.session;
    await Promise.all([thirdHostUpdate, thirdGuestUpdate]);
    assert.equal(hostViews.at(-1)?.cycles, 1);
    assert.equal(guestViews.at(-1)?.cycles, 1);

    for (const cycles of [1, 2, 3] as const) {
      const hostUpdate = waitForRoster(hostSocket, (view) => view.cycles === cycles);
      const guestUpdate = waitForRoster(guestSocket, (view) => view.cycles === cycles);
      const thirdUpdate = waitForRoster(thirdSocket, (view) => view.cycles === cycles);
      const changed = await request(hostSocket, "match:set-cycles", { session: host, cycles });
      assert.deepEqual(changed, { ok: true, response: {} });
      await Promise.all([hostUpdate, guestUpdate, thirdUpdate]);
      assert.equal(guestViews.at(-1)?.cycles, cycles);
      assert.equal(thirdViews.at(-1)?.cycles, cycles);
    }

    const invalidCycles = await request(hostSocket, "match:set-cycles", {
      session: host,
      cycles: 4,
    } as ClientToServerPayloads["match:set-cycles"]);
    assert.equal(invalidCycles.ok, false);
    if (!invalidCycles.ok) assert.equal(invalidCycles.error.code, "INVALID_INPUT");
    const deniedCycles = await request(guestSocket, "match:set-cycles", {
      session: guest,
      cycles: 2,
    });
    assert.equal(deniedCycles.ok, false);
    if (!deniedCycles.ok) assert.equal(deniedCycles.error.code, "FORBIDDEN");
    assert.equal(service.getLobbyView(host).cycles, 3);

    const guestKickHostUpdate = waitForRoster(
      hostSocket,
      (view) => !view.players.some(({ id }) => id === guest.playerId),
    );
    const thirdKickUpdate = waitForRoster(
      thirdSocket,
      (view) => !view.players.some(({ id }) => id === guest.playerId),
    );
    assert.deepEqual(
      await request(hostSocket, "player:kick", { session: host, playerId: guest.playerId }),
      { ok: true, response: {} },
    );
    await Promise.all([guestKickHostUpdate, thirdKickUpdate]);
    const revoked = await request(guestSocket, "session:resume", { session: guest });
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.error.code, "UNAUTHORIZED");

    const hostStartWithoutEnoughPlayers = await request(hostSocket, "match:start", {
      session: host,
    });
    assert.equal(hostStartWithoutEnoughPlayers.ok, false);
    if (!hostStartWithoutEnoughPlayers.ok) {
      assert.equal(hostStartWithoutEnoughPlayers.error.code, "NOT_ENOUGH_PLAYERS");
    }
    assert.equal(service.getLobbyView(host).matchStarted, false);

    const fourthHostUpdate = waitForRoster(hostSocket, (view) => view.players.length === 3);
    const fourthThirdUpdate = waitForRoster(thirdSocket, (view) => view.players.length === 3);
    const fourthResult = await request(fourthSocket, "room:join", {
      code: host.roomCode,
      name: "Fourth",
    });
    assert.equal(fourthResult.ok, true);
    if (!fourthResult.ok) return;
    const fourth = fourthResult.response.session;
    await Promise.all([fourthHostUpdate, fourthThirdUpdate]);

    const guestStart = await request(thirdSocket, "match:start", { session: third });
    assert.equal(guestStart.ok, false);
    if (!guestStart.ok) assert.equal(guestStart.error.code, "FORBIDDEN");
    assert.equal(service.getLobbyView(host).matchStarted, false);

    const hostStarted = waitForRoster(hostSocket, (view) => view.matchStarted);
    const thirdStarted = waitForRoster(thirdSocket, (view) => view.matchStarted);
    const fourthStarted = waitForRoster(fourthSocket, (view) => view.matchStarted);
    assert.deepEqual(await request(hostSocket, "match:start", { session: host }), {
      ok: true,
      response: {},
    });
    await Promise.all([hostStarted, thirdStarted, fourthStarted]);
    const firstRound = {
      judgeId: host.playerId,
      artistIds: [third.playerId, fourth.playerId],
      order: [host.playerId, third.playerId, fourth.playerId],
    };
    for (const [view, playerId] of [
      [hostViews.at(-1), host.playerId],
      [thirdViews.at(-1), third.playerId],
      [fourthViews.at(-1), fourth.playerId],
    ] as const) {
      assert.ok(view);
      assert.equal(view.phase, "ROLE_REVEAL");
      assert.ok(view.deadline !== null);
      assert.equal(view.match?.roundIndex, 0);
      assert.equal(view.match?.totalRounds, 9);
      assert.deepEqual(view.match?.order, firstRound.order);
      assert.equal(view.match?.judgeId, firstRound.judgeId);
      assert.deepEqual(view.match?.artistIds, firstRound.artistIds);
      assert.equal(view.role, playerId === firstRound.judgeId ? "judge" : "artist");
    }

    const cycleAfterStart = await request(hostSocket, "match:set-cycles", {
      session: host,
      cycles: 2,
    });
    assert.equal(cycleAfterStart.ok, false);
    if (!cycleAfterStart.ok) assert.equal(cycleAfterStart.error.code, "WRONG_PHASE");
    const kickAfterStart = await request(hostSocket, "player:kick", {
      session: host,
      playerId: third.playerId,
    });
    assert.equal(kickAfterStart.ok, false);
    if (!kickAfterStart.ok) assert.equal(kickAfterStart.error.code, "WRONG_PHASE");
    const duplicateStart = await request(hostSocket, "match:start", { session: host });
    assert.equal(duplicateStart.ok, false);
    if (!duplicateStart.ok) assert.equal(duplicateStart.error.code, "WRONG_PHASE");
    assert.equal(service.getLobbyView(host).cycles, 3);
    assert.deepEqual(service.getLobbyView(host).players.map(({ id }) => id), [
      host.playerId,
      third.playerId,
      fourth.playerId,
    ]);
  } finally {
    hostSocket.disconnect();
    guestSocket.disconnect();
    thirdSocket.disconnect();
    fourthSocket.disconnect();
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

test("a lobby host leave promotes the first connected guest and rejects stale host controls", async () => {
  const service = new RoomService();
  const { app, io } = createServer({ logger: false, roomService: service });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const hostSocket = await connect(address);
  const firstGuestSocket = await connect(address);
  const secondGuestSocket = await connect(address);

  try {
    const created = await request(hostSocket, "room:create", { name: "Host" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const host = created.response.session;
    const firstJoined = await request(firstGuestSocket, "room:join", {
      code: host.roomCode,
      name: "First Guest",
    });
    const secondJoined = await request(secondGuestSocket, "room:join", {
      code: host.roomCode,
      name: "Second Guest",
    });
    assert.equal(firstJoined.ok, true);
    assert.equal(secondJoined.ok, true);
    if (!firstJoined.ok || !secondJoined.ok) return;
    const firstGuest = firstJoined.response.session;

    const promotedView = waitForRoster(
      firstGuestSocket,
      (view) => view.hostId === firstGuest.playerId && view.me.isHost,
    );
    assert.deepEqual(await request(hostSocket, "room:leave", { session: host }), {
      ok: true,
      response: {},
    });
    const promoted = await promotedView;
    assert.equal(promoted.players[0]?.id, firstGuest.playerId);
    assert.equal(promoted.players[0]?.isHost, true);

    const stale = await request(hostSocket, "match:set-cycles", {
      session: host,
      cycles: 2,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "UNAUTHORIZED");
    assert.deepEqual(
      await request(firstGuestSocket, "match:set-cycles", {
        session: firstGuest,
        cycles: 2,
      }),
      { ok: true, response: {} },
    );
  } finally {
    hostSocket.disconnect();
    firstGuestSocket.disconnect();
    secondGuestSocket.disconnect();
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
