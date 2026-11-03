import { describe, expect, it } from "vitest";
import {
  artistsForRound,
  judgeForRound,
  judgingSeconds,
  maxScorePerPlayer,
  normalizeRoomCode,
  topIds,
  totalRounds,
  validateName,
  validatePrompt,
  validateRoomCode,
  validateRatings,
} from "./rules";
import { pickSuggestions } from "./prompts";

describe("rotation", () => {
  const order = ["a", "b", "c"];
  it("judge is players[r % N] and everyone else draws", () => {
    expect([0, 1, 2, 3].map((r) => judgeForRound(order, r))).toEqual(["a", "b", "c", "a"]);
    expect(artistsForRound(order, 1)).toEqual(["a", "c"]);
  });
  it("rounds = N × cycles", () => {
    expect(totalRounds(3, 1)).toBe(3);
    expect(totalRounds(5, 2)).toBe(10);
    expect(totalRounds(12, 3)).toBe(36);
  });
  it("max score = 100 × (N − 1) × cycles", () => {
    expect(maxScorePerPlayer(5, 2)).toBe(800);
  });
});

describe("judging budget", () => {
  it("is max(45, 15 × artists) seconds", () => {
    expect(judgingSeconds(2)).toBe(45);
    expect(judgingSeconds(3)).toBe(45);
    expect(judgingSeconds(14)).toBe(210);
  });
});

describe("validation", () => {
  it("names must be 2–20 characters", () => {
    expect(validateName("A").ok).toBe(false);
    expect(validateName("  Al  ")).toEqual({ ok: true, value: "Al" });
    expect(validateName("x".repeat(21)).ok).toBe(false);
  });
  it("prompts are 1–40 trimmed characters without markup", () => {
    expect(validatePrompt("   ").ok).toBe(false);
    expect(validatePrompt("x".repeat(40)).ok).toBe(true);
    expect(validatePrompt("x".repeat(41)).ok).toBe(false);
    expect(validatePrompt("<b>cat</b>").ok).toBe(false);
  });
  it("ratings must cover every drawing with integers 0–100", () => {
    expect(validateRatings(["D1", "D2"], { D1: 0, D2: 100 }).ok).toBe(true);
    expect(validateRatings(["D1", "D2"], { D1: 0 }).ok).toBe(false);
    expect(validateRatings(["D1"], { D1: 3.5 }).ok).toBe(false);
    expect(validateRatings(["D1"], { D1: 0, D9: 4 }).ok).toBe(false);
  });
});

describe("misc", () => {
  it("ties produce co-winners", () => {
    expect(topIds({ a: 5, b: 9, c: 9 }).sort()).toEqual(["b", "c"]);
  });
  it("accepts codes or invite links, case-insensitively", () => {
    expect(normalizeRoomCode(" ab12c ")).toBe("AB12C");
    expect(normalizeRoomCode("https://x.app/room/qwe23?x=1")).toBe("QWE23");
  });
  it("validates normalized mock and server room codes", () => {
    expect(validateRoomCode(" ab-12c ")).toEqual({ ok: true, value: "AB12C" });
    expect(validateRoomCode("https://x.app/room/qwe123?x=1")).toEqual({ ok: true, value: "QWE123" });
    expect(validateRoomCode("AB12")).toEqual({ ok: false, error: "Enter a valid room code or invite link." });
    expect(validateRoomCode("TOO-LONG")).toEqual({ ok: false, error: "Enter a valid room code or invite link." });
  });
  it("offers three distinct suggestions", () => {
    const s = pickSuggestions(Math.random);
    expect(new Set(s).size).toBe(3);
  });
});
