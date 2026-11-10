import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

export interface TestDatabase {
  dialect: "sqlite" | "postgres";
  filename?: string;
  url: string;
  cleanup(): Promise<void>;
}

function postgresTestUrl(): string | undefined {
  const value = process.env["POSTGRES_TEST_DATABASE_URL"];
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("POSTGRES_TEST_DATABASE_URL must be a valid PostgreSQL test URL.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !/^drawoff_test(?:_[a-z0-9_-]+)?$/i.test(databaseName)
  ) {
    throw new Error("POSTGRES_TEST_DATABASE_URL must target a database named drawoff_test*.");
  }
  return value;
}

async function resetPostgres(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("drop schema if exists public cascade");
    await pool.query("create schema public");
  } finally {
    await pool.end();
  }
}

export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  const postgresUrl = postgresTestUrl();
  if (postgresUrl) {
    await resetPostgres(postgresUrl);
    return {
      dialect: "postgres",
      url: postgresUrl,
      cleanup: () => resetPostgres(postgresUrl),
    };
  }

  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const filename = join(directory, "state.sqlite");
  return {
    dialect: "sqlite",
    filename,
    url: `sqlite:${filename}`,
    cleanup: async () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function activeDatabaseDialect(): "SQLite" | "PostgreSQL" {
  return postgresTestUrl() ? "PostgreSQL" : "SQLite";
}
