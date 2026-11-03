import {
  DRAWING_MS,
  NAME_MAX,
  NAME_MIN,
  PROMPT_MAX,
  ROLE_REVEAL_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROUND_RESULT_MS,
} from "./constants";
import type { Cycles, Standing } from "@drawoff/contracts";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Fair deterministic rotation: judge = players[r % N]. */
export function judgeForRound(order: readonly string[], roundIndex: number): string {
  return order[roundIndex % order.length]!;
}

export function artistsForRound(order: readonly string[], roundIndex: number): string[] {
  const judge = judgeForRound(order, roundIndex);
  return order.filter((id) => id !== judge);
}

export function totalRounds(playerCount: number, cycles: Cycles): number {
  return playerCount * cycles;
}

export function cycleOfRound(playerCount: number, roundIndex: number): number {
  return Math.floor(roundIndex / playerCount) + 1;
}

/** Judging budget scales with the number of drawings. */
export function judgingSeconds(artistCount: number): number {
  return Math.max(45, 15 * artistCount);
}

export function maxScorePerPlayer(playerCount: number, cycles: Cycles): number {
  return 100 * (playerCount - 1) * cycles;
}

/** Rough match estimate in seconds (labelled as an estimate in the UI). */
export function estimateMatchSeconds(playerCount: number, cycles: Cycles): number {
  if (playerCount < 1) return 0;
  const artists = Math.max(playerCount - 1, 1);
  const perRound =
    ROLE_REVEAL_MS / 1000 +
    12 + // typical word choice
    DRAWING_MS / 1000 +
    Math.round(judgingSeconds(artists) * 0.6) +
    ROUND_RESULT_MS / 1000;
  return perRound * totalRounds(playerCount, cycles);
}

export function isValidCycles(value: unknown): value is Cycles {
  return value === 1 || value === 2 || value === 3;
}

export function validateName(raw: string): Result<string> {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < NAME_MIN || value.length > NAME_MAX) {
    return { ok: false, error: `Name must be ${NAME_MIN}–${NAME_MAX} characters.` };
  }
  if (/[<>]/.test(value)) return { ok: false, error: "Name can't contain < or >." };
  return { ok: true, value };
}

export function validatePrompt(raw: string): Result<string> {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < 1) return { ok: false, error: "Enter a word or phrase." };
  if (value.length > PROMPT_MAX) {
    return { ok: false, error: `Keep it to ${PROMPT_MAX} characters.` };
  }
  if (/[<>{}]/.test(value)) return { ok: false, error: "No markup characters, please." };
  return { ok: true, value };
}

export function isValidRating(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** Every label must have exactly one valid integer 0–100 rating; no extras. */
export function validateRatings(
  labels: readonly string[],
  ratings: Record<string, unknown>,
): Result<Record<string, number>> {
  const keys = Object.keys(ratings);
  if (keys.length !== labels.length || !labels.every((l) => l in ratings)) {
    return { ok: false, error: "Every drawing needs exactly one rating." };
  }
  for (const label of labels) {
    if (!isValidRating(ratings[label])) {
      return { ok: false, error: `${label} needs a whole number from 0 to 100.` };
    }
  }
  return { ok: true, value: ratings as Record<string, number> };
}

/** Ids with the highest value; ties produce co-winners. */
export function topIds(values: Record<string, number>): string[] {
  const entries = Object.entries(values);
  if (entries.length === 0) return [];
  const best = Math.max(...entries.map(([, v]) => v));
  return entries.filter(([, v]) => v === best).map(([id]) => id);
}

export function standings(scores: Record<string, number>, order: readonly string[]): Standing[] {
  return order
    .map((playerId) => ({ playerId, score: scores[playerId] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

export function normalizeRoomCode(raw: string): string {
  const trimmed = raw.trim();
  // Accept a full invite link as well as a bare code.
  const fromLink = trimmed.match(/\/room\/([A-Za-z0-9]+)/);
  return (fromLink?.[1] ?? trimmed).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function generateRoomCode(random: () => number): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)]!;
  }
  return code;
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
