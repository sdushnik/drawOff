import { runDatabaseMigrations } from "./database/run-migrations.js";
import { runRenderStartup } from "./render-startup.js";
import { startServer } from "./server.js";
import { sanitizedStartupErrorMessage } from "./startup-error.js";

const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "0.0.0.0";
const frontendAssetsDirectory = process.env["FRONTEND_ASSETS_DIR"];

try {
  const { address } = await runRenderStartup({
    migrate: runDatabaseMigrations,
    startServer: () => startServer({ host, port, frontendAssetsDirectory }),
  });
  console.log(`DrawOff backend listening at ${address}`);
} catch (error) {
  console.error(sanitizedStartupErrorMessage(error));
  process.exitCode = 1;
}
