import type { GameService } from "./gameService";
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
    const serverUrl = import.meta.env.VITE_GAME_SERVER_URL;
    instance = serverUrl ? createSocketGameService(serverUrl) : createMockGameService();
  }
  return instance;
}
