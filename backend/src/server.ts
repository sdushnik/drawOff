import Fastify, { type FastifyInstance } from "fastify";
import { Server as SocketIOServer } from "socket.io";

export interface RunningServer {
  app: FastifyInstance;
  io: SocketIOServer;
  address: string;
}

export function createServer() {
  const app = Fastify();
  const io = new SocketIOServer(app.server);

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
