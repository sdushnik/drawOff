import assert from "node:assert/strict";
import test from "node:test";
import {
  clientToServerPayloadSchemas,
  clientToServerResponseSchemas,
  cyclesSchema,
  drawOpSchema,
  phaseSchema,
  playerViewSchema,
  ratingSchema,
  roleSchema,
  roomStateSchema,
  serverOwnedStateSchema,
  serverToClientPayloadSchemas,
  sessionSchema,
} from "../src/index.js";

const session = { roomCode: "ABCDE", playerId: "p1", token: "secret" };
const view = {
  roomCode: "ABCDE",
  serverNow: 1,
  me: { id: "p1", name: "Player", isHost: true, connected: true, isBot: false },
  players: [],
  hostId: "p1",
  cycles: 1,
  phase: "LOBBY",
  deadline: null,
  pause: null,
  notice: null,
  match: null,
  role: null,
  prompt: null,
  suggestions: null,
  myCanvas: null,
  liveCanvases: null,
  gallery: null,
  judgingOvertime: false,
  roundResult: null,
  finalResult: null,
  interruptedReason: null,
};

test("cycles and ratings accept only inclusive integer bounds without coercion", () => {
  for (const value of [1, 2, 3]) assert.equal(cyclesSchema.safeParse(value).success, true);
  for (const value of [0, 4, 1.5, "1", null]) {
    assert.equal(cyclesSchema.safeParse(value).success, false);
  }

  for (const value of [0, 100]) assert.equal(ratingSchema.safeParse(value).success, true);
  for (const value of [-1, 101, 2.5, "50", null]) {
    assert.equal(ratingSchema.safeParse(value).success, false);
  }
});

test("phase and role schemas accept only their declared values", () => {
  assert.equal(phaseSchema.safeParse("LOBBY").success, true);
  assert.equal(phaseSchema.safeParse("MATCH_INTERRUPTED").success, true);
  assert.equal(phaseSchema.safeParse("UNKNOWN").success, false);
  assert.equal(roleSchema.safeParse("judge").success, true);
  assert.equal(roleSchema.safeParse("artist").success, true);
  assert.equal(roleSchema.safeParse("spectator").success, false);
});

test("session, draw operation, and server-owned room state reject malformed data", () => {
  assert.equal(sessionSchema.safeParse(session).success, true);
  assert.equal(sessionSchema.safeParse({ roomCode: "ABCDE", playerId: "p1" }).success, false);
  assert.equal(
    drawOpSchema.safeParse({
      type: "stroke",
      id: "s1",
      tool: "pen",
      color: "#000000",
      size: 2,
      points: [0, 1],
    }).success,
    true,
  );
  assert.equal(
    drawOpSchema.safeParse({
      type: "stroke",
      id: "s1",
      tool: "pen",
      color: "black",
      size: 2,
      points: [0, 1, 2],
    }).success,
    false,
  );
  assert.equal(
    drawOpSchema.safeParse({
      type: "stroke",
      id: "s1",
      tool: "spray",
      color: "#000000",
      size: 2,
      points: [0, 1],
    }).success,
    false,
  );

  const room = {
    code: "ABCDE",
    hostId: "p1",
    players: [{ id: "p1", name: "Player", token: "secret", connected: true, isBot: false }],
    cycles: 3,
    phase: "LOBBY",
    phaseStartedAt: 0,
    deadline: null,
    pause: null,
    match: null,
    interruptedReason: null,
    notice: null,
  };
  assert.equal(roomStateSchema.safeParse(room).success, true);
  assert.equal(serverOwnedStateSchema.safeParse([room]).success, true);
  const completedRound = {
    judgeId: "p1",
    artistIds: ["p2"],
    suggestions: [],
    prompt: "cat",
    drawings: [
      {
        label: "Drawing 1",
        artistId: "p2",
        canvas: { actions: [], rev: 0, resets: 0 },
        locked: true,
      },
    ],
    overtime: false,
    result: {
      roundIndex: 0,
      prompt: "cat",
      judgeId: "p1",
      entries: [
        {
          label: "Drawing 1",
          artistId: "p2",
          rating: 100,
          canvas: { actions: [], rev: 0, resets: 0 },
        },
      ],
      winners: ["p2"],
    },
  };
  const match = {
    order: ["p1", "p2"],
    cycles: 3,
    roundIndex: 0,
    totalRounds: 6,
    scores: { p1: 0, p2: 100 },
    round: completedRound,
    usedPrompts: ["cat"],
    final: null,
  };
  assert.equal(
    roomStateSchema.safeParse({ ...room, phase: "ROUND_RESULT", match }).success,
    true,
  );
  assert.equal(
    roomStateSchema.safeParse({
      ...room,
      phase: "ROUND_RESULT",
      match: {
        ...match,
        round: {
          ...completedRound,
          result: {
            ...completedRound.result,
            entries: [{ ...completedRound.result.entries[0], rating: 101 }],
          },
        },
      },
    }).success,
    false,
  );
  assert.equal(roomStateSchema.safeParse({ ...room, phase: "INVALID" }).success, false);
  assert.equal(roomStateSchema.safeParse({ ...room, extra: true }).success, false);
});

test("all declared client-to-server payloads and acknowledgements have strict schemas", () => {
  const payloads = {
    "room:create": { name: "Player" },
    "room:join": { code: "ABCDE", name: "Player" },
    "session:resume": { session },
    "room:leave": { session },
    "player:kick": { session, playerId: "p2" },
    "match:set-cycles": { session, cycles: 1 },
    "match:start": { session },
    "prompt:select": { session, prompt: "cat" },
    "drawing:ops": { session, ops: [{ type: "clear", id: "op1" }] },
    "drawing:submit": { session },
    "ratings:submit": { session, ratings: { drawing1: 0, drawing2: 100 } },
    "match:rematch": { session },
    "room:return-to-lobby": { session },
    "state:subscribe": { session },
  } satisfies Record<keyof typeof clientToServerPayloadSchemas, unknown>;

  for (const event of Object.keys(clientToServerPayloadSchemas) as Array<
    keyof typeof clientToServerPayloadSchemas
  >) {
    assert.equal(
      clientToServerPayloadSchemas[event].safeParse(payloads[event]).success,
      true,
      event,
    );
    assert.equal(
      clientToServerPayloadSchemas[event].safeParse({ ...payloads[event], extra: true }).success,
      false,
      `${event} rejects unknown keys`,
    );
    const response = ["room:create", "room:join", "session:resume"].includes(event)
      ? { session }
      : {};
    assert.equal(
      clientToServerResponseSchemas[event].safeParse(response).success,
      true,
      `${event} ack`,
    );
  }
  assert.equal(clientToServerPayloadSchemas["room:create"].safeParse({}).success, false);
  assert.equal(
    clientToServerPayloadSchemas["room:create"].safeParse({ name: "<bad>" }).success,
    false,
  );
  assert.equal(
    clientToServerPayloadSchemas["prompt:select"].safeParse({ session, prompt: "" }).success,
    false,
  );
  assert.equal(
    clientToServerPayloadSchemas["match:set-cycles"].safeParse({ session, cycles: "2" }).success,
    false,
  );
  assert.equal(
    clientToServerPayloadSchemas["ratings:submit"].safeParse({
      session,
      ratings: { drawing1: 100.1 },
    }).success,
    false,
  );
  assert.equal(
    clientToServerResponseSchemas["room:create"].safeParse({ session }).success,
    true,
  );
  assert.equal(
    clientToServerResponseSchemas["room:create"].safeParse({ session, extra: true }).success,
    false,
  );
});

test("server-to-client payloads reject malformed data and unknown keys", () => {
  assert.equal(serverToClientPayloadSchemas["state:update"].safeParse(view).success, true);
  assert.equal(
    serverToClientPayloadSchemas["state:update"].safeParse({ ...view, extra: true }).success,
    false,
  );
  assert.equal(
    serverToClientPayloadSchemas.error.safeParse({ code: "NETWORK", message: "offline" }).success,
    true,
  );
  assert.equal(
    serverToClientPayloadSchemas.error.safeParse({ code: "UNKNOWN", message: "offline" }).success,
    false,
  );
  assert.equal(playerViewSchema.safeParse({ ...view, phase: "UNKNOWN" }).success, false);
  assert.equal(playerViewSchema.safeParse({ ...view, cycles: 4 }).success, false);
});
