import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";
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
  operation: (payload: TPayload) => unknown,
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

  try {
    const response = responseSchema.parse(operation(parsed.data));
    acknowledge(response);
  } catch (error) {
    if (error instanceof RoomServiceError) {
      emitSocketError(socket, error.code, error.message);
      return;
    }

    emitSocketError(socket, "REQUEST_FAILED", "The request could not be completed.");
  }
}

function registerRoomHandlers(io: SocketIOServer, roomService: RoomService): void {
  const attachedSessions = new Map<string, Session>();
  const playerSockets = new Map<string, Set<string>>();

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
        socket.emit("state:update", roomService.getLobbyView(session));
      } catch {
        socket.leave(roomCode);
        attachedSessions.delete(socketId);
      }
    }
  };

  const detach = (
    socket: Socket<ClientSocketEvents, ServerSocketEvents>,
    markDisconnected: boolean,
  ) => {
    const session = attachedSessions.get(socket.id);
    if (!session) return;
    attachedSessions.delete(socket.id);
    socket.leave(session.roomCode);

    const key = playerKey(session);
    const sockets = playerSockets.get(key);
    sockets?.delete(socket.id);
    if (sockets?.size === 0) {
      playerSockets.delete(key);
      if (markDisconnected) {
        try {
          roomService.setConnected(session, false);
          publishRoom(session.roomCode);
        } catch {
          // The room or player may already have been removed.
        }
      }
    }
  };

  const attach = (
    socket: Socket<ClientSocketEvents, ServerSocketEvents>,
    unverifiedSession: Session,
  ) => {
    const session = roomService.resumeSession(unverifiedSession);
    const currentSession = attachedSessions.get(socket.id);
    if (
      currentSession &&
      (currentSession.roomCode !== session.roomCode ||
        currentSession.playerId !== session.playerId)
    ) {
      detach(socket, true);
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
    void socket.join(session.roomCode);
    if (wasDisconnected) roomService.setConnected(session, true);
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
    socket.on("disconnect", () => detach(socket, true));

    socket.on("room:create", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["room:create"],
        clientToServerResponseSchemas["room:create"],
        acknowledge,
        ({ name }) => {
          const session = roomService.createRoom(name);
          attach(socket, session);
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
        ({ code, name }) => {
          const session = roomService.joinRoom(code, name);
          attach(socket, session);
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
        ({ session }) => {
          const resumed = attach(socket, session);
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
        ({ session }) => {
          const attached = attach(socket, session);
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
        ({ session }) => {
          assertAttached(socket, session);
          roomService.leaveRoom(session);
          detach(socket, false);
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
        ({ session, playerId }) => {
          assertAttached(socket, session);
          roomService.kickPlayer(session, playerId);
          for (const [socketId, attached] of attachedSessions) {
            if (
              attached.roomCode === session.roomCode &&
              attached.playerId === playerId
            ) {
              const target = io.sockets.sockets.get(socketId);
              if (target) detach(target, false);
            }
          }
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
        ({ session, cycles }) => {
          assertAttached(socket, session);
          roomService.setCycles(session, cycles);
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
        ({ session }) => {
          assertAttached(socket, session);
          roomService.startMatch(session);
          publishRoom(session.roomCode);
          return {};
        },
      );
    });
  });
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
    roomService?: RoomService;
  } = {},
) {
  const app = Fastify({ logger: options.logger ?? true });
  const io = new SocketIOServer<ClientSocketEvents, ServerSocketEvents>(app.server);
  registerRoomHandlers(io, options.roomService ?? createRoomService());
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

  return { app, io };
}

export async function startServer(
  options: { host?: string; port?: number } = {},
): Promise<RunningServer> {
  const { app, io } = createServer();
  const address = await app.listen({
    host: options.host ?? "0.0.0.0",
    port: options.port ?? 3000,
  });

  return { app, io, address };
}
