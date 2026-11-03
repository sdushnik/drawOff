import { createContext, useContext, type ReactNode } from "react";
import type { GameService } from "./gameService";
import { getGameService } from "./index";

const ServiceContext = createContext<GameService | null>(null);

/** Optional override (tests, storybook). Without it the default service is used. */
export function ServiceProvider({ service, children }: { service: GameService; children: ReactNode }) {
  return <ServiceContext.Provider value={service}>{children}</ServiceContext.Provider>;
}

/** Returns a getter so the service is only created in the browser, on demand. */
export function useGameService(): () => GameService {
  const injected = useContext(ServiceContext);
  return () => injected ?? getGameService();
}
