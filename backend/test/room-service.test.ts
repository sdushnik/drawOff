import assert from "node:assert/strict";
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
  let nextToken = 0;
  const codes = options.codes ?? ["ABC123"];
  let nextCode = 0;
  return new RoomService({
    now: options.now,
    idleTtlMs: options.idleTtlMs,
    generateRoomCode: () => codes[Math.min(nextCode++, codes.length - 1)]!,
    generateId: () => `player-${++nextId}`,
    generateToken: () => `session-token-${++nextToken}`,
  });
}

test("room creation normalizes the host name and returns a typed session", () => {
  const service = createDeterministicService();

  const session = service.createRoom("  Ada   Artist  ");

  assert.deepEqual(session, {
    roomCode: "ABC123",
    playerId: "player-1",
    token: "session-token-1",
  });
  assert.equal(sessionSchema.safeParse(session).success, true);
  assert.deepEqual(service.getRoom(session.roomCode).players, [
    { id: "player-1", name: "Ada Artist", isHost: true },
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
  const session = new RoomService().createRoom("Host");

  assert.equal(sessionSchema.safeParse(session).success, true);
  assert.match(session.playerId, /^[0-9a-f-]{36}$/i);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
});
