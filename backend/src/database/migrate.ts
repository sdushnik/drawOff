import { runDatabaseMigrations } from "./run-migrations.js";
import { initializeTelemetry } from "../telemetry-sdk.js";

const telemetry = initializeTelemetry();
try {
  await runDatabaseMigrations();
  console.log("Database migrations are up to date.");
} catch {
  console.error("Database migration failed. Check DATABASE_URL and database availability.");
  process.exitCode = 1;
} finally {
  await telemetry.shutdown().catch(() => undefined);
}
