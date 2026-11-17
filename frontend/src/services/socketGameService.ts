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
const MAX_QUEUED_DRAW_OPS = 4_096;

export function isExplicitSessionRevocation(error: ServiceError): boolean {
  if (error.code === "ROOM_NOT_FOUND") return true;
  if (error.code === "UNAUTHORIZED") {
    if (error.message.includes("Attach your session")) return false;
    return true;
  }
  return false;
}

export function isTransientError(error: ServiceError): boolean {
  if (error.code === "NETWORK") return true;
  if (error.code === "UNAUTHORIZED" && error.message.includes("Attach your session")) return true;
  return false;
}

export function createSocketGameService(serverUrl: string): GameService {
  const socket: Socket = io(serverUrl, {
    autoConnect: false,
    reconnection: true,
  });
  let activeSession: Session | null = null;
  let activeOnError: ((error: ServiceError) => void) | undefined;
  let hasConnected = false;
  let resumePromise: Promise<Session> | null = null;
  let drawingPhase = false;
  const viewListeners = new Set<(view: PlayerView) => void>();
  const reactionListeners = new Set<(reaction: Reaction) => void>();

  const drawingQueue: Array<{
    session: Session;
    ops: DrawOp[];
    resolve: () => void;
    reject: (error: unknown) => void;
    cancelled?: boolean;
  }> = [];
  let isProcessingDrawingQueue = false;

  const toServiceError = (error: unknown) => {
    if (error instanceof ServiceError) return error;
    const parsed = serviceErrorPayloadSchema.safeParse(error);
    if (parsed.success) return new ServiceError(parsed.data.code, parsed.data.message);
    if (error instanceof Error) return new ServiceError("NETWORK", error.message);
    return new ServiceError("NETWORK", "The live game server is unavailable.");
  };

  const onView = (payload: unknown) => {
    const parsed = playerViewSchema.safeParse(payload);
    if (!parsed.success) {
      activeOnError?.(new ServiceError("NETWORK", "The server sent an invalid room update."));
      return;
    }
    if (parsed.data.phase !== "DRAWING" && drawingPhase) {
      const staleError = new ServiceError("WRONG_PHASE", "The drawing phase has ended.");
      for (const entry of drawingQueue) {
        entry.cancelled = true;
        entry.reject(staleError);
      }
    }
    drawingPhase = parsed.data.phase === "DRAWING";
    for (const listener of viewListeners) listener(parsed.data);
  };
  socket.on("state:update", onView);
  socket.on("error", (error: unknown) => {
    const serviceError = toServiceError(error);
    if (isExplicitSessionRevocation(serviceError)) {
      activeOnError?.(serviceError);
    }
  });
  socket.on("reaction:new", (payload: unknown) => {
    const parsed = reactionSchema.safeParse(payload);
    if (!parsed.success) {
      activeOnError?.(new ServiceError("NETWORK", "The server sent an invalid reaction."));
      return;
    }
    for (const listener of reactionListeners) listener(parsed.data);
  });

  const startResumePromise = (session: Session): Promise<Session> => {
    if (resumePromise) return resumePromise;
    const promise = (async () => {
      try {
        const response = await requestRaw<{ session: Session }>("session:resume", { session });
        activeSession = response.session;
        return response.session;
      } catch (error: unknown) {
        const serviceError = toServiceError(error);
        if (isExplicitSessionRevocation(serviceError)) {
          activeOnError?.(serviceError);
        }
        throw serviceError;
      } finally {
        if (resumePromise === promise) {
          resumePromise = null;
        }
      }
    })();
    resumePromise = promise;
    return promise;
  };

  socket.on("connect", () => {
    if (hasConnected && activeSession) {
      void startResumePromise(activeSession)
        .then(() => {
          void processDrawingQueue();
        })
        .catch(() => undefined);
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
        reject(
          new ServiceError("NETWORK", error.message || "Could not connect to the game server."),
        );
      };

      socket.once("connect", onConnect);
      socket.once("connect_error", onConnectError);
      socket.connect();
    });

  const requestRaw = async <TResponse>(event: string, payload: unknown): Promise<TResponse> => {
    await ensureConnected();
    return new Promise<TResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error: ServiceError | null, response?: TResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("error", onRequestError);
        socket.off("disconnect", onDisconnect);
        if (error) reject(error);
        else resolve(response as TResponse);
      };
      const onDisconnect = () => {
        finish(new ServiceError("NETWORK", "Socket disconnected before response was received."));
      };
      const onRequestError = (error: unknown) => finish(toServiceError(error));
      const timer = setTimeout(
        () => finish(new ServiceError("NETWORK", "The game server did not respond.")),
        REQUEST_TIMEOUT_MS,
      );

      socket.once("error", onRequestError);
      socket.once("disconnect", onDisconnect);
      socket.emit(event, payload, (response: TResponse) => finish(null, response));
    });
  };

  const request = async <TResponse>(event: string, payload: unknown): Promise<TResponse> => {
    await ensureConnected();
    if (event !== "session:resume" && resumePromise) {
      await resumePromise;
    }
    return requestRaw<TResponse>(event, payload);
  };

  const processDrawingQueue = async () => {
    if (isProcessingDrawingQueue) return;
    isProcessingDrawingQueue = true;

    try {
      while (drawingQueue.length > 0) {
        await ensureConnected();
        if (resumePromise) {
          try {
            await resumePromise;
          } catch {
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
        }

        const current = drawingQueue[0];
        if (!current) break;
        if (current.cancelled) {
          drawingQueue.shift();
          continue;
        }

        try {
          await requestRaw("drawing:ops", { session: current.session, ops: current.ops });
          drawingQueue.shift();
          current.resolve();
        } catch (error) {
          const serviceError = toServiceError(error);
          if (isTransientError(serviceError)) {
            if (serviceError.message.includes("Attach your session") && activeSession) {
              void startResumePromise(activeSession);
            }
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }

          drawingQueue.shift();
          current.reject(serviceError);
          if (serviceError.code === "WRONG_PHASE" || serviceError.code === "DEADLINE_PASSED") {
            while (drawingQueue.length > 0) {
              drawingQueue.shift()?.reject(serviceError);
            }
          }
        }
      }
    } finally {
      isProcessingDrawingQueue = false;
    }
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
      if (ops.length === 0) return;
      return new Promise<void>((resolve, reject) => {
        const queuedOps = drawingQueue.reduce((total, entry) => total + entry.ops.length, 0);
        if (queuedOps + ops.length > MAX_QUEUED_DRAW_OPS) {
          reject(new ServiceError("NETWORK", "The drawing queue is full; try drawing again."));
          return;
        }
        drawingQueue.push({ session, ops, resolve, reject });
        void processDrawingQueue();
      });
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
      void request("state:subscribe", { session }).catch((error: unknown) => {
        const serviceError = toServiceError(error);
        if (isExplicitSessionRevocation(serviceError)) {
          onError?.(serviceError);
        }
      });
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
