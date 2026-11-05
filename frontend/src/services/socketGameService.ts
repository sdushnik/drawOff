import { io, type Socket } from "socket.io-client";
import {
  playerViewSchema,
  reactionSchema,
  serviceErrorPayloadSchema,
  type Cycles,
  type DrawOp,
  type PlayerView,
  type Reaction,
  type Session,
} from "@drawoff/contracts";
import { ServiceError, type GameService, type Unsubscribe } from "./gameService";

const REQUEST_TIMEOUT_MS = 5_000;

export function createSocketGameService(serverUrl: string): GameService {
  const socket: Socket = io(serverUrl, {
    autoConnect: false,
    reconnection: true,
  });
  let activeSession: Session | null = null;
  let activeOnError: ((error: ServiceError) => void) | undefined;
  let hasConnected = false;
  const viewListeners = new Set<(view: PlayerView) => void>();
  const reactionListeners = new Set<(reaction: Reaction) => void>();

  const toServiceError = (error: unknown) => {
    const parsed = serviceErrorPayloadSchema.safeParse(error);
    if (parsed.success) return new ServiceError(parsed.data.code, parsed.data.message);
    return new ServiceError("NETWORK", "The live game server is unavailable.");
  };

  const onView = (payload: unknown) => {
    const parsed = playerViewSchema.safeParse(payload);
    if (!parsed.success) {
      activeOnError?.(new ServiceError("NETWORK", "The server sent an invalid room update."));
      return;
    }
    for (const listener of viewListeners) listener(parsed.data);
  };
  socket.on("state:update", onView);
  socket.on("reaction:new", (payload: unknown) => {
    const parsed = reactionSchema.safeParse(payload);
    if (!parsed.success) {
      activeOnError?.(new ServiceError("NETWORK", "The server sent an invalid reaction."));
      return;
    }
    for (const listener of reactionListeners) listener(parsed.data);
  });
  socket.on("connect", () => {
    if (hasConnected && activeSession) {
      void request("session:resume", { session: activeSession }).catch((error: unknown) =>
        activeOnError?.(toServiceError(error)),
      );
    }
    hasConnected = true;
  });

  const ensureConnected = () =>
    new Promise<void>((resolve, reject) => {
      if (socket.connected) {
        resolve();
        return;
      }

      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("connect_error", onConnectError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onConnectError = (error: Error) => {
        cleanup();
        reject(new ServiceError("NETWORK", error.message || "Could not connect to the game server."));
      };

      socket.once("connect", onConnect);
      socket.once("connect_error", onConnectError);
      socket.connect();
    });

  const request = async <TResponse>(event: string, payload: unknown): Promise<TResponse> => {
    await ensureConnected();
    return new Promise<TResponse>((resolve, reject) => {
      const finish = (error: ServiceError | null, response?: TResponse) => {
        clearTimeout(timer);
        socket.off("error", onRequestError);
        if (error) reject(error);
        else resolve(response as TResponse);
      };
      const onRequestError = (error: unknown) => finish(toServiceError(error));
      const timer = setTimeout(
        () => finish(new ServiceError("NETWORK", "The game server did not respond.")),
        REQUEST_TIMEOUT_MS,
      );

      socket.once("error", onRequestError);
      socket.emit(event, payload, (response: TResponse) => finish(null, response));
    });
  };

  const unsupported = async (): Promise<never> => {
    throw new ServiceError("WRONG_PHASE", "Live gameplay actions are not available yet.");
  };

  return {
    capabilities: { demoPlayers: false, label: "Live room" },
    createRoom: async (name) =>
      (await request<{ session: Session }>("room:create", { name })).session,
    joinRoom: async (code, name) =>
      (await request<{ session: Session }>("room:join", { code, name })).session,
    resumeSession: async (session) =>
      (await request<{ session: Session }>("session:resume", { session })).session,
    leaveRoom: async (session) => {
      await request("room:leave", { session });
      activeSession = null;
    },
    kickPlayer: async (session, playerId) => {
      await request("player:kick", { session, playerId });
    },
    setCycles: async (session, cycles: Cycles) => {
      await request("match:set-cycles", { session, cycles });
    },
    addDemoPlayer: unsupported,
    startMatch: async (session) => {
      await request("match:start", { session });
    },
    selectPrompt: async (session, prompt) => {
      await request("prompt:select", { session, prompt });
    },
    sendDrawOps: async (session: Session, ops: DrawOp[]) => {
      await request("drawing:ops", { session, ops });
    },
    submitCanvas: async (session: Session) => {
      await request("drawing:submit", { session });
    },
    submitRatings: async (session, ratings) => {
      await request("ratings:submit", { session, ratings });
    },
    sendReaction: async (session, emoji) => {
      await request("reaction:send", { session, emoji });
    },
    rematch: async (session) => {
      await request("match:rematch", { session });
    },
    returnToLobby: unsupported,
    subscribe(
      session: Session,
      onUpdate: (view: PlayerView) => void,
      onError?: (error: ServiceError) => void,
      onReaction?: (reaction: Reaction) => void,
    ): Unsubscribe {
      activeSession = session;
      activeOnError = onError;
      viewListeners.add(onUpdate);
      if (onReaction) reactionListeners.add(onReaction);
      void request("state:subscribe", { session }).catch((error: unknown) =>
        onError?.(toServiceError(error)),
      );
      return () => {
        viewListeners.delete(onUpdate);
        if (onReaction) reactionListeners.delete(onReaction);
        if (viewListeners.size === 0 && activeSession?.playerId === session.playerId) {
          activeSession = null;
          activeOnError = undefined;
          socket.disconnect();
        }
      };
    },
  };
}
