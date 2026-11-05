import { describe, expect, it } from "vitest";
import { GameEngine, GameError } from "./engine";
import {
  DRAWING_MS,
  JUDGE_GRACE_MS,
  RECONNECT_WINDOW_MS,
  ROLE_REVEAL_MS,
  ROUND_RESULT_MS,
  WORD_SELECTION_MS,
} from "./constants";
import { judgingSeconds } from "./rules";
import type { Session } from "@drawoff/contracts";

function setup(playerCount = 3) {
  let t = 1_000_000;
  let seed = 7;
  const engine = new GameEngine({
    now: () => t,
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    },
  });
  const host = engine.createRoom("Host");
  const players: Session[] = [host];
  for (let i = 1; i < playerCount; i++) players.push(engine.joinRoom(host.roomCode, `Player ${i}`));
  const code = host.roomCode;
  const advance = (ms: number) => {
    t += ms;
    engine.tick();
  };
  const view = (s: Session) => engine.getView(code, s.token);
  const byId = (id: string) => players.find((p) => p.playerId === id)!;
  return { engine, host, players, code, advance, view, byId };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe(code);
    return;
  }
  throw new Error(`expected GameError ${code}`);
}

/** Play the current round to its result, rating each drawing with `rating`. */
function playRound(ctx: ReturnType<typeof setup>, rating = 50) {
  const { engine, code, advance, view, byId } = ctx;
  advance(ROLE_REVEAL_MS);
  const judge = byId(view(ctx.host).match!.judgeId);
  engine.selectPrompt(code, judge.token, view(judge).suggestions![0]!);
  advance(DRAWING_MS);
  const gallery = view(judge).gallery!;
  engine.submitRatings(code, judge.token, Object.fromEntries(gallery.map((g) => [g.label, rating])));
  return judge;
}

describe("lobby rules", () => {
  it("cannot start with fewer than 3 players", () => {
    const { engine, host, code } = setup(2);
    expectCode(() => engine.startMatch(code, host.token), "NOT_ENOUGH_PLAYERS");
  });

  it("only the host can start, change cycles or remove players", () => {
    const { engine, players, code } = setup(3);
    expectCode(() => engine.startMatch(code, players[1]!.token), "FORBIDDEN");
    expectCode(() => engine.setCycles(code, players[1]!.token, 2), "FORBIDDEN");
    expectCode(() => engine.kick(code, players[1]!.token, players[2]!.playerId), "FORBIDDEN");
  });

  it("allows more than six players (no fixed cap)", () => {
    const { engine, host, code, view } = setup(9);
    engine.startMatch(code, host.token);
    expect(view(host).match!.totalRounds).toBe(9);
  });

  it("rejects cycles outside 1–3", () => {
    const { engine, host, code } = setup();
    expectCode(() => engine.setCycles(code, host.token, 4), "INVALID_INPUT");
  });

  it("locks the roster once a match starts", () => {
    const { engine, host, code } = setup();
    engine.startMatch(code, host.token);
    expectCode(() => engine.joinRoom(code, "Late Larry"), "MATCH_IN_PROGRESS");
  });

  it("reassigns the host when the host leaves", () => {
    const { engine, host, players, code, view } = setup();
    engine.leave(code, host.token);
    expect(view(players[1]!).hostId).toBe(players[1]!.playerId);
  });

  it("rejects an unknown room code", () => {
    const { engine } = setup();
    expectCode(() => engine.joinRoom("ZZZZZ", "Someone"), "ROOM_NOT_FOUND");
  });
});

describe("match flow", () => {
  it("total rounds = players × cycles and each player judges once per cycle", () => {
    const ctx = setup(4);
    ctx.engine.setCycles(ctx.code, ctx.host.token, 2);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    expect(ctx.view(ctx.host).match!.totalRounds).toBe(8);

    const judges: string[] = [];
    for (let r = 0; r < 8; r++) {
      judges.push(playRound(ctx).playerId);
      ctx.advance(ROUND_RESULT_MS);
    }
    expect(ctx.view(ctx.host).phase).toBe("FINAL_RESULT");
    const order = ctx.players.map((p) => p.playerId);
    expect(judges).toEqual([...order, ...order]);
  });

  it("awards each artist exactly their rating and the judge nothing", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.advance(ROLE_REVEAL_MS);
    const judge = ctx.byId(ctx.view(ctx.host).match!.judgeId);
    ctx.engine.selectPrompt(ctx.code, judge.token, "lighthouse");
    ctx.advance(DRAWING_MS);
    const gallery = ctx.view(judge).gallery!;
    const a = gallery[0]!;
    const b = gallery[1]!;
    ctx.engine.submitRatings(ctx.code, judge.token, { [a.label]: 86, [b.label]: 12 });

    const result = ctx.view(ctx.host).roundResult!;
    const scores = ctx.view(ctx.host).match!.scores;
    const artistA = result.entries.find((e) => e.label === a.label)!.artistId;
    const artistB = result.entries.find((e) => e.label === b.label)!.artistId;
    expect(scores[artistA]).toBe(86);
    expect(scores[artistB]).toBe(12);
    expect(scores[judge.playerId]).toBe(0);
    expect(result.winners).toEqual([artistA]);
  });

  it("announces co-winners on tied top ratings", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    playRound(ctx, 70);
    expect(ctx.view(ctx.host).roundResult!.winners).toHaveLength(2);
  });

  it("rejects missing, fractional and out-of-range ratings, and duplicate submissions", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.advance(ROLE_REVEAL_MS);
    const judge = ctx.byId(ctx.view(ctx.host).match!.judgeId);
    ctx.engine.selectPrompt(ctx.code, judge.token, "owl");
    ctx.advance(DRAWING_MS);
    const labels = ctx.view(judge).gallery!.map((g) => g.label);
    const a = labels[0]!;
    const b = labels[1]!;

    expectCode(() => ctx.engine.submitRatings(ctx.code, judge.token, { [a]: 50 }), "INVALID_INPUT");
    expectCode(() => ctx.engine.submitRatings(ctx.code, judge.token, { [a]: 50.5, [b]: 1 }), "INVALID_INPUT");
    expectCode(() => ctx.engine.submitRatings(ctx.code, judge.token, { [a]: 101, [b]: 1 }), "INVALID_INPUT");
    expectCode(() => ctx.engine.submitRatings(ctx.code, judge.token, { [a]: -1, [b]: 1 }), "INVALID_INPUT");

    ctx.engine.submitRatings(ctx.code, judge.token, { [a]: 100, [b]: 0 });
    expectCode(() => ctx.engine.submitRatings(ctx.code, judge.token, { [a]: 100, [b]: 100 }), "WRONG_PHASE");
    const total = Object.values(ctx.view(ctx.host).match!.scores).reduce((s, v) => s + v, 0);
    expect(total).toBe(100);
  });

  it("only the judge picks the word and the timeout auto-picks a suggestion", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.advance(ROLE_REVEAL_MS);
    const judgeId = ctx.view(ctx.host).match!.judgeId;
    const judge = ctx.byId(judgeId);
    const artist = ctx.players.find((p) => p.playerId !== judgeId)!;
    expectCode(() => ctx.engine.selectPrompt(ctx.code, artist.token, "cat"), "FORBIDDEN");
    const suggestions = ctx.view(judge).suggestions!;
    expect(new Set(suggestions).size).toBe(3);
    ctx.advance(WORD_SELECTION_MS);
    expect(ctx.view(ctx.host).phase).toBe("DRAWING");
    expect(suggestions).toContain(ctx.view(judge).prompt);
  });

  it("all artists receive the same custom word", () => {
    const ctx = setup(4);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.advance(ROLE_REVEAL_MS);
    const judgeId = ctx.view(ctx.host).match!.judgeId;
    ctx.engine.selectPrompt(ctx.code, ctx.byId(judgeId).token, "  banana   spaceship ");
    for (const p of ctx.players) expect(ctx.view(p).prompt).toBe("banana spaceship");
  });

  it("the judge runs out of time: grace window, then the round is replayed unscored", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.advance(ROLE_REVEAL_MS);
    const judge = ctx.byId(ctx.view(ctx.host).match!.judgeId);
    ctx.engine.selectPrompt(ctx.code, judge.token, "owl");
    ctx.advance(DRAWING_MS);
    ctx.advance(judgingSeconds(2) * 1000);
    expect(ctx.view(judge).judgingOvertime).toBe(true);
    ctx.advance(JUDGE_GRACE_MS);
    const v = ctx.view(ctx.host);
    expect(v.phase).toBe("ROLE_REVEAL");
    expect(v.match!.roundIndex).toBe(0);
    expect(v.match!.judgeId).toBe(judge.playerId);
    expect(Object.values(v.match!.scores).every((s) => s === 0)).toBe(true);
  });
});

describe("drawing privacy and canvas sync", () => {
  function toDrawing() {
    const ctx = setup(4);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.advance(ROLE_REVEAL_MS);
    const judgeId = ctx.view(ctx.host).match!.judgeId;
    const judge = ctx.byId(judgeId);
    ctx.engine.selectPrompt(ctx.code, judge.token, "owl");
    const artists = ctx.players.filter((p) => p.playerId !== judgeId);
    return { ...ctx, judge, artists };
  }
  const stroke = (id: string, points: number[]) => ({ type: "stroke", id, tool: "pen", color: "#e5484d", size: 8, points });

  it("artists see only their own canvas; the judge sees every canvas live and anonymously", () => {
    const ctx = toDrawing();
    ctx.engine.sendOps(ctx.code, ctx.artists[0]!.token, [stroke("s1", [10, 10, 50, 50])]);
    ctx.engine.sendOps(ctx.code, ctx.artists[0]!.token, [stroke("s1", [80, 90])]);

    const artistView = ctx.view(ctx.artists[1]!);
    expect(artistView.liveCanvases).toBeNull();
    expect(artistView.myCanvas!.canvas.actions).toHaveLength(0);
    expect(JSON.stringify(artistView)).not.toContain("80,90");

    const judgeView = ctx.view(ctx.judge);
    expect(judgeView.liveCanvases).toHaveLength(3);
    const drawn = judgeView.liveCanvases!.find((c) => c.canvas.actions.length > 0)!;
    expect(drawn.canvas.actions[0]!).toMatchObject({ type: "stroke", points: [10, 10, 50, 50, 80, 90] });
    const serialized = JSON.stringify(judgeView.liveCanvases);
    for (const a of ctx.artists) expect(serialized).not.toContain(a.playerId);
  });

  it("an Artist can resume after submitting while the drawing phase is active", () => {
    const ctx = toDrawing();
    expectCode(() => ctx.engine.sendOps(ctx.code, ctx.judge.token, [stroke("x", [1, 1])]), "FORBIDDEN");
    ctx.engine.submitCanvas(ctx.code, ctx.artists[0]!.token);
    expectCode(() => ctx.engine.sendOps(ctx.code, ctx.artists[0]!.token, [stroke("y", [1, 1])]), "FORBIDDEN");
    expect(ctx.view(ctx.host).phase).toBe("DRAWING");
    ctx.engine.submitCanvas(ctx.code, ctx.artists[0]!.token);
    expect(ctx.engine.sendOps(ctx.code, ctx.artists[0]!.token, [stroke("resumed", [2, 2])])).toBe(1);
    expect(ctx.engine.sendOps(ctx.code, ctx.artists[1]!.token, [stroke("z", [1, 1])])).toBe(1);
    ctx.advance(DRAWING_MS);
    expect(ctx.view(ctx.host).phase).toBe("JUDGING");
    expectCode(() => ctx.engine.sendOps(ctx.code, ctx.artists[1]!.token, [stroke("w", [1, 1])]), "WRONG_PHASE");
  });

  it("ends drawing immediately when every Artist submits", () => {
    const ctx = toDrawing();
    expect(ctx.view(ctx.host).deadline! - ctx.view(ctx.host).serverNow).toBe(75_000);
    expect(ctx.view(ctx.host).drawingStatus).toEqual({ ready: 0, total: 3 });

    for (const [index, artist] of ctx.artists.slice(0, -1).entries()) {
      ctx.engine.submitCanvas(ctx.code, artist.token);
      expect(ctx.view(ctx.host).phase).toBe("DRAWING");
      expect(ctx.view(ctx.host).drawingStatus).toEqual({ ready: index + 1, total: 3 });
    }
    ctx.engine.submitCanvas(ctx.code, ctx.artists.at(-1)!.token);

    expect(ctx.view(ctx.host).phase).toBe("JUDGING");
    expect(ctx.view(ctx.host).drawingStatus).toBeNull();
    expect(ctx.view(ctx.judge).gallery).toHaveLength(ctx.artists.length);
    expect(ctx.artists.every((artist) => ctx.view(artist).myCanvas?.locked)).toBe(true);
  });

  it("bucket fill, undo and clear sync as ordered ops", () => {
    const ctx = toDrawing();
    const a = ctx.artists[0]!;
    ctx.engine.sendOps(ctx.code, a.token, [
      stroke("s1", [10, 10, 20, 20]),
      { type: "fill", id: "f1", x: 300, y: 200, color: "#0090ff" },
      { type: "clear", id: "c1" },
      { type: "undo", id: "u1" },
    ]);
    const live = ctx.view(ctx.judge).liveCanvases!.find((c) => c.canvas.actions.length > 0)!;
    expect(live.canvas.actions.map((x) => x.type)).toEqual(["stroke", "fill"]);
    expect(live.canvas.resets).toBe(1);
  });

  it("drops malformed ops and clamps coordinates", () => {
    const ctx = toDrawing();
    const accepted = ctx.engine.sendOps(ctx.code, ctx.artists[0]!.token, [
      { type: "stroke", id: "bad", tool: "laser", color: "#000000", size: 4, points: [1, 1] },
      { type: "fill", id: "bad2", x: 1, y: 1, color: "red" },
      stroke("ok", [-50, 9999]),
    ]);
    expect(accepted).toBe(1);
    const live = ctx.view(ctx.judge).liveCanvases!.find((c) => c.canvas.actions.length > 0)!;
    expect(live.canvas.actions[0]!).toMatchObject({ points: [0, 450] });
  });

  it("identities stay hidden from the judge during judging and are revealed after rating", () => {
    const ctx = toDrawing();
    const liveCanvases = ctx.view(ctx.judge).liveCanvases!;
    ctx.advance(DRAWING_MS);
    const judging = ctx.view(ctx.judge);
    expect(judging.gallery!.map((g) => g.label)).toEqual(liveCanvases.map((g) => g.label));
    expect(judging.gallery!.map((g) => g.label)).toEqual(["Drawing 1", "Drawing 2", "Drawing 3"]);
    const anonymousGallery = JSON.stringify(judging.gallery);
    for (const artist of ctx.artists) {
      expect(anonymousGallery).not.toContain(artist.playerId);
      expect(anonymousGallery).not.toContain(`Player ${ctx.players.indexOf(artist)}`);
    }
    expect(judging.roundResult).toBeNull();
    expect(judging.prompt).toBe("owl");
    ctx.engine.submitRatings(ctx.code, ctx.judge.token, { "Drawing 1": 1, "Drawing 2": 2, "Drawing 3": 3 });
    const revealed = ctx.view(ctx.judge).roundResult!;
    expect(revealed.entries.map((e) => e.artistId).sort()).toEqual(ctx.artists.map((a) => a.playerId).sort());
  });
});

describe("disconnects", () => {
  it("pauses when a required player drops and resumes with the remaining time", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.advance(ROLE_REVEAL_MS);
    const judge = ctx.byId(ctx.view(ctx.host).match!.judgeId);
    ctx.advance(10_000);
    ctx.engine.disconnect(ctx.code, judge.token);
    expect(ctx.view(ctx.host).pause).not.toBeNull();
    ctx.advance(20_000);
    expect(ctx.view(ctx.host).phase).toBe("WORD_SELECTION");
    ctx.engine.resume(ctx.code, judge.token);
    const v = ctx.view(ctx.host);
    expect(v.pause).toBeNull();
    expect(v.deadline! - v.serverNow).toBe(WORD_SELECTION_MS - 10_000);
  });

  it("interrupts the match without a winner if the player doesn't return", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.engine.disconnect(ctx.code, ctx.players[2]!.token);
    ctx.advance(RECONNECT_WINDOW_MS);
    const v = ctx.view(ctx.host);
    expect(v.phase).toBe("MATCH_INTERRUPTED");
    expect(v.match).toBeNull();
    expect(v.finalResult).toBeNull();
  });

  it("a player leaving mid-match interrupts it", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    ctx.engine.leave(ctx.code, ctx.players[1]!.token);
    expect(ctx.view(ctx.host).phase).toBe("MATCH_INTERRUPTED");
  });
});

describe("rematch", () => {
  it("returns to the lobby with scores reset", () => {
    const ctx = setup(3);
    ctx.engine.startMatch(ctx.code, ctx.host.token);
    for (let r = 0; r < 3; r++) {
      playRound(ctx, 40);
      ctx.advance(ROUND_RESULT_MS);
    }
    const final = ctx.view(ctx.host).finalResult!;
    expect(final.rounds).toBe(3);
    expect(final.standings.every((s) => s.score === 80)).toBe(true);
    expect(final.winners).toHaveLength(3);
    ctx.engine.rematch(ctx.code, ctx.host.token);
    expect(ctx.view(ctx.host).phase).toBe("LOBBY");
    expect(ctx.view(ctx.host).match).toBeNull();
  });
});
