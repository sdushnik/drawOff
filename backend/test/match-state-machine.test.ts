import assert from "node:assert/strict";
import { test } from "node:test";
import type { Phase, Session } from "@drawoff/contracts";
import {
  MATCH_PHASE_DURATIONS_MS,
  MatchStateMachine,
} from "../src/match-state-machine.js";
import { RoomService, RoomServiceError } from "../src/room-service.js";

interface FakeTimer {
  callback: () => void;
  dueAt: number;
}

function createFixture(playerCount = 3) {
  let now = 1_000;
  let nextPlayer = 0;
  let nextTimer = 0;
  const activeTimers = new Map<number, FakeTimer>();
  const timerHistory = new Map<number, FakeTimer>();
  const transitions: string[] = [];
  const rooms = new RoomService({
    now: () => now,
    generateId: () => `player-${++nextPlayer}`,
  });
  const host = rooms.createRoom("Player 0");
  const sessions: Session[] = [host];
  for (let index = 1; index < playerCount; index += 1) {
    sessions.push(rooms.joinRoom(host.roomCode, `Player ${index}`));
  }
  sessions.forEach((session) => rooms.setConnected(session, true));

  const machine = new MatchStateMachine(rooms, {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = ++nextTimer;
      const timer = { callback, dueAt: now + delayMs };
      activeTimers.set(id, timer);
      timerHistory.set(id, timer);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      activeTimers.delete(handle as unknown as number);
    },
    onTransition: (roomCode) => transitions.push(roomCode),
  });

  return {
    rooms,
    machine,
    sessions,
    transitions,
    activeTimers,
    timerHistory,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    setTime(value: number) {
      now = value;
    },
    runTimer(id: number) {
      const timer = activeTimers.get(id);
      assert.ok(timer, `timer ${id} is active`);
      activeTimers.delete(id);
      timer.callback();
    },
    runHistoricalTimer(id: number) {
      const timer = timerHistory.get(id);
      assert.ok(timer, `timer ${id} was created`);
      timer.callback();
    },
    view(session = host) {
      return machine.getPlayerView(session);
    },
    start() {
      machine.startMatch(host);
    },
    host,
  };
}

function expectRoomError(
  action: () => unknown,
  code: RoomServiceError["code"],
): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof RoomServiceError && error.code === code,
  );
}

function advanceToWordSelection(fixture: ReturnType<typeof createFixture>): void {
  fixture.start();
  fixture.setTime(fixture.now + MATCH_PHASE_DURATIONS_MS.ROLE_REVEAL);
  fixture.machine.tick();
  assert.equal(fixture.view().phase, "WORD_SELECTION");
}

function advanceToJudging(fixture: ReturnType<typeof createFixture>): void {
  advanceToWordSelection(fixture);
  fixture.machine.selectPrompt(fixture.host, "lighthouse");
  const drawingDeadline = fixture.view().deadline;
  assert.ok(drawingDeadline !== null);
  fixture.setTime(drawingDeadline);
  fixture.machine.tick();
  assert.equal(fixture.view().phase, "JUDGING");
}

function transitionFromRoundResult(
  fixture: ReturnType<typeof createFixture>,
): Phase {
  const deadline = fixture.view().deadline;
  assert.ok(deadline !== null);
  fixture.setTime(deadline);
  fixture.machine.tick();
  return fixture.view().phase;
}

test("server clock drives the normal phase sequence through the final result", () => {
  const fixture = createFixture();
  fixture.start();

  let view = fixture.view();
  assert.equal(view.phase, "ROLE_REVEAL");
  assert.equal(view.deadline, 5_000);
  assert.equal(view.role, "judge");

  fixture.setTime(view.deadline!);
  fixture.machine.tick();
  view = fixture.view();
  assert.equal(view.phase, "WORD_SELECTION");
  assert.equal(view.deadline, 35_000);

  fixture.machine.selectPrompt(fixture.host, "lighthouse");
  view = fixture.view();
  assert.equal(view.phase, "DRAWING");
  assert.equal(view.deadline, 65_000);

  fixture.setTime(view.deadline!);
  fixture.machine.tick();
  view = fixture.view();
  assert.equal(view.phase, "JUDGING");
  assert.equal(view.deadline, 110_000);

  fixture.machine.finishJudging(fixture.host);
  view = fixture.view();
  assert.equal(view.phase, "ROUND_RESULT");
  assert.equal(view.deadline, 77_000);
  assert.equal(transitionFromRoundResult(fixture), "ROLE_REVEAL");
  assert.equal(fixture.view().match?.roundIndex, 1);
  assert.equal(fixture.view(fixture.sessions[1]!).role, "judge");

  for (const expectedNext of ["ROLE_REVEAL", "FINAL_RESULT"] as const) {
    const roleRevealDeadline = fixture.view().deadline;
    assert.ok(roleRevealDeadline !== null);
    fixture.setTime(roleRevealDeadline);
    fixture.machine.tick();
    assert.equal(fixture.view().phase, "WORD_SELECTION");
    const currentJudge = fixture.sessions[fixture.view().match!.roundIndex]!;
    fixture.machine.selectPrompt(currentJudge, "lighthouse");
    const drawingDeadline = fixture.view().deadline;
    assert.ok(drawingDeadline !== null);
    fixture.setTime(drawingDeadline);
    fixture.machine.tick();
    fixture.machine.finishJudging(currentJudge);
    assert.equal(transitionFromRoundResult(fixture), expectedNext);
    if (expectedNext === "ROLE_REVEAL") {
      assert.equal(fixture.view().match?.roundIndex, 2);
      assert.equal(fixture.view(fixture.sessions[2]!).role, "judge");
    }
  }

  view = fixture.view();
  assert.equal(view.phase, "FINAL_RESULT");
  assert.equal(view.deadline, null);
  assert.equal(view.role, null);
});

test("only the current Judge can cross word-selection and judging boundaries", () => {
  const fixture = createFixture();
  advanceToWordSelection(fixture);

  const before = fixture.view();
  expectRoomError(
    () => fixture.machine.selectPrompt(fixture.sessions[1]!, "lighthouse"),
    "FORBIDDEN",
  );
  assert.deepEqual(fixture.view(), before);

  fixture.machine.selectPrompt(fixture.host, "lighthouse");
  const drawing = fixture.view();
  expectRoomError(() => fixture.machine.selectPrompt(fixture.host, "lighthouse"), "WRONG_PHASE");
  assert.deepEqual(fixture.view(), drawing);

  const drawingDeadline = drawing.deadline!;
  fixture.setTime(drawingDeadline);
  fixture.machine.tick();
  const judging = fixture.view();
  expectRoomError(
    () => fixture.machine.finishJudging(fixture.sessions[1]!),
    "FORBIDDEN",
  );
  assert.deepEqual(fixture.view(), judging);

  fixture.machine.finishJudging(fixture.host);
  const result = fixture.view();
  expectRoomError(() => fixture.machine.finishJudging(fixture.host), "WRONG_PHASE");
  assert.deepEqual(fixture.view(), result);
});

test("word-selection mutations succeed immediately before but fail at and after deadline", () => {
  const before = createFixture();
  advanceToWordSelection(before);
  const wordDeadline = before.view().deadline!;
  before.setTime(wordDeadline - 1);
  before.machine.selectPrompt(before.host, "lighthouse");
  assert.equal(before.view().phase, "DRAWING");
  assert.equal(before.view().deadline, wordDeadline - 1 + MATCH_PHASE_DURATIONS_MS.DRAWING);

  for (const offset of [0, 1]) {
    const fixture = createFixture();
    advanceToWordSelection(fixture);
    fixture.setTime(fixture.view().deadline! + offset);
    const unchanged = fixture.view();
    expectRoomError(
      () => fixture.machine.selectPrompt(fixture.host, "lighthouse"),
      "DEADLINE_PASSED",
    );
    assert.deepEqual(fixture.view(), unchanged);
  }
});

test("judging mutations succeed immediately before but fail at and after deadline", () => {
  const before = createFixture();
  advanceToJudging(before);
  const judgingDeadline = before.view().deadline!;
  before.setTime(judgingDeadline - 1);
  before.machine.finishJudging(before.host);
  assert.equal(before.view().phase, "ROUND_RESULT");
  assert.equal(
    before.view().deadline,
    judgingDeadline - 1 + MATCH_PHASE_DURATIONS_MS.ROUND_RESULT,
  );

  for (const offset of [0, 1]) {
    const fixture = createFixture();
    advanceToJudging(fixture);
    fixture.setTime(fixture.view().deadline! + offset);
    const unchanged = fixture.view();
    expectRoomError(() => fixture.machine.finishJudging(fixture.host), "DEADLINE_PASSED");
    assert.deepEqual(fixture.view(), unchanged);
  }
});

test("invalid identity and nonmember mutations leave the match unchanged", () => {
  const fixture = createFixture();
  advanceToWordSelection(fixture);
  const unchanged = fixture.view();
  expectRoomError(
    () =>
      fixture.machine.selectPrompt({
        ...fixture.host,
        token: "not-the-session-token",
      }, "lighthouse"),
    "UNAUTHORIZED",
  );
  assert.deepEqual(fixture.view(), unchanged);

  const anotherRoom = fixture.rooms.createRoom("Other host");
  expectRoomError(
    () => fixture.machine.selectPrompt(anotherRoom, "lighthouse"),
    "FORBIDDEN",
  );
  assert.deepEqual(fixture.view(), unchanged);
});

test("stale timer callbacks and repeated deadline delivery apply each transition once", () => {
  const fixture = createFixture();
  fixture.start();
  const firstTimerId = [...fixture.activeTimers.keys()][0]!;
  fixture.setTime(fixture.view().deadline!);
  fixture.runTimer(firstTimerId);
  assert.equal(fixture.view().phase, "WORD_SELECTION");
  const updateCount = fixture.transitions.length;

  fixture.runHistoricalTimer(firstTimerId);
  fixture.machine.tick();
  fixture.machine.tick();
  assert.equal(fixture.view().phase, "WORD_SELECTION");
  assert.equal(fixture.transitions.length, updateCount);

  fixture.machine.selectPrompt(fixture.host, "lighthouse");
  const drawingTimerId = [...fixture.activeTimers.keys()][0]!;
  const drawingDeadline = fixture.view().deadline!;
  fixture.setTime(drawingDeadline);
  fixture.machine.tick();
  const afterTickCount = fixture.transitions.length;
  fixture.runHistoricalTimer(drawingTimerId);
  assert.equal(fixture.view().phase, "JUDGING");
  assert.equal(fixture.transitions.length, afterTickCount);
});

test("timers recheck the injected server clock if delivered early", () => {
  const fixture = createFixture();
  fixture.start();
  const firstTimerId = [...fixture.activeTimers.keys()][0]!;

  fixture.setTime(fixture.view().deadline! - 1);
  fixture.runTimer(firstTimerId);
  assert.equal(fixture.view().phase, "ROLE_REVEAL");

  const rescheduledTimerId = [...fixture.activeTimers.keys()][0]!;
  fixture.setTime(fixture.view().deadline!);
  fixture.runTimer(rescheduledTimerId);
  assert.equal(fixture.view().phase, "WORD_SELECTION");
});

test("late timer delivery preserves the scheduled phase boundary instead of extending it", () => {
  const fixture = createFixture();
  fixture.start();
  const roleRevealDeadline = fixture.view().deadline!;
  const timerId = [...fixture.activeTimers.keys()][0]!;

  fixture.setTime(roleRevealDeadline + 500);
  fixture.runTimer(timerId);
  assert.equal(fixture.view().phase, "WORD_SELECTION");
  assert.equal(
    fixture.view().deadline,
    roleRevealDeadline + MATCH_PHASE_DURATIONS_MS.WORD_SELECTION,
  );
});

test("the server clock rejects late actions without accepting client timestamps", () => {
  const fixture = createFixture();
  advanceToWordSelection(fixture);
  fixture.setTime(fixture.view().deadline!);
  const before = fixture.view();
  expectRoomError(
    () => fixture.machine.selectPrompt(fixture.host, "lighthouse"),
    "DEADLINE_PASSED",
  );
  assert.deepEqual(fixture.view(), before);
});

test("word-selection suggestions are distinct and private until the Judge finalizes a prompt", () => {
  const fixture = createFixture();
  advanceToWordSelection(fixture);

  const judgeView = fixture.view(fixture.host);
  const artistView = fixture.view(fixture.sessions[1]!);
  assert.equal(judgeView.suggestions?.length, 3);
  assert.equal(new Set(judgeView.suggestions).size, 3);
  assert.equal(judgeView.prompt, null);
  assert.equal(artistView.suggestions, null);
  assert.equal(artistView.prompt, null);

  fixture.machine.selectPrompt(fixture.host, "  a \n  bright   kite  ");
  assert.equal(fixture.view(fixture.host).prompt, "a bright kite");
  assert.equal(fixture.view(fixture.sessions[1]!).prompt, "a bright kite");
  assert.equal(fixture.view(fixture.sessions[1]!).suggestions, null);
});

test("custom prompts accept normalized lengths 1 and 40 and reject invalid text without mutation", () => {
  for (const prompt of [" x ", ` ${"x".repeat(40)} `]) {
    const fixture = createFixture();
    advanceToWordSelection(fixture);
    fixture.machine.selectPrompt(fixture.host, prompt);
    assert.equal(fixture.view().phase, "DRAWING");
    assert.equal(fixture.view().prompt, prompt.trim().replace(/\s+/g, " "));
  }

  for (const prompt of ["", " \n ", "x".repeat(41), "<bold>", "a{b}", null]) {
    const fixture = createFixture();
    advanceToWordSelection(fixture);
    const before = fixture.view();
    expectRoomError(
      () => fixture.machine.selectPrompt(fixture.host, prompt),
      "INVALID_INPUT",
    );
    assert.deepEqual(fixture.view(), before);
  }
});

test("word-selection timeout chooses a displayed suggestion and advances exactly once", () => {
  const fixture = createFixture();
  advanceToWordSelection(fixture);
  const suggestions = fixture.view().suggestions;
  assert.equal(suggestions?.length, 3);
  const wordSelectionTimer = [...fixture.activeTimers.keys()][0]!;
  const updateCount = fixture.transitions.length;

  fixture.setTime(fixture.view().deadline!);
  fixture.runTimer(wordSelectionTimer);

  const drawing = fixture.view();
  assert.equal(drawing.phase, "DRAWING");
  assert.ok(suggestions?.includes(drawing.prompt!));
  assert.equal(fixture.transitions.length, updateCount + 1);
  fixture.runHistoricalTimer(wordSelectionTimer);
  fixture.machine.tick();
  assert.equal(fixture.view().phase, "DRAWING");
  assert.equal(fixture.transitions.length, updateCount + 1);
});
