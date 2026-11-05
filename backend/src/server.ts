import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";
import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import { Server as SocketIOServer, type Socket } from "socket.io";
import type {
  ClientToServerPayloads,
  ClientToServerResponses,
  ServerToClientPayloads,
  Session,
} from "@drawoff/contracts";
import {
  clientToServerPayloadSchemas,
  clientToServerResponseSchemas,
  healthResponseSchema,
  serviceErrorPayloadSchema,
  type ServiceErrorCode,
} from "@drawoff/contracts";
import {
  createRoomService,
  RoomService,
  RoomServiceError,
} from "./room-service.js";
import {
  MatchStateMachine,
  type DurableMatchProgress,
  type MatchStateMachineOptions,
} from "./match-state-machine.js";
import {
  databaseUrlFromEnvironment,
  KyselyGameStateRepository,
  RoomPersistenceError,
  type GameStateRepository,
} from "./database/repository.js";
import {
  FixedWindowRateLimiter,
  resourceLimitOptionsFromEnvironment,
  resolveResourceLimits,
  type ResourceLimitOptions,
  type ResourceLimits,
} from "./resource-limits.js";

type ClientSocketEvents = {
  [Event in keyof ClientToServerPayloads]: (
    payload: ClientToServerPayloads[Event],
    acknowledge: (response: ClientToServerResponses[Event]) => void,
  ) => void;
};

type ServerSocketEvents = {
  [Event in keyof ServerToClientPayloads]: (payload: ServerToClientPayloads[Event]) => void;
};

export interface RunningServer {
  app: FastifyInstance;
  io: SocketIOServer;
  address: string;
}

const developmentOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function validateCorsOrigins(origins: readonly string[]): string[] {
  if (origins.length === 0) {
    throw new Error("At least one explicit frontend origin must be configured.");
  }

  return [
    ...new Set(
      origins.map((value) => {
        const origin = value.trim();
        let url: URL;
        try {
          url = new URL(origin);
        } catch {
          throw new Error(`Invalid frontend origin: ${origin || "(empty)"}`);
        }

        if (
          origin === "*" ||
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          url.origin !== origin ||
          url.username !== "" ||
          url.password !== ""
        ) {
          throw new Error(`Invalid frontend origin: ${origin}`);
        }

        return origin;
      }),
    ),
  ];
}

export function resolveCorsOrigins(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const configuredOrigins = environment["FRONTEND_ORIGINS"];
  if (configuredOrigins !== undefined) {
    return validateCorsOrigins(configuredOrigins.split(","));
  }

  if (environment["NODE_ENV"] === "production") {
    throw new Error("FRONTEND_ORIGINS must be configured in production.");
  }

  return [...developmentOrigins];
}

interface RuntimeSchema<T> {
  safeParse(payload: unknown):
    | { success: true; data: T }
    | { success: false; error: unknown };
  parse(payload: unknown): T;
}

function emitSocketError(
  socket: Socket<ClientSocketEvents, ServerSocketEvents>,
  code: ServiceErrorCode,
  message: string,
): void {
  socket.emit("error", serviceErrorPayloadSchema.parse({ code, message }));
}

function handleSocketRequest<TPayload, TResponse>(
  socket: Socket<ClientSocketEvents, ServerSocketEvents>,
  rawPayload: unknown,
  payloadSchema: RuntimeSchema<TPayload>,
  responseSchema: RuntimeSchema<TResponse>,
  acknowledge: ((response: TResponse) => void) | undefined,
  operation: (payload: TPayload) => unknown | Promise<unknown>,
): void {
  if (typeof acknowledge !== "function") {
    emitSocketError(socket, "INVALID_INPUT", "A request acknowledgement is required.");
    return;
  }

  const parsed = payloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    emitSocketError(socket, "INVALID_INPUT", "The request is invalid.");
    return;
  }

  const fail = (error: unknown) => {
    if (error instanceof RoomServiceError) {
      emitSocketError(socket, error.code, error.message);
      return;
    }
    if (error instanceof RoomPersistenceError) {
      emitSocketError(socket, "SERVICE_UNAVAILABLE", "The room state could not be saved. Try again.");
      return;
    }
    emitSocketError(socket, "REQUEST_FAILED", "The request could not be completed.");
  };

  try {
    void Promise.resolve(operation(parsed.data))
      .then((value) => acknowledge(responseSchema.parse(value)))
      .catch(fail);
  } catch (error) {
    fail(error);
  }
}

function registerRoomHandlers(
  io: SocketIOServer,
  roomService: RoomService,
  resourceLimits: ResourceLimits,
  rateLimiter: FixedWindowRateLimiter,
  machineOptions: Omit<MatchStateMachineOptions, "onTransition"> = {},
  repository?: GameStateRepository,
  initialMatches: readonly DurableMatchProgress[] = [],
): MatchStateMachine {
  const attachedSessions = new Map<string, Session>();
  const playerSockets = new Map<string, Set<string>>();
  let shuttingDown = false;
  let matchStateMachine: MatchStateMachine;
  let persistenceQueue = Promise.resolve();
  let mutationQueue = Promise.resolve();
  let mutationDepth = 0;
  let suppressTransitionSideEffects = false;
  const pendingTransitionRooms = new Set<string>();
  const persist = async () => {
    if (!repository) return;
    const snapshot = {
      rooms: roomService.exportDurableState(),
      matches: matchStateMachine.exportDurableState(),
    };
    const write = persistenceQueue.then(() => repository.replace(snapshot));
    persistenceQueue = write.catch(() => undefined);
    await write;
  };

  const restoreSnapshots = (
    rooms: ReturnType<RoomService["exportDurableState"]>,
    matches: ReturnType<MatchStateMachine["exportDurableState"]>,
  ) => {
    suppressTransitionSideEffects = true;
    try {
      roomService.restoreDurableState(rooms);
      matchStateMachine.restoreDurableState(matches);
    } finally {
      suppressTransitionSideEffects = false;
    }
  };

  const executeMutation = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const roomsBefore = roomService.exportDurableState();
    const matchesBefore = matchStateMachine.exportDurableState();
    pendingTransitionRooms.clear();
    mutationDepth = 1;
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      mutationDepth = 0;
      pendingTransitionRooms.clear();
      if (error instanceof RoomPersistenceError) {
        restoreSnapshots(roomsBefore, matchesBefore);
      } else {
        const roomsAfter = roomService.exportDurableState();
        const removedRoom = roomsBefore.some(
          (room) => !roomsAfter.some((candidate) => candidate.code === room.code),
        );
        if (removedRoom) {
          matchStateMachine.pruneMissingRooms();
          try {
            await persist();
          } catch (persistenceError) {
            restoreSnapshots(roomsBefore, matchesBefore);
            throw persistenceError;
          }
        }
      }
      throw error;
    }

    mutationDepth = 0;
    try {
      await persist();
    } catch (error) {
      pendingTransitionRooms.clear();
      restoreSnapshots(roomsBefore, matchesBefore);
      throw error;
    }
    const transitionedRooms = [...pendingTransitionRooms];
    pendingTransitionRooms.clear();
    for (const roomCode of transitionedRooms) publishRoom(roomCode);
    return result;
  };

  const persistMutation = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const execution = mutationQueue.then(() => executeMutation(operation));
    mutationQueue = execution.then(() => undefined, () => undefined);
    return execution;
  };

  const playerKey = (session: Session) => `${session.roomCode}:${session.playerId}`;

  const publishRoom = (roomCode: string) => {
    try {
      roomService.getRoom(roomCode);
    } catch {
      return;
    }

    for (const socketId of io.sockets.adapter.rooms.get(roomCode) ?? []) {
      const session = attachedSessions.get(socketId);
      if (!session || session.roomCode !== roomCode) continue;

      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      try {
        socket.emit("state:update", matchStateMachine.getPlayerView(session));
      } catch {
        socket.leave(roomCode);
        attachedSessions.delete(socketId);
      }
    }
  };

  const publishDrawingViews = (roomCode: string, artistId: string) => {
    for (const [socketId, session] of attachedSessions) {
      if (session.roomCode !== roomCode) continue;
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      try {
        const view = matchStateMachine.getPlayerView(session);
        if (session.playerId === artistId || view.role === "judge") {
          socket.emit("state:update", view);
        }
      } catch {
        socket.leave(roomCode);
        attachedSessions.delete(socketId);
      }
    }
  };

  matchStateMachine = new MatchStateMachine(roomService, {
    ...machineOptions,
    maxCanvasActionsPerRoom: resourceLimits.maxCanvasActionsPerRoom,
    onTransition: (roomCode) => {
      if (suppressTransitionSideEffects) return;
      if (mutationDepth > 0) {
        pendingTransitionRooms.add(roomCode);
        return;
      }
      if (!repository) {
        publishRoom(roomCode);
        return;
      }
      void persist().then(() => publishRoom(roomCode)).catch(() => undefined);
    },
  });
  if (initialMatches.length > 0) matchStateMachine.restoreDurableState(initialMatches);
  const cleanupTimer = setInterval(
    () => {
      const removed = roomService.purgeExpiredRooms();
      if (removed > 0) {
        matchStateMachine.pruneMissingRooms();
        void persist().catch(() => undefined);
      }
    },
    resourceLimits.roomCleanupIntervalMs,
  );
  cleanupTimer.unref();
  io.engine.on("close", () => {
    shuttingDown = true;
    clearInterval(cleanupTimer);
    matchStateMachine.dispose(false);
  });

  const enforceAttachedRateLimits = (
    socket: Socket<ClientSocketEvents, ServerSocketEvents>,
    kind: "drawing" | "submissions",
  ) => {
    const session = attachedSessions.get(socket.id);
    if (!session) return;
    const sessionRule = kind === "drawing"
      ? resourceLimits.drawingPerSession
      : resourceLimits.submissionsPerSession;
    const roomRule = kind === "drawing"
      ? resourceLimits.drawingPerRoom
      : resourceLimits.submissionsPerRoom;
    rateLimiter.consume(
      `${kind}:session:${playerKey(session)}`,
      sessionRule,
      `${kind} from this session`,
    );
    rateLimiter.consume(
      `${kind}:room:${session.roomCode}`,
      roomRule,
      `${kind} in this room`,
    );
  };

  const detach = async (
    socket: Socket<ClientSocketEvents, ServerSocketEvents>,
    markDisconnected: boolean,
    persistDisconnect = true,
  ): Promise<void> => {
    const session = attachedSessions.get(socket.id);
    if (!session) return;
    attachedSessions.delete(socket.id);
    await socket.leave(session.roomCode);

    const key = playerKey(session);
    const sockets = playerSockets.get(key);
    sockets?.delete(socket.id);
    if (sockets?.size === 0) {
      playerSockets.delete(key);
      if (markDisconnected && !shuttingDown) {
        try {
          const disconnectPlayer = () => {
            roomService.setConnected(session, false);
            matchStateMachine.playerDisconnected(session);
          };
          if (persistDisconnect) {
            await persistMutation(disconnectPlayer);
            publishRoom(session.roomCode);
          } else {
            disconnectPlayer();
            pendingTransitionRooms.add(session.roomCode);
          }
        } catch {
          // The room or player may already have been removed.
        }
      }
    }
  };

  const attach = async (
    socket: Socket<ClientSocketEvents, ServerSocketEvents>,
    unverifiedSession: Session,
  ): Promise<Session> => {
    const session = roomService.resumeSession(unverifiedSession);
    const currentSession = attachedSessions.get(socket.id);
    if (
      currentSession &&
      (currentSession.roomCode !== session.roomCode ||
        currentSession.playerId !== session.playerId)
    ) {
      await detach(socket, true, false);
    }

    const key = playerKey(session);
    let sockets = playerSockets.get(key);
    if (!sockets) {
      sockets = new Set();
      playerSockets.set(key, sockets);
    }
    const wasDisconnected = sockets.size === 0;
    sockets.add(socket.id);
    attachedSessions.set(socket.id, session);
    await socket.join(session.roomCode);
    if (wasDisconnected) {
      roomService.setConnected(session, true);
      matchStateMachine.playerReconnected(session);
    }
    return session;
  };

  const assertAttached = (
    socket: Socket<ClientSocketEvents, ServerSocketEvents>,
    session: Session,
  ) => {
    const attached = attachedSessions.get(socket.id);
    if (
      !attached ||
      attached.roomCode !== session.roomCode ||
      attached.playerId !== session.playerId
    ) {
      throw new RoomServiceError("UNAUTHORIZED", "Attach your session before changing the room.");
    }
  };

  io.on("connection", (socket) => {
    socket.on("disconnect", (reason) => {
      if (reason === "server shutting down") shuttingDown = true;
      void detach(socket, reason !== "server shutting down");
    });

    socket.on("room:create", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["room:create"],
        clientToServerResponseSchemas["room:create"],
        acknowledge,
        async ({ name }) => {
          rateLimiter.consume(
            `create:connection:${socket.id}`,
            resourceLimits.roomCreatesPerConnection,
            "room creation",
          );
          const session = await persistMutation(async () => {
            const created = roomService.createRoom(name);
            await attach(socket, created);
            return created;
          });
          publishRoom(session.roomCode);
          return { session };
        },
      );
    });

    socket.on("room:join", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["room:join"],
        clientToServerResponseSchemas["room:join"],
        acknowledge,
        async ({ code, name }) => {
          rateLimiter.consume(
            `join:connection:${socket.id}`,
            resourceLimits.roomCodeGuessesPerConnection,
            "room-code attempts from this connection",
          );
          const attemptedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 64);
          rateLimiter.consume(
            `join:code:${attemptedCode}`,
            resourceLimits.roomCodeGuessesPerCode,
            "attempts for this room code",
          );
          const session = await persistMutation(async () => {
            const joined = roomService.joinRoom(code, name);
            await attach(socket, joined);
            return joined;
          });
          publishRoom(session.roomCode);
          return { session };
        },
      );
    });

    socket.on("session:resume", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["session:resume"],
        clientToServerResponseSchemas["session:resume"],
        acknowledge,
        async ({ session }) => {
          const resumed = await persistMutation(() => attach(socket, session));
          publishRoom(resumed.roomCode);
          return { session: resumed };
        },
      );
    });

    socket.on("state:subscribe", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["state:subscribe"],
        clientToServerResponseSchemas["state:subscribe"],
        acknowledge,
        async ({ session }) => {
          const attached = await persistMutation(() => attach(socket, session));
          publishRoom(attached.roomCode);
          return {};
        },
      );
    });

    socket.on("room:leave", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["room:leave"],
        clientToServerResponseSchemas["room:leave"],
        acknowledge,
        async ({ session }) => {
          assertAttached(socket, session);
          await persistMutation(async () => {
            matchStateMachine.playerLeft(session);
            await detach(socket, false);
          });
          publishRoom(session.roomCode);
          return {};
        },
      );
    });

    socket.on("player:kick", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["player:kick"],
        clientToServerResponseSchemas["player:kick"],
        acknowledge,
        async ({ session, playerId }) => {
          assertAttached(socket, session);
          await persistMutation(async () => {
            roomService.kickPlayer(session, playerId);
            for (const [socketId, attached] of attachedSessions) {
              if (
                attached.roomCode === session.roomCode &&
                attached.playerId === playerId
              ) {
                const target = io.sockets.sockets.get(socketId);
                if (target) await detach(target, false);
              }
            }
          });
          publishRoom(session.roomCode);
          return {};
        },
      );
    });

    socket.on("match:set-cycles", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["match:set-cycles"],
        clientToServerResponseSchemas["match:set-cycles"],
        acknowledge,
        async ({ session, cycles }) => {
          assertAttached(socket, session);
          await persistMutation(() => roomService.setCycles(session, cycles));
          publishRoom(session.roomCode);
          return {};
        },
      );
    });

    socket.on("match:start", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["match:start"],
        clientToServerResponseSchemas["match:start"],
        acknowledge,
        async ({ session }) => {
          assertAttached(socket, session);
          await persistMutation(() => matchStateMachine.startMatch(session));
          publishRoom(session.roomCode);
          return {};
        },
      );
    });

    socket.on("match:rematch", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["match:rematch"],
        clientToServerResponseSchemas["match:rematch"],
        acknowledge,
        async ({ session }) => {
          assertAttached(socket, session);
          await persistMutation(() =>
            matchStateMachine.rematch(attachedSessions.get(socket.id)!));
          return {};
        },
      );
    });

    socket.on("prompt:select", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["prompt:select"],
        clientToServerResponseSchemas["prompt:select"],
        acknowledge,
        async ({ session, prompt }) => {
          assertAttached(socket, session);
          await persistMutation(() => matchStateMachine.selectPrompt(session, prompt));
          return {};
        },
      );
    });

    socket.on("drawing:ops", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["drawing:ops"],
        clientToServerResponseSchemas["drawing:ops"],
        acknowledge,
        async ({ session, ops }) => {
          assertAttached(socket, session);
          enforceAttachedRateLimits(socket, "drawing");
          const authenticated = attachedSessions.get(socket.id)!;
          const changed = await persistMutation(() =>
            matchStateMachine.sendDrawOps(authenticated, ops));
          if (changed) {
            publishDrawingViews(authenticated.roomCode, authenticated.playerId);
          }
          return {};
        },
      );
    });

    socket.on("drawing:submit", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["drawing:submit"],
        clientToServerResponseSchemas["drawing:submit"],
        acknowledge,
        async ({ session }) => {
          assertAttached(socket, session);
          enforceAttachedRateLimits(socket, "submissions");
          const authenticated = attachedSessions.get(socket.id)!;
          await persistMutation(() => matchStateMachine.submitCanvas(authenticated));
          publishRoom(authenticated.roomCode);
          return {};
        },
      );
    });

    socket.on("ratings:submit", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["ratings:submit"],
        clientToServerResponseSchemas["ratings:submit"],
        acknowledge,
        async ({ session, ratings }) => {
          assertAttached(socket, session);
          enforceAttachedRateLimits(socket, "submissions");
          await persistMutation(() =>
            matchStateMachine.submitRatings(attachedSessions.get(socket.id)!, ratings));
          return {};
        },
      );
    });

    socket.on("reaction:send", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["reaction:send"],
        clientToServerResponseSchemas["reaction:send"],
        acknowledge,
        async ({ session, emoji }) => {
          assertAttached(socket, session);
          const authenticated = attachedSessions.get(socket.id)!;
          const view = matchStateMachine.getPlayerView(authenticated);
          if (view.phase !== "ROUND_RESULT" && view.phase !== "FINAL_RESULT") {
            throw new RoomServiceError(
              "WRONG_PHASE",
              "Reactions are available only while results are shown.",
            );
          }
          rateLimiter.consume(
            `reactions:session:${playerKey(authenticated)}`,
            resourceLimits.reactionsPerSession,
            "reactions from this session",
          );
          io.to(authenticated.roomCode).emit("reaction:new", {
            id: randomUUID(),
            playerId: authenticated.playerId,
            playerName: view.me.name,
            emoji,
            sentAt: Date.now(),
          });
          return {};
        },
      );
    });
  });
  return matchStateMachine;
}

function sendHttpError(
  reply: FastifyReply,
  statusCode: number,
  code: ServiceErrorCode,
  message: string,
) {
  return reply
    .code(statusCode)
    .send(serviceErrorPayloadSchema.parse({ code, message }));
}

export function registerHealthRoute(app: FastifyInstance, isReady: () => boolean): void {
  app.get("/health", async (_request, reply) => {
    if (!isReady()) {
      return sendHttpError(reply, 503, "SERVICE_UNAVAILABLE", "Service is not ready.");
    }

    return reply.send(healthResponseSchema.parse({ status: "ready" }));
  });
}

export function createServer(
  options: {
    logger?: FastifyServerOptions["logger"];
    corsOrigins?: readonly string[];
    roomService?: RoomService;
    matchStateMachineOptions?: Omit<MatchStateMachineOptions, "onTransition">;
    resourceLimits?: ResourceLimitOptions;
    repository?: GameStateRepository;
    initialMatches?: readonly DurableMatchProgress[];
  } = {},
) {
  const corsOrigins = validateCorsOrigins(options.corsOrigins ?? resolveCorsOrigins());
  const resourceLimits = resolveResourceLimits(options.resourceLimits);
  const roomService = options.roomService ?? createRoomService();
  const app = Fastify({ logger: options.logger ?? true });
  void app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });
  const io = new SocketIOServer<ClientSocketEvents, ServerSocketEvents>(app.server, {
    maxHttpBufferSize: resourceLimits.maxInboundMessageBytes,
    cors: {
      origin: corsOrigins,
      credentials: true,
    },
  });
  const matchStateMachine = registerRoomHandlers(
    io,
    roomService,
    resourceLimits,
    new FixedWindowRateLimiter(options.resourceLimits?.now),
    options.matchStateMachineOptions,
    options.repository,
    options.initialMatches,
  );
  let fastifyReady = false;

  app.addHook("onReady", async () => {
    fastifyReady = true;
  });
  registerHealthRoute(app, () => fastifyReady && io.engine !== undefined);

  app.setNotFoundHandler((_request, reply) =>
    sendHttpError(reply, 404, "NOT_FOUND", "The requested resource was not found."),
  );
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;

    if (statusCode >= 400 && statusCode < 500) {
      if (statusCode === 400) {
        return sendHttpError(reply, 400, "INVALID_INPUT", "The request is invalid.");
      }
      if (statusCode === 401) {
        return sendHttpError(reply, 401, "UNAUTHORIZED", "Authentication is required.");
      }
      if (statusCode === 403) {
        return sendHttpError(reply, 403, "FORBIDDEN", "The request is not allowed.");
      }
      if (statusCode === 404) {
        return sendHttpError(reply, 404, "NOT_FOUND", "The requested resource was not found.");
      }

      return sendHttpError(
        reply,
        statusCode,
        "REQUEST_FAILED",
        "The request could not be completed.",
      );
    }

    app.log.error({ err: error }, "Unhandled HTTP error");
    return sendHttpError(
      reply,
      500,
      "INTERNAL_SERVER_ERROR",
      "An unexpected server error occurred.",
    );
  });

  return { app, io, roomService, matchStateMachine };
}

export async function createPersistentServer(
  options: {
    logger?: FastifyServerOptions["logger"];
    corsOrigins?: readonly string[];
    resourceLimits?: ResourceLimitOptions;
    matchStateMachineOptions?: Omit<MatchStateMachineOptions, "onTransition">;
    databaseUrl?: string;
  } = {},
) {
  const repository = KyselyGameStateRepository.open(
    options.databaseUrl ?? databaseUrlFromEnvironment(),
  );
  try {
    await repository.migrate();
    const state = await repository.load();
    const roomService = createRoomService({ now: options.matchStateMachineOptions?.now });
    roomService.restoreDurableState(state.rooms);
    const server = createServer({
      logger: options.logger,
      corsOrigins: options.corsOrigins,
      resourceLimits: options.resourceLimits,
      matchStateMachineOptions: options.matchStateMachineOptions,
      roomService,
      repository,
      initialMatches: state.matches,
    });
    await repository.replace({
      rooms: roomService.exportDurableState(),
      matches: server.matchStateMachine.exportDurableState(),
    });
    server.app.addHook("onClose", async () => repository.close());
    return server;
  } catch (error) {
    await repository.close();
    throw error;
  }
}

export async function startServer(
  options: {
    host?: string;
    port?: number;
    corsOrigins?: readonly string[];
    resourceLimits?: ResourceLimitOptions;
    databaseUrl?: string;
  } = {},
): Promise<RunningServer> {
  const { app, io } = await createPersistentServer({
    corsOrigins: options.corsOrigins,
    resourceLimits: options.resourceLimits ?? resourceLimitOptionsFromEnvironment(),
    databaseUrl: options.databaseUrl,
  });
  const address = await app.listen({
    host: options.host ?? "0.0.0.0",
    port: options.port ?? 3000,
  });

  return { app, io, address };
}
