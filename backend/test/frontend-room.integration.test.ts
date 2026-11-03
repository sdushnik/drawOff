import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerView } from "@drawoff/contracts";
import { createSocketGameService } from "../../frontend/src/services/socketGameService.js";
import { createServer } from "../src/server.js";

function waitForRoster(
  subscribe: (onView: (view: PlayerView) => void) => () => void,
  roomCode: string,
): Promise<PlayerView> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for both clients to see the joined room."));
    }, 2_000);
    const unsubscribe = subscribe((view) => {
      if (view.roomCode !== roomCode || view.players.length !== 2) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(view);
    });
  });
}

test("two frontend Socket.IO clients create and join the same live room", async () => {
  const { app, io } = createServer({ logger: false });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const hostClient = createSocketGameService(address);
  const guestClient = createSocketGameService(address);
  let stopHostUpdates = () => {};
  let stopGuestUpdates = () => {};

  try {
    const host = await hostClient.createRoom("Host");
    assert.match(host.roomCode, /^[A-Z0-9]{6}$/);

    const hostRoster = waitForRoster(
      (onView) => {
        stopHostUpdates = hostClient.subscribe(host, onView);
        return stopHostUpdates;
      },
      host.roomCode,
    );
    const guest = await guestClient.joinRoom(host.roomCode, "Guest");
    const guestRoster = waitForRoster(
      (onView) => {
        stopGuestUpdates = guestClient.subscribe(guest, onView);
        return stopGuestUpdates;
      },
      host.roomCode,
    );

    const [hostView, guestView] = await Promise.all([hostRoster, guestRoster]);
    for (const view of [hostView, guestView]) {
      assert.equal(view.roomCode, host.roomCode);
      assert.deepEqual(
        view.players.map((player) => player.name).sort(),
        ["Guest", "Host"],
      );
    }
    assert.equal(guest.roomCode, host.roomCode);
  } finally {
    stopHostUpdates();
    stopGuestUpdates();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
