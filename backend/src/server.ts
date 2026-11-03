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
  io.on("connection", (socket) => {
    socket.on("room:create", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["room:create"],
        clientToServerResponseSchemas["room:create"],
        acknowledge,
        ({ name }) => ({ session: roomService.createRoom(name) }),
      );
    });

    socket.on("room:join", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["room:join"],
        clientToServerResponseSchemas["room:join"],
        acknowledge,
        ({ code, name }) => ({ session: roomService.joinRoom(code, name) }),
      );
    });

    socket.on("session:resume", (payload, acknowledge) => {
      handleSocketRequest(
        socket,
        payload,
        clientToServerPayloadSchemas["session:resume"],
        clientToServerResponseSchemas["session:resume"],
        acknowledge,
        ({ session }) => ({ session: roomService.resumeSession(session) }),
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
          roomService.leaveRoom(session);
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
          roomService.kickPlayer(session, playerId);
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
