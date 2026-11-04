import type { Generated } from "kysely";

export interface RoomsTable {
  code: string;
  host_id: string;
  cycles: number;
  match_in_progress: number;
  match_schedule_json: string | null;
  notice: string | null;
  expires_at: number;
  updated_at: number;
}

export interface PlayersTable {
  room_code: string;
  id: string;
  name: string;
  is_host: number;
  roster_position: number;
  session_token_hash: string;
}

export interface MatchStatesTable {
  room_code: string;
  state_json: string;
  updated_at: number;
}

export interface KyselyMigrationTable {
  name: string;
  timestamp: string;
}

export interface KyselyMigrationLockTable {
  id: Generated<string>;
  is_locked: number;
}

export interface DatabaseSchema {
  rooms: RoomsTable;
  players: PlayersTable;
  match_states: MatchStatesTable;
  kysely_migration: KyselyMigrationTable;
  kysely_migration_lock: KyselyMigrationLockTable;
}
