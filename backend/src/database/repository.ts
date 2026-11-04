import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  Kysely,
  Migrator,
  SqliteDialect,
} from "kysely";
import type { DurableMatchProgress } from "../match-state-machine.js";
import type { DurableRoomState, MatchSchedule } from "../room-service.js";
import { DrawOffMigrationProvider } from "./migrations.js";
import type { DatabaseSchema } from "./types.js";

export interface DurableGameState {
  rooms: DurableRoomState[];
  matches: DurableMatchProgress[];
}

export interface GameStateRepository {
  migrate(): Promise<void>;
  load(): Promise<DurableGameState>;
  replace(state: DurableGameState): Promise<void>;
  close(): Promise<void>;
}

export class DatabaseConfigurationError extends Error {
  constructor(message = "Database configuration is invalid or unavailable.") {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

function sqliteFilename(databaseUrl: string): string {
  if (!databaseUrl.startsWith("sqlite:")) throw new DatabaseConfigurationError();
  const value = databaseUrl.slice("sqlite:".length);
  if (value === ":memory:") return value;
  if (value.trim() === "" || value.includes("\0")) throw new DatabaseConfigurationError();
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export function databaseUrlFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const databaseUrl = environment["DATABASE_URL"];
  if (!databaseUrl) throw new DatabaseConfigurationError("DATABASE_URL must be configured.");
  return databaseUrl;
}

export class KyselyGameStateRepository implements GameStateRepository {
  private constructor(private readonly db: Kysely<DatabaseSchema>) {}

  static open(databaseUrl: string): KyselyGameStateRepository {
    try {
      const filename = sqliteFilename(databaseUrl);
      if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
      const sqlite = new BetterSqlite3(filename);
      sqlite.pragma("foreign_keys = ON");
      sqlite.pragma("journal_mode = WAL");
      return new KyselyGameStateRepository(new Kysely<DatabaseSchema>({
        dialect: new SqliteDialect({ database: sqlite }),
      }));
    } catch (error) {
      if (error instanceof DatabaseConfigurationError) throw error;
      throw new DatabaseConfigurationError();
    }
  }

  async migrate(): Promise<void> {
    try {
      const migrator = new Migrator({
        db: this.db,
        provider: new DrawOffMigrationProvider(),
      });
      const result = await migrator.migrateToLatest();
      if (result.error) throw result.error;
    } catch {
      throw new DatabaseConfigurationError("Database migration failed.");
    }
  }

  async load(): Promise<DurableGameState> {
    try {
      const [rooms, players, matches] = await Promise.all([
        this.db.selectFrom("rooms").selectAll().orderBy("code").execute(),
        this.db.selectFrom("players").selectAll()
          .orderBy("room_code").orderBy("roster_position").execute(),
        this.db.selectFrom("match_states").selectAll().execute(),
      ]);
      return {
        rooms: rooms.map((room) => ({
          code: room.code,
          hostId: room.host_id,
          players: players
            .filter((player) => player.room_code === room.code)
            .map((player) => ({
              id: player.id,
              name: player.name,
              isHost: player.is_host === 1,
              sessionTokenHash: player.session_token_hash,
            })),
          matchInProgress: room.match_in_progress === 1,
          cycles: room.cycles as 1 | 2 | 3,
          matchSchedule: room.match_schedule_json
            ? JSON.parse(room.match_schedule_json) as MatchSchedule
            : null,
          notice: room.notice,
          expiresAt: Number(room.expires_at),
        })),
        matches: matches.map((match) =>
          JSON.parse(match.state_json) as DurableMatchProgress),
      };
    } catch {
      throw new RoomPersistenceError();
    }
  }

  async replace(state: DurableGameState): Promise<void> {
    try {
      await this.db.transaction().execute(async (transaction) => {
        await transaction.deleteFrom("match_states").execute();
        await transaction.deleteFrom("players").execute();
        await transaction.deleteFrom("rooms").execute();
        const now = Date.now();
        for (const room of state.rooms) {
          await transaction.insertInto("rooms").values({
            code: room.code,
            host_id: room.hostId,
            cycles: room.cycles,
            match_in_progress: room.matchInProgress ? 1 : 0,
            match_schedule_json: room.matchSchedule ? JSON.stringify(room.matchSchedule) : null,
            notice: room.notice,
            expires_at: room.expiresAt,
            updated_at: now,
          }).execute();
          if (room.players.length > 0) {
            await transaction.insertInto("players").values(room.players.map((player, index) => ({
              room_code: room.code,
              id: player.id,
              name: player.name,
              is_host: player.isHost ? 1 : 0,
              roster_position: index,
              session_token_hash: player.sessionTokenHash,
            }))).execute();
          }
        }
        for (const match of state.matches) {
          await transaction.insertInto("match_states").values({
            room_code: match.roomCode,
            state_json: JSON.stringify(match),
            updated_at: now,
          }).execute();
        }
      });
    } catch {
      throw new RoomPersistenceError();
    }
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}

export class RoomPersistenceError extends Error {
  constructor() {
    super("The room state could not be saved.");
    this.name = "RoomPersistenceError";
  }
}
