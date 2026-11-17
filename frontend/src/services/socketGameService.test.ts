import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketIOServer, type Socket as ServerSocket } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import type { DrawOp, Reaction, Session } from "@drawoff/contracts";
import { ServiceError } from "./gameService";
import {
  createSocketGameService,
  isExplicitSessionRevocation,
  isTransientError,
} from "./socketGameService";

const session: Session = {
  roomCode: "ABC123",
  playerId: "player-1",
  token: "private-token",
};

const clearOp = (id: string): DrawOp => ({ type: "clear", id });

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("socket game service", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("sends only the chosen emoji and delivers validated server reactions", async () => {
    const httpServer = createHttpServer();
    const io = new SocketIOServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => io.close(() => resolve()));
    const service = createSocketGameService(address);
    let requestPayload: unknown;
    const received = new Promise<Reaction>((resolve) => {
      service.subscribe(session, () => {}, undefined, resolve);
    });

    io.on("connection", (socket) => {
      socket.on("state:subscribe", (_payload, acknowledge) => acknowledge({}));
      socket.on("reaction:send", (payload, acknowledge) => {
        requestPayload = payload;
        socket.emit("reaction:new", {
          id: "reaction-1",
          playerId: "player-1",
          playerName: "Alex",
          emoji: "🔥",
          sentAt: 1_000,
        });
        acknowledge({});
      });
    });

    await service.sendReaction(session, "🔥");
    expect(requestPayload).toEqual({ session, emoji: "🔥" });
    await expect(received).resolves.toEqual({
      id: "reaction-1",
      playerId: "player-1",
      playerName: "Alex",
      emoji: "🔥",
      sentAt: 1_000,
    });
  });

  it("classifies only explicit invalidation as session revocation", () => {
    const unattached = new ServiceError("UNAUTHORIZED", "Attach your session before drawing.");
    const revoked = new ServiceError("UNAUTHORIZED", "That saved session is no longer valid.");
    const closed = new ServiceError("ROOM_NOT_FOUND", "That room has closed.");
    const offline = new ServiceError("NETWORK", "transport close");

    expect(isExplicitSessionRevocation(unattached)).toBe(false);
    expect(isTransientError(unattached)).toBe(true);
    expect(isExplicitSessionRevocation(offline)).toBe(false);
    expect(isTransientError(offline)).toBe(true);
    expect(isExplicitSessionRevocation(revoked)).toBe(true);
    expect(isTransientError(revoked)).toBe(false);
    expect(isExplicitSessionRevocation(closed)).toBe(true);
  });

  it("serializes requests behind session:resume after reconnect", async () => {
    const httpServer = createHttpServer();
    const io = new SocketIOServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => io.close(() => resolve()));
    const service = createSocketGameService(address);
    const events: string[] = [];
    let initialSocket: ServerSocket | undefined;
    let acknowledgeResume: (() => void) | undefined;

    io.on("connection", (socket) => {
      initialSocket ??= socket;
      socket.on("state:subscribe", (_payload, acknowledge) => acknowledge({}));
      socket.on("session:resume", (_payload, acknowledge) => {
        events.push("resume:start");
        acknowledgeResume = () => {
          events.push("resume:ack");
          acknowledge({ session });
        };
      });
      socket.on("reaction:send", (_payload, acknowledge) => {
        events.push("reaction");
        acknowledge({});
      });
    });

    const unsubscribe = service.subscribe(session, () => {});
    await waitFor(() => initialSocket !== undefined, "The initial socket did not connect.");
    initialSocket!.conn.close();
    await waitFor(() => acknowledgeResume !== undefined, "The reconnect did not request resume.");

    const reaction = service.sendReaction(session, "🔥");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["resume:start"]);
    acknowledgeResume!();
    await reaction;
    expect(events).toEqual(["resume:start", "resume:ack", "reaction"]);
    unsubscribe();
  });

  it("retries queued drawing operations in their original order", async () => {
    const httpServer = createHttpServer();
    const io = new SocketIOServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => io.close(() => resolve()));
    const service = createSocketGameService(address);
    const attempts: string[] = [];
    let subscribed = false;

    io.on("connection", (socket) => {
      socket.on("state:subscribe", (_payload, acknowledge) => {
        subscribed = true;
        acknowledge({});
      });
      socket.on("session:resume", (_payload, acknowledge) => acknowledge({ session }));
      socket.on("drawing:ops", (payload: { ops: DrawOp[] }, acknowledge) => {
        const id = payload.ops[0]?.id ?? "missing";
        attempts.push(id);
        if (attempts.length === 1) {
          socket.emit("error", {
            code: "UNAUTHORIZED",
            message: "Attach your session before drawing.",
          });
          return;
        }
        acknowledge({});
      });
    });

    const unsubscribe = service.subscribe(session, () => {});
    await waitFor(() => subscribed, "The service did not attach its initial subscription.");
    await Promise.all([
      service.sendDrawOps(session, [clearOp("first")]),
      service.sendDrawOps(session, [clearOp("second")]),
    ]);

    expect(attempts).toEqual(["first", "first", "second"]);
    unsubscribe();
  });

  it("preserves an in-flight drawing operation across a transient disconnect", async () => {
    const httpServer = createHttpServer();
    const io = new SocketIOServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => io.close(() => resolve()));
    const service = createSocketGameService(address);
    const events: string[] = [];
    let subscribed = false;
    let drawingAttempts = 0;

    io.on("connection", (socket) => {
      socket.on("state:subscribe", (_payload, acknowledge) => {
        subscribed = true;
        acknowledge({});
      });
      socket.on("session:resume", (_payload, acknowledge) => {
        events.push("resume");
        acknowledge({ session });
      });
      socket.on("drawing:ops", (_payload, acknowledge) => {
        drawingAttempts += 1;
        events.push(`draw:${drawingAttempts}`);
        if (drawingAttempts === 1) {
          socket.conn.close();
          return;
        }
        acknowledge({});
      });
    });

    const unsubscribe = service.subscribe(session, () => {});
    await waitFor(() => subscribed, "The service did not attach its initial subscription.");
    await service.sendDrawOps(session, [clearOp("survives-disconnect")]);

    expect(events).toEqual(["draw:1", "resume", "draw:2"]);
    unsubscribe();
  });
});
