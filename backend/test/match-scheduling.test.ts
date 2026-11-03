import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cycles, Session } from "@drawoff/contracts";
import {
  getMatchRoundAssignment,
  RoomService,
  RoomServiceError,
} from "../src/room-service.js";

function createService() {
  let nextId = 0;
  return new RoomService({
    generateId: () => `player-${++nextId}`,
  });
}

for (const playerCount of [3, 5, 8]) {
  for (const cycles of [1, 2, 3] as const) {
    test(`${playerCount} players rotate fairly for ${cycles} cycle(s)`, () => {
      const service = createService();
      const host = service.createRoom("Host");
      const sessions: Session[] = [host];
      for (let index = 1; index < playerCount; index += 1) {
        sessions.push(service.joinRoom(host.roomCode, `Player ${index}`));
      }
      sessions.forEach((session) => service.setConnected(session, true));
      service.setCycles(host, cycles);
      service.startMatch(host);

      const snapshot = service.getRoom(host.roomCode);
      const schedule = snapshot.matchSchedule;
      assert.ok(schedule);
      const order = sessions.map(({ playerId }) => playerId);
      assert.deepEqual(schedule.order, order);
      assert.equal(schedule.cycles, cycles);
      assert.equal(schedule.totalRounds, playerCount * cycles);
      assert.equal(snapshot.matchInProgress, true);

      const judgeCounts = new Map(order.map((playerId) => [playerId, 0]));
      const artistCounts = new Map(order.map((playerId) => [playerId, 0]));
      for (let roundIndex = 0; roundIndex < schedule.totalRounds; roundIndex += 1) {
        const assignment = getMatchRoundAssignment(schedule, roundIndex);
        const expectedJudge = order[roundIndex % playerCount]!;
        assert.equal(assignment.judgeId, expectedJudge);
        assert.deepEqual(
          assignment.artistIds,
          order.filter((playerId) => playerId !== expectedJudge),
        );
        judgeCounts.set(
          assignment.judgeId,
          judgeCounts.get(assignment.judgeId)! + 1,
        );
        assignment.artistIds.forEach((playerId) => {
          artistCounts.set(playerId, artistCounts.get(playerId)! + 1);
        });
      }

      for (const playerId of order) {
        assert.equal(judgeCounts.get(playerId), cycles);
        assert.equal(artistCounts.get(playerId), (playerCount - 1) * cycles);
      }

      const firstRound = getMatchRoundAssignment(schedule, 0);
      sessions.forEach((session) => {
        const view = service.getLobbyView(session);
        assert.equal(view.matchStarted, true);
        assert.deepEqual(view.match?.order, order);
        assert.equal(view.match?.roundIndex, 0);
        assert.equal(view.match?.totalRounds, playerCount * cycles);
        assert.equal(view.match?.cycle, 1);
        assert.equal(view.match?.judgeId, firstRound.judgeId);
        assert.deepEqual(view.match?.artistIds, firstRound.artistIds);
        assert.equal(
          view.role,
          session.playerId === firstRound.judgeId ? "judge" : "artist",
        );
      });
    });
  }
}

test("start rejects fewer than three connected players and invalid cycle counts", () => {
  for (const connectedCount of [0, 1, 2]) {
    const service = createService();
    const host = service.createRoom("Host");
    const guest = service.joinRoom(host.roomCode, "Guest");
    const third = service.joinRoom(host.roomCode, "Third");
    [host, guest, third].forEach((session, index) => {
      service.setConnected(session, index < connectedCount);
    });

    assert.throws(
      () => service.startMatch(host),
      (error: unknown) =>
        error instanceof RoomServiceError && error.code === "NOT_ENOUGH_PLAYERS",
    );
    assert.equal(service.getRoom(host.roomCode).matchInProgress, false);
    assert.equal(service.getRoom(host.roomCode).matchSchedule, null);
    assert.equal(service.getLobbyView(host).match, null);

    [host, guest, third].forEach((session) => service.setConnected(session, true));
    assert.throws(
      () => service.setCycles(host, 4 as Cycles),
      (error: unknown) =>
        error instanceof RoomServiceError && error.code === "INVALID_INPUT",
    );
    service.startMatch(host);
    assert.equal(service.getRoom(host.roomCode).matchSchedule?.cycles, 1);
  }

  assert.throws(
    () => getMatchRoundAssignment(
      { order: ["one", "two", "three"], cycles: 1, totalRounds: 3 },
      -1,
    ),
    RangeError,
  );
  assert.throws(
    () => getMatchRoundAssignment(
      { order: ["one", "two", "three"], cycles: 1, totalRounds: 3 },
      3,
    ),
    RangeError,
  );
});

test("disconnects and lobby membership changes never reorder the frozen match schedule", () => {
  const service = createService();
  const sessions = [service.createRoom("Host")];
  for (let index = 1; index < 5; index += 1) {
    sessions.push(service.joinRoom(sessions[0]!.roomCode, `Player ${index}`));
  }
  sessions.forEach((session) => service.setConnected(session, true));
  service.setCycles(sessions[0]!, 2);
  service.startMatch(sessions[0]!);
  const roomCode = sessions[0]!.roomCode;
  const originalSchedule = service.getRoom(roomCode).matchSchedule;
  assert.ok(originalSchedule);

  service.setConnected(sessions[1]!, false);
  assert.throws(
    () => service.joinRoom(roomCode, "Late player"),
    (error: unknown) =>
      error instanceof RoomServiceError && error.code === "MATCH_IN_PROGRESS",
  );
  service.leaveRoom(sessions[2]!);
  assert.deepEqual(service.getRoom(roomCode).matchSchedule, originalSchedule);

  service.setConnected(sessions[1]!, true);
  for (const session of [sessions[0]!, sessions[1]!, sessions[3]!, sessions[4]!]) {
    const view = service.getLobbyView(session);
    assert.deepEqual(view.match?.order, originalSchedule.order);
    assert.equal(view.match?.totalRounds, originalSchedule.totalRounds);
    assert.equal(view.match?.judgeId, originalSchedule.order[0]);
    assert.equal(
      view.role,
      session.playerId === originalSchedule.order[0] ? "judge" : "artist",
    );
  }
});
