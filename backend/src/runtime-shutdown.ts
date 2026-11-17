import type { RunningServer } from "./server.js";
import type { TelemetryRuntime } from "./telemetry-sdk.js";

export function installGracefulShutdown(
  server: RunningServer,
  telemetry: TelemetryRuntime,
): void {
  let shuttingDown = false;
  const shutdown = (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await new Promise<void>((resolve) => server.io.close(() => resolve()));
      await server.app.close();
      await telemetry.shutdown();
    })().then(
      () => process.exit(exitCode),
      () => process.exit(1),
    );
  };

  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
}
