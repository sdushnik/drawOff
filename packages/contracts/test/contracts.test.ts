import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOps,
  clientToServerPayloadSchemas,
  clientToServerResponseSchemas,
  cyclesSchema,
  drawOpSchema,
  emptyCanvas,
  MAX_ACTIONS_PER_CANVAS,
  MAX_OPS_PER_BATCH,
  MAX_POINTS_PER_OP,
  MAX_POINTS_PER_STROKE,
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

test("bounded names, prompts, operation IDs, strokes, and drawing coordinates accept inclusive limits", () => {
  for (const name of ["ab", "a".repeat(20)]) {
    assert.equal(
      clientToServerPayloadSchemas["room:create"].safeParse({ name }).success,
      true,
      `player name length ${name.length}`,
    );
  }
  for (const name of ["a", "a".repeat(21)]) {
    assert.equal(
      clientToServerPayloadSchemas["room:create"].safeParse({ name }).success,
      false,
      `player name length ${name.length}`,
    );
  }

  for (const prompt of ["a", "a".repeat(40)]) {
    assert.equal(
      clientToServerPayloadSchemas["prompt:select"].safeParse({ session, prompt }).success,
      true,
      `prompt length ${prompt.length}`,
    );
  }
  for (const prompt of ["", "a".repeat(41)]) {
    assert.equal(
      clientToServerPayloadSchemas["prompt:select"].safeParse({ session, prompt }).success,
      false,
      `prompt length ${prompt.length}`,
    );
  }

  for (const id of ["x", "x".repeat(64)]) {
    assert.equal(drawOpSchema.safeParse({ type: "clear", id }).success, true, `ID length ${id.length}`);
  }
  for (const id of ["", "x".repeat(65)]) {
    assert.equal(drawOpSchema.safeParse({ type: "clear", id }).success, false, `ID length ${id.length}`);
  }

  const stroke = (size: number, points = [0, 0]) =>
    drawOpSchema.safeParse({
      type: "stroke",
      id: "s1",
      tool: "pen",
      color: "#000000",
      size,
      points,
    }).success;
  for (const size of [1, 60]) assert.equal(stroke(size), true, `stroke size ${size}`);
  for (const size of [0, 61]) assert.equal(stroke(size), false, `stroke size ${size}`);

  assert.equal(stroke(1, [0, 0, 600, 450]), true, "stroke coordinate endpoints");
  assert.equal(stroke(1, Array.from({ length: 600 }, () => 1)), true, "600 stroke coordinates");
  assert.equal(stroke(1, Array.from({ length: 602 }, () => 1)), false, "602 stroke coordinates");
  for (const points of [
    [-0.1, 0],
    [600.1, 0],
    [0, -0.1],
    [0, 450.1],
  ]) {
    assert.equal(stroke(1, points), false, `stroke rejects coordinates ${points}`);
  }

  const fill = (x: number, y: number) =>
    drawOpSchema.safeParse({ type: "fill", id: "f1", x, y, color: "#000000" }).success;
  assert.equal(fill(0, 0), true, "fill lower coordinate endpoints");
  assert.equal(fill(600, 450), true, "fill upper coordinate endpoints");
  for (const [x, y] of [
    [-0.1, 0],
    [600.1, 0],
    [0, -0.1],
    [0, 450.1],
  ]) {
    assert.equal(fill(x, y), false, `fill rejects coordinates ${x},${y}`);
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

test("drawing batches accept 60 operations and reject 61 without truncation", () => {
  const batch = (length: number) => ({
    session,
    ops: Array.from({ length }, (_, index) => ({ type: "clear", id: `op-${index}` })),
  });
  assert.equal(clientToServerPayloadSchemas["drawing:ops"].safeParse(batch(60)).success, true);
  assert.equal(clientToServerPayloadSchemas["drawing:ops"].safeParse(batch(61)).success, false);
});

test("canvas history and continued strokes stop at their exact documented bounds", () => {
  assert.deepEqual(
    [MAX_OPS_PER_BATCH, MAX_POINTS_PER_OP, MAX_POINTS_PER_STROKE, MAX_ACTIONS_PER_CANVAS],
    [60, 600, 20_000, 4_000],
  );

  const history = emptyCanvas();
  for (let start = 0; start < MAX_ACTIONS_PER_CANVAS; start += MAX_OPS_PER_BATCH) {
    const length = Math.min(MAX_OPS_PER_BATCH, MAX_ACTIONS_PER_CANVAS - start);
    assert.equal(
      applyOps(
        history,
        Array.from({ length }, (_, index) => ({ type: "clear", id: `clear-${start + index}` })),
      ),
      length,
    );
  }
  assert.equal(history.actions.length, MAX_ACTIONS_PER_CANVAS);
  assert.equal(applyOps(history, [{ type: "clear", id: "over-history" }]), 0);

  const stroke = emptyCanvas();
  const pointChunk = Array.from({ length: 500 }, () => 1);
  for (let offset = 0; offset < MAX_POINTS_PER_STROKE; offset += pointChunk.length) {
    assert.equal(
      applyOps(stroke, [{
        type: "stroke",
        id: "continued",
        tool: "pen",
        color: "#000000",
        size: 2,
        points: pointChunk,
      }]),
      1,
    );
  }
  assert.equal(stroke.actions[0]?.type === "stroke" && stroke.actions[0].points.length, 20_000);
  assert.equal(
    applyOps(stroke, [{
      type: "stroke",
      id: "continued",
      tool: "pen",
      color: "#000000",
      size: 2,
      points: [1, 1],
    }]),
    0,
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
  assert.equal(
    playerViewSchema.safeParse({ ...view, drawingStatus: { ready: 3, total: 2 } }).success,
    false,
  );
});
