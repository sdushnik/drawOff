import type { RunningServer } from "./server.js";

export interface RenderStartupDependencies {
  migrate: () => Promise<void>;
  startServer: () => Promise<RunningServer>;
}

export async function runRenderStartup(
  dependencies: RenderStartupDependencies,
): Promise<RunningServer> {
  await dependencies.migrate();
  return dependencies.startServer();
}
