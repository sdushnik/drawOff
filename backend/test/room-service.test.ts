import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sessionSchema } from "@drawoff/contracts";
import {
  DEFAULT_ROOM_IDLE_TTL_MS,
  RoomService,
  RoomServiceError,
  normalizeRoomCode,
} from "../src/room-service.js";

function expectRoomError(
  action: () => unknown,
  code: RoomServiceError["code"],
): RoomServiceError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RoomServiceError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected ${code} error.`);
}

function createDeterministicService(
  options: {
    now?: () => number;
    idleTtlMs?: number;
    codes?: string[];
  } = {},
) {
  let nextId = 0;
  const codes = options.codes ?? ["ABC123"];
  let nextCode = 0;
  return new RoomService({
    now: options.now,
    idleTtlMs: options.idleTtlMs,
    generateRoomCode: () => codes[Math.min(nextCode++, codes.length - 1)]!,
    generateId: () => `player-${++nextId}`,
  });
}

test("room creation normalizes the host name and returns a typed session", () => {
  const service = createDeterministicService();

  const session = service.createRoom("  Ada   Artist  ");

  assert.equal(session.roomCode, "ABC123");
  assert.equal(session.playerId, "player-1");
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sessionSchema.safeParse(session).success, true);
  assert.deepEqual(service.getRoom(session.roomCode).players, [
    { id: "player-1", name: "Ada Artist", isHost: true, connected: false },
  ]);
});

test("room codes are case-insensitive and collisions never replace an existing room", () => {
  const service = createDeterministicService({ codes: ["abc123", "ABC123", "xyz789"] });

  const first = service.createRoom("Ada");
  const second = service.createRoom("Bea");

  assert.equal(first.roomCode, "ABC123");
  assert.equal(second.roomCode, "XYZ789");
  assert.equal(service.getRoom("abc123").players[0]?.name, "Ada");
  assert.equal(service.getRoom("https://example.test/room/xyz789?source=invite").code, "XYZ789");
});

test("joining by bare code or invite link adds any number of guests and returns a session", () => {
  const service = createDeterministicService();
  const host = service.createRoom("Host");

  const guest = service.joinRoom("https://example.test/room/abc123?source=invite", "  Guest   One ");
  for (let index = 0; index < 8; index += 1) {
    service.joinRoom(host.roomCode, `Guest ${index}`);
  }

  assert.equal(sessionSchema.safeParse(guest).success, true);
  const room = service.getRoom(host.roomCode);
  assert.equal(room.players.length, 10);
  assert.deepEqual(room.players[1], {
    id: guest.playerId,
    name: "Guest One",
    isHost: false,
    connected: false,
  });
});

test("display names are trimmed, whitespace-normalized, and validated", () => {
  const service = createDeterministicService();

  for (const invalidName of [" ", "A", "x".repeat(21), "<b>Al</b>"]) {
    expectRoomError(() => service.createRoom(invalidName), "INVALID_INPUT");
  }
  assert.equal(service.getRoom(service.createRoom("  Alice \n Smith ").roomCode).players[0]?.name, "Alice Smith");
});

test("invalid, unknown, and expired room joins use the same safe not-found error", () => {
  let now = 0;
  const service = createDeterministicService({
    now: () => now,
    idleTtlMs: 100,
  });
  const host = service.createRoom("Host");

  assert.throws(
    () => normalizeRoomCode("bad"),
    (error: unknown) => error instanceof RoomServiceError && error.code === "INVALID_INPUT",
  );
  const errors = [
    expectRoomError(() => service.joinRoom("bad", "Guest"), "ROOM_NOT_FOUND"),
    expectRoomError(() => service.joinRoom("XYZ789", "Guest"), "ROOM_NOT_FOUND"),
  ];
  now = 100;
  errors.push(expectRoomError(() => service.joinRoom(host.roomCode, "Guest"), "ROOM_NOT_FOUND"));

  assert.deepEqual(
    errors.map(({ message }) => message),
    [
      "Room was not found or has expired.",
      "Room was not found or has expired.",
      "Room was not found or has expired.",
    ],
  );
});

test("the configured idle TTL starts on creation; reads do not refresh it; expiry is inclusive", () => {
  let now = 1_000;
  const service = createDeterministicService({
    now: () => now,
    idleTtlMs: 100,
  });
  const host = service.createRoom("Host");
  assert.equal(service.getRoom(host.roomCode).expiresAt, 1_100);

  now = 1_099;
  assert.equal(service.getRoom(host.roomCode).expiresAt, 1_100);
  now = 1_100;
  expectRoomError(() => service.getRoom(host.roomCode), "ROOM_NOT_FOUND");
  expectRoomError(() => service.getRoom(host.roomCode), "ROOM_NOT_FOUND");
});

test("a successful join resets idle expiry but lookups do not", () => {
  let now = 0;
  const service = createDeterministicService({
    now: () => now,
    idleTtlMs: 100,
  });
  const host = service.createRoom("Host");

  now = 50;
  service.getRoom(host.roomCode);
  assert.equal(service.getRoom(host.roomCode).expiresAt, 100);
  now = 99;
  service.joinRoom(host.roomCode, "Guest");
  assert.equal(service.getRoom(host.roomCode).expiresAt, 199);
  now = 198;
  assert.equal(service.getRoom(host.roomCode).expiresAt, 199);
  now = 199;
  expectRoomError(() => service.getRoom(host.roomCode), "ROOM_NOT_FOUND");
});

test("expired rooms are removed lazily when joining and cannot be revived", () => {
  let now = 0;
  const service = createDeterministicService({
    now: () => now,
    idleTtlMs: 20,
  });
  const host = service.createRoom("Host");

  now = 20;
  expectRoomError(() => service.joinRoom(host.roomCode, "Guest"), "ROOM_NOT_FOUND");
  expectRoomError(() => service.getRoom(host.roomCode), "ROOM_NOT_FOUND");
});

test("active matches reject newcomers without refreshing the room idle expiry", () => {
  let now = 0;
  const service = createDeterministicService({
    now: () => now,
    idleTtlMs: 100,
  });
  const host = service.createRoom("Host");

  now = 10;
  service.setMatchInProgress(host.roomCode, true);
  expectRoomError(() => service.joinRoom(host.roomCode, "Guest"), "MATCH_IN_PROGRESS");
  assert.equal(service.getRoom(host.roomCode).expiresAt, 100);

  service.setMatchInProgress(host.roomCode, false);
  assert.equal(service.joinRoom(host.roomCode, "Guest").roomCode, host.roomCode);
});

test("idle TTL must be positive and finite", () => {
  for (const idleTtlMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(() => new RoomService({ idleTtlMs }), RangeError);
  }
  assert.equal(new RoomService().createRoom("Host").roomCode.length, 6);
  assert.equal(DEFAULT_ROOM_IDLE_TTL_MS, 30 * 60 * 1000);
});

test("default sessions use cryptographic credentials", () => {
  const service = new RoomService();
  const session = service.createRoom("Host");
  const guest = service.joinRoom(session.roomCode, "Guest");

  assert.equal(sessionSchema.safeParse(session).success, true);
  assert.match(session.playerId, /^[0-9a-f-]{36}$/i);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(session.token, guest.token);
  assert.equal(JSON.stringify(service.getRoom(session.roomCode)).includes(session.token), false);
  assert.equal(JSON.stringify(service.getRoom(session.roomCode)).includes(guest.token), false);

  const internal = service as unknown as {
    rooms: Map<string, { players: Array<{ sessionTokenHash: Buffer }> }>;
  };
  const storedPlayers = internal.rooms.get(session.roomCode)!.players;
  assert.deepEqual(
    storedPlayers.map(({ sessionTokenHash }) => sessionTokenHash),
    [session.token, guest.token].map((token) =>
      createHash("sha256").update(token, "utf8").digest(),
    ),
  );
  assert.equal(JSON.stringify(storedPlayers).includes(session.token), false);
  assert.equal(JSON.stringify(storedPlayers).includes(guest.token), false);
});

test("valid sessions resume only in their room and for their player", () => {
  const service = createDeterministicService({ codes: ["ABC123", "XYZ789"] });
  const host = service.createRoom("Host");
  const guest = service.joinRoom(host.roomCode, "Guest");
  const otherRoom = service.createRoom("Other");

  assert.deepEqual(service.resumeSession({ ...guest, roomCode: "abc123" }), guest);
  expectRoomError(() => service.resumeSession({ ...guest, roomCode: otherRoom.roomCode }), "UNAUTHORIZED");
  expectRoomError(
    () => service.resumeSession({ ...guest, playerId: host.playerId }),
    "UNAUTHORIZED",
  );
  expectRoomError(
    () => service.resumeSession({ ...guest, token: "not-the-session-token" }),
    "UNAUTHORIZED",
  );
  expectRoomError(
    () => service.resumeSession({ ...guest, playerId: "forged-player-id" }),
    "UNAUTHORIZED",
  );
  const attemptedToken = "private-invalid-token";
  const invalidTokenError = expectRoomError(
    () => service.resumeSession({ ...guest, token: attemptedToken }),
    "UNAUTHORIZED",
  );
  assert.equal(invalidTokenError.message.includes(attemptedToken), false);
  expectRoomError(() => service.resumeSession({ ...guest, roomCode: "invalid" }), "UNAUTHORIZED");
});

test("session credentials follow room idle expiry and successful joins renew the room window", () => {
  let now = 0;
  const service = createDeterministicService({
    now: () => now,
    idleTtlMs: 100,
  });
  const host = service.createRoom("Host");

  now = 50;
  const guest = service.joinRoom(host.roomCode, "Guest");
  now = 100;
  assert.deepEqual(service.resumeSession(host), host);
  assert.deepEqual(service.resumeSession(guest), guest);
  now = 150;
  expectRoomError(() => service.resumeSession(host), "ROOM_NOT_FOUND");
  expectRoomError(() => service.resumeSession(guest), "ROOM_NOT_FOUND");
});

test("room expiry rejects existing session credentials and removes the room", () => {
  let now = 0;
  const service = createDeterministicService({
    now: () => now,
    idleTtlMs: 100,
  });
  const session = service.createRoom("Host");

  now = 100;
  expectRoomError(() => service.resumeSession(session), "ROOM_NOT_FOUND");
  expectRoomError(() => service.resumeSession(session), "ROOM_NOT_FOUND");
});

test("leave revokes the player's session and removes the room when empty", () => {
  const service = createDeterministicService();
  const host = service.createRoom("Host");
  const guest = service.joinRoom(host.roomCode, "Guest");

  service.leaveRoom(guest);
  expectRoomError(() => service.resumeSession(guest), "UNAUTHORIZED");
  assert.equal(service.getRoom(host.roomCode).players.some(({ id }) => id === guest.playerId), false);

  service.leaveRoom(host);
  expectRoomError(() => service.getRoom(host.roomCode), "ROOM_NOT_FOUND");
  expectRoomError(() => service.resumeSession(host), "ROOM_NOT_FOUND");
});

test("a host leaving revokes their session and promotes the next player", () => {
  const service = createDeterministicService();
  const host = service.createRoom("Host");
  const guest = service.joinRoom(host.roomCode, "Guest");

  service.leaveRoom(host);

  const room = service.getRoom(host.roomCode);
  assert.equal(room.hostId, guest.playerId);
  assert.deepEqual(room.players, [
    { id: guest.playerId, name: "Guest", isHost: true, connected: false },
  ]);
  expectRoomError(() => service.resumeSession(host), "UNAUTHORIZED");
  assert.deepEqual(service.resumeSession(guest), guest);
});

test("only the authenticated host can kick another player in the lobby", () => {
  const service = createDeterministicService();
  const host = service.createRoom("Host");
  const guest = service.joinRoom(host.roomCode, "Guest");
  const other = service.joinRoom(host.roomCode, "Other");

  expectRoomError(() => service.kickPlayer(guest, other.playerId), "FORBIDDEN");
  expectRoomError(() => service.kickPlayer(host, host.playerId), "FORBIDDEN");
  service.kickPlayer(host, guest.playerId);
  expectRoomError(() => service.resumeSession(guest), "UNAUTHORIZED");

  const room = service.getRoom(host.roomCode);
  assert.equal(room.players.some(({ id }) => id === guest.playerId), false);
  assert.equal(room.players.some(({ id }) => id === other.playerId), true);
});

test("kicking is disabled during a match and an expired room revokes all sessions", () => {
  let now = 0;
  const service = createDeterministicService({
    now: () => now,
    idleTtlMs: 100,
  });
  const host = service.createRoom("Host");
  const guest = service.joinRoom(host.roomCode, "Guest");

  service.setMatchInProgress(host.roomCode, true);
  expectRoomError(() => service.kickPlayer(host, guest.playerId), "WRONG_PHASE");
  now = 100;
  expectRoomError(() => service.resumeSession(guest), "ROOM_NOT_FOUND");
});
