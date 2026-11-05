import { describe, expect, it, vi, afterEach } from "vitest";
import { createMockGameService } from "./mockGameService";
import { ServiceError } from "../gameService";
import { GameEngine } from "@/game/engine";
import { DRAWING_MS } from "@/game/constants";
import type { PlayerView, Reaction } from "@drawoff/contracts";

afterEach(() => vi.useRealTimers());

function make() {
  let t = 0;
  const engine = new GameEngine({ now: () => t });
  const service = createMockGameService({ engine, latencyMs: 0, autoTick: false, storage: null, pushIntervalMs: 0 });
  return { service, advance: (ms: number) => ((t += ms), service.step()) };
}

describe("mock game service", () => {
  it("wraps engine errors as ServiceError with the same code", async () => {
    const { service } = make();
    await expect(service.joinRoom("NOPE1", "Ann")).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    await expect(service.createRoom("A")).rejects.toBeInstanceOf(ServiceError);
  });

  it("pushes privacy-filtered views to subscribers", async () => {
    vi.useFakeTimers();
    const { service } = make();
    const host = await service.createRoom("Ann");
    const views: PlayerView[] = [];
    const unsub = service.subscribe(host, (v) => views.push(v));
    expect(views[0]!.phase).toBe("LOBBY");
    await service.addDemoPlayer(host);
    await vi.runAllTimersAsync();
    expect(views.at(-1)!.players).toHaveLength(2);
    expect(views.at(-1)!.players[1]!.isBot).toBe(true);
    unsub();
  });

  it("demo players can carry a full match with one human", async () => {
    const { service, advance } = make();
    const host = await service.createRoom("Ann");
    await service.addDemoPlayer(host);
    await service.addDemoPlayer(host);
    await service.startMatch(host);
    const view = () => service.engine.getView(host.roomCode, host.token);

    for (let round = 0; round < 3; round++) {
      advance(4_000); // role reveal
      if (view().role === "judge") await service.selectPrompt(host, view().suggestions![0]!);
      for (let i = 0; i < 30 && view().phase === "WORD_SELECTION"; i++) advance(500);
      expect(view().phase).toBe("DRAWING");
      for (let i = 0; i <= Math.ceil(DRAWING_MS / 150) && view().phase === "DRAWING"; i++) advance(150);
      expect(view().phase).toBe("JUDGING");
      if (view().role === "judge") {
        const ratings = Object.fromEntries(view().gallery!.map((g) => [g.label, 77]));
        await service.submitRatings(host, ratings);
      }
      for (let i = 0; i < 100 && view().phase === "JUDGING"; i++) advance(500);
      expect(view().phase).toBe("ROUND_RESULT");
      expect(view().roundResult!.entries).toHaveLength(2);
      advance(12_000);
    }
    expect(view().phase).toBe("FINAL_RESULT");
    expect(view().finalResult!.standings).toHaveLength(3);
  });

  it("only the host can add demo players", async () => {
    const { service } = make();
    const host = await service.createRoom("Ann");
    const guest = await service.joinRoom(host.roomCode, "Ben");
    await expect(service.addDemoPlayer(guest)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("delivers transient authenticated reactions only during result phases", async () => {
    const { service, advance } = make();
    const host = await service.createRoom("Ann");
    const guest = await service.joinRoom(host.roomCode, "Ben");
    await service.joinRoom(host.roomCode, "Cam");
    await expect(service.sendReaction(guest, "🔥")).rejects.toMatchObject({ code: "WRONG_PHASE" });

    await service.startMatch(host);
    advance(4_000);
    await service.selectPrompt(host, "lighthouse");
    advance(75_000);
    const judgeView = service.engine.getView(host.roomCode, host.token);
    await service.submitRatings(
      host,
      Object.fromEntries(judgeView.gallery!.map(({ label }) => [label, 50])),
    );

    const hostReactions: Reaction[] = [];
    const guestReactions: Reaction[] = [];
    const stopHost = service.subscribe(host, () => {}, undefined, (reaction) => hostReactions.push(reaction));
    let stopGuest = service.subscribe(guest, () => {}, undefined, (reaction) => guestReactions.push(reaction));
    await service.sendReaction(guest, "🔥");
    expect(hostReactions[0]).toMatchObject({
      playerId: guest.playerId,
      playerName: "Ben",
      emoji: "🔥",
    });
    expect(guestReactions).toEqual(hostReactions);

    stopGuest();
    await service.sendReaction(host, "👏");
    expect(guestReactions).toHaveLength(1);
    stopGuest = service.subscribe(guest, () => {}, undefined, (reaction) => guestReactions.push(reaction));
    expect(guestReactions).toHaveLength(1);
    await service.sendReaction(host, "🎨");
    expect(guestReactions.at(-1)?.emoji).toBe("🎨");

    for (let index = 1; index < 6; index += 1) await service.sendReaction(guest, "😂");
    await expect(service.sendReaction(guest, "😂")).rejects.toMatchObject({
      code: "REQUEST_FAILED",
    });
    stopGuest();
    stopHost();
  });
});
