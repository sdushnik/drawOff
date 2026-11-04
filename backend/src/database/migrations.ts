import type { Kysely, Migration, MigrationProvider } from "kysely";
import type { DatabaseSchema } from "./types.js";

const initialPersistence: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("rooms")
      .addColumn("code", "varchar(6)", (column) => column.primaryKey())
      .addColumn("host_id", "varchar(128)", (column) => column.notNull())
      .addColumn("cycles", "integer", (column) => column.notNull())
      .addColumn("match_in_progress", "integer", (column) => column.notNull())
      .addColumn("match_schedule_json", "text")
      .addColumn("notice", "text")
      .addColumn("expires_at", "bigint", (column) => column.notNull())
      .addColumn("updated_at", "bigint", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("players")
      .addColumn("room_code", "varchar(6)", (column) =>
        column.notNull().references("rooms.code").onDelete("cascade"))
      .addColumn("id", "varchar(128)", (column) => column.notNull())
      .addColumn("name", "varchar(20)", (column) => column.notNull())
      .addColumn("is_host", "integer", (column) => column.notNull())
      .addColumn("roster_position", "integer", (column) => column.notNull())
      .addColumn("session_token_hash", "varchar(128)", (column) => column.notNull())
      .addPrimaryKeyConstraint("players_primary_key", ["room_code", "id"])
      .execute();

    await db.schema
      .createIndex("players_room_position_unique")
      .on("players")
      .columns(["room_code", "roster_position"])
      .unique()
      .execute();

    await db.schema
      .createTable("match_states")
      .addColumn("room_code", "varchar(6)", (column) =>
        column.primaryKey().references("rooms.code").onDelete("cascade"))
      .addColumn("state_json", "text", (column) => column.notNull())
      .addColumn("updated_at", "bigint", (column) => column.notNull())
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("match_states").execute();
    await db.schema.dropTable("players").execute();
    await db.schema.dropTable("rooms").execute();
  },
};

export class DrawOffMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { "001_initial_persistence": initialPersistence };
  }
}

export type DrawOffDatabase = Kysely<DatabaseSchema>;
