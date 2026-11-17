import { runDatabaseMigrations } from "./database/run-migrations.js";
import { runRenderStartup } from "./render-startup.js";
import { installGracefulShutdown } from "./runtime-shutdown.js";
import { startServer } from "./server.js";
import { sanitizedStartupErrorMessage } from "./startup-error.js";
import { initializeTelemetry } from "./telemetry-sdk.js";

const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "0.0.0.0";
const frontendAssetsDirectory = process.env["FRONTEND_ASSETS_DIR"];
const telemetry = initializeTelemetry();

try {
  const server = await runRenderStartup({
    migrate: runDatabaseMigrations,
    startServer: () => startServer({ host, port, frontendAssetsDirectory }),
  });
  installGracefulShutdown(server, telemetry);
  const { address } = server;
  console.log(`DrawOff backend listening at ${address}`);
} catch (error) {
  console.error(sanitizedStartupErrorMessage(error));
  await telemetry.shutdown().catch(() => undefined);
  process.exitCode = 1;
}
