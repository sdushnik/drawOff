import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { Pool } from "pg";
import { MatchStateMachine } from "../src/match-state-machine.js";
import {
  databaseUrlFromEnvironment,
  DatabaseConfigurationError,
  KyselyGameStateRepository,
} from "../src/database/repository.js";
import { RoomService } from "../src/room-service.js";
import { activeDatabaseDialect, createTestDatabase } from "./database-test-fixture.js";

const dialect = activeDatabaseDialect();

function createGame(now: () => number) {
  let player = 0;
  const rooms = new RoomService({ now, generateId: () => `player-${++player}` });
  const host = rooms.createRoom("Host Artist");
  const artistOne = rooms.joinRoom(host.roomCode, "First Artist");
  const artistTwo = rooms.joinRoom(host.roomCode, "Second Artist");
  const sessions = [host, artistOne, artistTwo];
  sessions.forEach((session) => rooms.setConnected(session, true));
  const machine = new MatchStateMachine(rooms, {
    now,
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
    random: () => 0,
  });
  return { rooms, machine, host, artistOne, artistTwo, sessions };
}

async function save(
  repository: KyselyGameStateRepository,
  game: ReturnType<typeof createGame>,
) {
  await repository.replace({
    rooms: game.rooms.exportDurableState(),
    matches: game.machine.exportDurableState(),
  });
}

test("DATABASE_URL is mandatory and unsupported schemes are rejected safely", async () => {
  assert.throws(
    () => databaseUrlFromEnvironment({}),
    (error) => error instanceof DatabaseConfigurationError &&
      error.message === "DATABASE_URL must be configured.",
  );
  for (const value of ["", "sqlite:", "mysql://host/db", "http://host/db", "host/db",
    "postgresql://host", "postgres://host/#fragment"]) {
    assert.throws(
      () => KyselyGameStateRepository.open(value),
      (error) => error instanceof DatabaseConfigurationError &&
        error.message === "Database configuration is invalid or unavailable." &&
        (value === "" || !error.message.includes(value)),
    );
  }
  for (const protocol of ["postgres", "postgresql"]) {
    const secretUrl = `${protocol}://distinct-user:distinct-password@127.0.0.1:1/` +
      "drawoff_test_redaction?application_name=distinct-query";
    const repository = KyselyGameStateRepository.open(secretUrl);
    await assert.rejects(
      repository.migrate(),
      (error) => error instanceof DatabaseConfigurationError &&
        error.message === "Database migration failed." &&
        !JSON.stringify(error).includes("distinct"),
    );
    await repository.close();
  }
  const configuredPostgres = process.env["POSTGRES_TEST_DATABASE_URL"];
  if (configuredPostgres) {
    const postgresAlias = configuredPostgres.replace(/^postgresql:/, "postgres:");
    const repository = KyselyGameStateRepository.open(postgresAlias);
    await repository.migrate();
    const state = await repository.load();
    assert.ok(Array.isArray(state.rooms));
    assert.ok(Array.isArray(state.matches));
    await repository.close();
    const observer = new Pool({ connectionString: configuredPostgres, max: 1 });
    try {
      const active = await observer.query<{ connections: string }>(
        "select count(*)::text as connections from pg_stat_activity " +
          "where datname = current_database() and usename = current_user",
      );
      assert.equal(active.rows[0]?.connections, "1");
    } finally {
      await observer.end();
    }
  }
  const directory = mkdtempSync(join(tmpdir(), "drawoff-unavailable-"));
  const occupied = join(directory, "not-a-directory");
  writeFileSync(occupied, "occupied");
  try {
    assert.throws(
      () => KyselyGameStateRepository.open(`sqlite:${join(occupied, "state.sqlite")}`),
      (error) => error instanceof DatabaseConfigurationError &&
        !error.message.includes(occupied),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(`${dialect}: clean migrations are repeatable and persistence contains hashes, never raw tokens`, async () => {
  const database = await createTestDatabase("drawoff-db");
  let repository: KyselyGameStateRepository | undefined;
  try {
    repository = KyselyGameStateRepository.open(database.url);
    await repository.migrate();
    await repository.migrate();
    const game = createGame(() => 1_000);
    await save(repository, game);
    await repository.close();
    repository = undefined;

    let rows: Array<{ session_token_hash: string }>;
    let storedBytes: string;
    if (database.dialect === "sqlite") {
      const sqlite = new BetterSqlite3(database.filename!, { readonly: true });
      rows = sqlite.prepare("select session_token_hash from players").all() as typeof rows;
      sqlite.close();
      storedBytes = readFileSync(database.filename!).toString("latin1");
    } else {
      const pool = new Pool({ connectionString: database.url });
      try {
        rows = (await pool.query<{ session_token_hash: string }>(
          "select session_token_hash from players",
        )).rows;
        storedBytes = JSON.stringify((await Promise.all([
          pool.query("select * from rooms"),
          pool.query("select * from players"),
          pool.query("select * from match_states"),
        ])).map((result) => result.rows));
      } finally {
        await pool.end();
      }
    }
    assert.equal(rows.length, 3);
    assert.ok(rows.every(({ session_token_hash }) => session_token_hash.length === 44));
    for (const session of game.sessions) assert.equal(storedBytes.includes(session.token), false);
  } finally {
    await repository?.close();
    await database.cleanup();
  }
});

test(`${dialect}: rooms, private canvases, revisions, locks, and duplicate history survive restart`, async () => {
  const database = await createTestDatabase("drawoff-db");
  let now = 1_000;
  let repository = KyselyGameStateRepository.open(database.url);
  try {
    await repository.migrate();
    const game = createGame(() => now);
    game.machine.startMatch(game.host);
    now = 5_000;
    game.machine.tick();
    game.machine.selectPrompt(game.host, "lighthouse");
    const operation = { type: "clear", id: "persisted-clear" } as const;
    assert.equal(game.machine.sendDrawOps(game.artistOne, [operation]), true);
    assert.equal(game.machine.sendDrawOps(game.artistOne, [operation]), false);
    game.machine.submitCanvas(game.artistOne);
    await save(repository, game);
    await repository.close();

    repository = KyselyGameStateRepository.open(database.url);
    await repository.migrate();
    const durable = await repository.load();
    const restoredRooms = new RoomService({ now: () => now });
    restoredRooms.restoreDurableState(durable.rooms);
    const restoredMachine = new MatchStateMachine(restoredRooms, {
      now: () => now,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    restoredMachine.restoreDurableState(durable.matches);

    assert.equal(restoredRooms.getRoom(game.host.roomCode).players.every((p) => !p.connected), true);
    assert.deepEqual(restoredRooms.resumeSession(game.artistOne), game.artistOne);
    const artistView = restoredMachine.getPlayerView(game.artistOne);
    assert.equal(artistView.myCanvas?.canvas.rev, 1);
    assert.equal(artistView.myCanvas?.locked, true);
    const otherArtistView = restoredMachine.getPlayerView(game.artistTwo);
    assert.equal(otherArtistView.myCanvas?.canvas.rev, 0);
    assert.equal(otherArtistView.liveCanvases, null);
    const judgeView = restoredMachine.getPlayerView(game.host);
    assert.equal(judgeView.liveCanvases?.[0]?.canvas.rev, 1);
    assert.equal(judgeView.players.some((player) => player.id === game.artistOne.playerId), false);
  } finally {
    await repository.close();
    await database.cleanup();
  }
});

test(`${dialect}: restart immediately applies an offline-expired authoritative deadline`, async () => {
  const database = await createTestDatabase("drawoff-db");
  let now = 1_000;
  let repository = KyselyGameStateRepository.open(database.url);
  try {
    await repository.migrate();
    const game = createGame(() => now);
    game.machine.startMatch(game.host);
    await save(repository, game);
    await repository.close();

    now = 6_000;
    repository = KyselyGameStateRepository.open(database.url);
    await repository.migrate();
    const durable = await repository.load();
    const rooms = new RoomService({ now: () => now });
    rooms.restoreDurableState(durable.rooms);
    const machine = new MatchStateMachine(rooms, {
      now: () => now,
      random: () => 0,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    machine.restoreDurableState(durable.matches);
    const recovered = machine.getPlayerView(game.host);
    assert.equal(recovered.phase, "WORD_SELECTION");
    assert.equal(recovered.deadline, 35_000);
    assert.ok(recovered.suggestions?.length === 3);
  } finally {
    await repository.close();
    await database.cleanup();
  }
});

test(`${dialect}: constraints roll back duplicate aggregates and expired-room deletion cascades`, async () => {
  const database = await createTestDatabase("drawoff-db");
  const repository = KyselyGameStateRepository.open(database.url);
  try {
    await repository.migrate();
    const game = createGame(() => 1_000);
    await save(repository, game);
    const original = await repository.load();

    await assert.rejects(
      repository.replace({
        rooms: [original.rooms[0]!, original.rooms[0]!],
        matches: [],
      }),
      /could not be saved/i,
    );
    assert.deepEqual(await repository.load(), original);

    await repository.replace({ rooms: [], matches: [] });
    assert.deepEqual(await repository.load(), { rooms: [], matches: [] });
  } finally {
    await repository.close();
    await database.cleanup();
  }
});

test(`${dialect}: ratings remain idempotent after restart and rematch clears only match state`, async () => {
  const database = await createTestDatabase("drawoff-db");
  let now = 1_000;
  let repository = KyselyGameStateRepository.open(database.url);
  try {
    await repository.migrate();
    const initial = createGame(() => now);
    initial.rooms.setCycles(initial.host, 1);
    initial.machine.startMatch(initial.host);
    now = initial.machine.getPlayerView(initial.host).deadline!;
    initial.machine.tick();
    initial.machine.selectPrompt(initial.host, "lighthouse");
    now = initial.machine.getPlayerView(initial.host).deadline!;
    initial.machine.tick();
    const ratings = { "Drawing 1": 40, "Drawing 2": 40 };
    initial.machine.submitRatings(initial.host, ratings);
    await save(repository, initial);
    await repository.close();

    repository = KyselyGameStateRepository.open(database.url);
    await repository.migrate();
    const durable = await repository.load();
    const rooms = new RoomService({ now: () => now });
    rooms.restoreDurableState(durable.rooms);
    const machine = new MatchStateMachine(rooms, {
      now: () => now,
      random: () => 0,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    machine.restoreDurableState(durable.matches);

    machine.submitRatings(initial.host, ratings);
    assert.equal(machine.getPlayerView(initial.host).match?.scores[initial.artistOne.playerId], 40);

    const sessionsById = new Map(initial.sessions.map((session) => [session.playerId, session]));
    for (let round = 1; round < 3; round += 1) {
      now = machine.getPlayerView(initial.host).deadline!;
      machine.tick();
      now = machine.getPlayerView(initial.host).deadline!;
      machine.tick();
      const judgeId = machine.getPlayerView(initial.host).match!.judgeId;
      const judge = sessionsById.get(judgeId)!;
      machine.selectPrompt(judge, `round ${round + 1}`);
      now = machine.getPlayerView(initial.host).deadline!;
      machine.tick();
      machine.submitRatings(judge, ratings);
    }
    now = machine.getPlayerView(initial.host).deadline!;
    machine.tick();
    assert.equal(machine.getPlayerView(initial.host).phase, "FINAL_RESULT");

    machine.rematch(initial.host);
    await repository.replace({
      rooms: rooms.exportDurableState(),
      matches: machine.exportDurableState(),
    });
    const reset = await repository.load();
    assert.equal(reset.rooms[0]?.matchInProgress, false);
    assert.equal(reset.rooms[0]?.cycles, 1);
    assert.equal(reset.rooms[0]?.players.length, 3);
    assert.equal(reset.matches.length, 0);
    assert.deepEqual(rooms.resumeSession(initial.host), initial.host);
  } finally {
    await repository.close();
    await database.cleanup();
  }
});
