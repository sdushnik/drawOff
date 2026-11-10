import type { GameService } from "./gameService";
import { resolveGameServerUrl } from "./gameServerUrl";
import { createMockGameService } from "./mock/mockGameService";
import { createSocketGameService } from "./socketGameService";

export * from "./gameService";

let instance: GameService | null = null;

/**
 * The app-wide backend. Swap the mock for a real implementation here
 * (e.g. `createSocketGameService(import.meta.env.VITE_GAME_SERVER_URL)`).
 * Call only from the browser (effects / event handlers).
 */
export function getGameService(): GameService {
  if (!instance) {
    const serverUrl = resolveGameServerUrl({
      configuredUrl: import.meta.env.VITE_GAME_SERVER_URL,
      isProduction: import.meta.env.PROD,
      browserOrigin: typeof window === "undefined" ? undefined : window.location.origin,
    });
    instance = serverUrl ? createSocketGameService(serverUrl) : createMockGameService();
  }
  return instance;
}
