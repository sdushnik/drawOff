/**
 * Shared domain types for DrawOff. These are transport-agnostic: the mock
 * backend and a future real backend (e.g. Socket.IO) exchange exactly these shapes.
 */

export type Phase =
  | "LOBBY"
  | "ROLE_REVEAL"
  | "WORD_SELECTION"
  | "DRAWING"
  | "JUDGING"
  | "ROUND_RESULT"
  | "FINAL_RESULT"
  | "MATCH_INTERRUPTED";

export type Cycles = 1 | 2 | 3;

export type DrawTool = "pen" | "eraser" | "fill";

/**
 * Canvas operations. Points are a flat [x0, y0, x1, y1, ...] array in canvas pixels.
 * A `stroke` op whose id already exists appends its points to that stroke (live streaming).
 * `undo` removes the last action; `clear` is itself an (undoable) action.
 */
export type DrawOp =
  | {
      type: "stroke";
      id: string;
      tool: "pen" | "eraser";
      color: string;
      size: number;
      points: number[];
    }
  | { type: "fill"; id: string; x: number; y: number; color: string }
  | { type: "clear"; id: string }
  | { type: "undo"; id: string };

/** An action stored on a canvas (undo is resolved, never stored). */
export type CanvasAction = Exclude<DrawOp, { type: "undo" }>;

export interface CanvasSnapshot {
  actions: CanvasAction[];
  /** Increments on every change. */
  rev: number;
  /** Increments when history is rewritten (undo); renderers must redraw from scratch. */
  resets: number;
}

export interface Session {
  roomCode: string;
  playerId: string;
  token: string;
}

export interface PlayerSummary {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  isBot: boolean;
}

export interface LiveCanvas {
  label: string;
  canvas: CanvasSnapshot;
  locked: boolean;
}

export interface RoundResultEntry {
  label: string;
  artistId: string;
  rating: number;
  canvas: CanvasSnapshot;
}

export interface RoundResult {
  roundIndex: number;
  prompt: string;
  judgeId: string;
  entries: RoundResultEntry[];
  winners: string[];
}

export interface Standing {
  playerId: string;
  score: number;
}

export interface FinalResult {
  winners: string[];
  standings: Standing[];
  rounds: number;
  cycles: Cycles;
}

/**
 * What a single player is allowed to see. The backend builds this per player,
 * so privacy rules (artists never see each other, the judge never sees identities
 * before ratings are final) are enforced before data leaves the server.
 */
export interface PlayerView {
  roomCode: string;
  serverNow: number;
  me: PlayerSummary;
  players: PlayerSummary[];
  hostId: string;
  cycles: Cycles;
  phase: Phase;
  deadline: number | null;
  pause: { playerName: string; until: number } | null;
  notice: string | null;
  match: {
    roundIndex: number;
    totalRounds: number;
    cycle: number;
    judgeId: string;
    artistIds: string[];
    order: string[];
    scores: Record<string, number>;
  } | null;
  role: "judge" | "artist" | null;
  prompt: string | null;
  suggestions: string[] | null;
  myCanvas: { canvas: CanvasSnapshot; locked: boolean } | null;
  liveCanvases: LiveCanvas[] | null;
  gallery: { label: string; canvas: CanvasSnapshot }[] | null;
  judgingOvertime: boolean;
  roundResult: RoundResult | null;
  finalResult: FinalResult | null;
  interruptedReason: string | null;
}
