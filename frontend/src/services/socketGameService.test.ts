import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketIOServer } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import type { Reaction, Session } from "@drawoff/contracts";
import { createSocketGameService } from "./socketGameService";

describe("socket game service reactions", () => {
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
    const session: Session = {
      roomCode: "ABC123",
      playerId: "player-1",
      token: "private-token",
    };
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
});
