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

test("a kicked frontend client is told that its room session was revoked", async () => {
  const { app, io } = createServer({ logger: false });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const hostClient = createSocketGameService(address);
  const guestClient = createSocketGameService(address);
  let stopHostUpdates = () => {};
  let stopGuestUpdates = () => {};

  try {
    const host = await hostClient.createRoom("Host");
    stopHostUpdates = hostClient.subscribe(host, () => {});
    const guest = await guestClient.joinRoom(host.roomCode, "Guest");
    let resolveAttached = () => {};
    const attached = new Promise<void>((resolve) => {
      resolveAttached = resolve;
    });
    const revoked = new Promise<{ code: string; message: string }>((resolve) => {
      stopGuestUpdates = guestClient.subscribe(
        guest,
        () => resolveAttached(),
        (error) => resolve({ code: error.code, message: error.message }),
      );
    });

    await attached;
    await hostClient.kickPlayer(host, guest.playerId);

    assert.deepEqual(await revoked, {
      code: "UNAUTHORIZED",
      message: "You're no longer in this room.",
    });
  } finally {
    stopHostUpdates();
    stopGuestUpdates();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});

test("live Socket.IO rating submissions reject players outside an active match", async () => {
  const { app, io } = createServer({ logger: false });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = createSocketGameService(address);
  let stopUpdates = () => {};

  try {
    const judge = await client.createRoom("Judge");
    stopUpdates = client.subscribe(judge, () => {});
    await assert.rejects(
      client.submitRatings(judge, { "Drawing 1": 0, "Drawing 2": 100 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal("code" in error ? error.code : undefined, "FORBIDDEN");
        assert.equal(error.message, "Only players in the active match can act.");
        return true;
      },
    );
  } finally {
    stopUpdates();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
