export const MIN_PLAYERS = 3;
export const CYCLE_OPTIONS = [1, 2, 3] as const;

export const NAME_MIN = 2;
export const NAME_MAX = 20;
export const PROMPT_MAX = 40;

export const CANVAS_WIDTH = 600;
export const CANVAS_HEIGHT = 450;
export const CANVAS_BACKGROUND = "#ffffff";

export const ROLE_REVEAL_MS = 4_000;
export const WORD_SELECTION_MS = 30_000;
export const DRAWING_MS = 60_000;
export const ROUND_RESULT_MS = 12_000;
export const JUDGE_GRACE_MS = 15_000;
export const RECONNECT_WINDOW_MS = 30_000;
export const INTERRUPTED_MS = 8_000;

/** Network/resource safety bounds (operational limits, not gameplay caps). */
export const MAX_OPS_PER_BATCH = 60;
export const MAX_POINTS_PER_OP = 600;
export const MAX_ACTIONS_PER_CANVAS = 4_000;
export const MAX_POINTS_PER_STROKE = 20_000;
export const MAX_BRUSH = 60;

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 5;

/** Drawing palette (artwork content colors, not UI theme). */
export const PALETTE = [
  "#1f1b16",
  "#ffffff",
  "#e5484d",
  "#f76b15",
  "#ffc53d",
  "#46a758",
  "#12a594",
  "#0090ff",
  "#6e56cf",
  "#d6409f",
  "#8d5a3b",
  "#9e9e9e",
] as const;

export const BRUSH_SIZES = [3, 8, 16, 32] as const;
