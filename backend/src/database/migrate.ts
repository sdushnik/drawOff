import { runDatabaseMigrations } from "./run-migrations.js";

try {
  await runDatabaseMigrations();
  console.log("Database migrations are up to date.");
} catch {
  console.error("Database migration failed. Check DATABASE_URL and database availability.");
  process.exitCode = 1;
}
