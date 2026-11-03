import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MAX_ACTIONS_PER_CANVAS,
  MAX_BRUSH,
  MAX_OPS_PER_BATCH,
  MAX_POINTS_PER_OP,
  MAX_POINTS_PER_STROKE,
} from "./constants";
import type { CanvasSnapshot, DrawOp } from "./types";

export function emptyCanvas(): CanvasSnapshot {
  return { actions: [], rev: 0, resets: 0 };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const clampX = (v: number) => Math.min(CANVAS_WIDTH, Math.max(0, Math.round(v)));
const clampY = (v: number) => Math.min(CANVAS_HEIGHT, Math.max(0, Math.round(v)));

/** Validate + normalize an inbound op. Returns null for anything malformed. */
export function sanitizeOp(op: unknown): DrawOp | null {
  if (!op || typeof op !== "object") return null;
  const o = op as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"].length < 1 || o["id"].length > 64) return null;
  switch (o["type"]) {
    case "stroke": {
      if (o["tool"] !== "pen" && o["tool"] !== "eraser") return null;
      if (typeof o["color"] !== "string" || !HEX.test(o["color"])) return null;
      if (typeof o["size"] !== "number" || !Number.isFinite(o["size"])) return null;
      if (!Array.isArray(o["points"]) || o["points"].length % 2 !== 0) return null;
      if (o["points"].length === 0 || o["points"].length > MAX_POINTS_PER_OP) return null;
      if (!o["points"].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
      const points = (o["points"] as number[]).map((n, i) => (i % 2 === 0 ? clampX(n) : clampY(n)));
      const size = Math.min(MAX_BRUSH, Math.max(1, Math.round(o["size"])));
      return { type: "stroke", id: o["id"], tool: o["tool"], color: o["color"], size, points };
    }
    case "fill": {
      if (typeof o["color"] !== "string" || !HEX.test(o["color"])) return null;
      if (typeof o["x"] !== "number" || typeof o["y"] !== "number") return null;
      if (!Number.isFinite(o["x"]) || !Number.isFinite(o["y"])) return null;
      return { type: "fill", id: o["id"], x: clampX(o["x"]), y: clampY(o["y"]), color: o["color"] };
    }
    case "clear":
      return { type: "clear", id: o["id"] };
    case "undo":
      return { type: "undo", id: o["id"] };
    default:
      return null;
  }
}

/**
 * Apply a batch of ops to a canvas, mutating it. Ops are applied in order so
 * every viewer that replays the same sequence reaches the same state.
 * Returns the number of ops accepted.
 */
export function applyOps(canvas: CanvasSnapshot, rawOps: unknown[]): number {
  let accepted = 0;
  for (const raw of rawOps.slice(0, MAX_OPS_PER_BATCH)) {
    const op = sanitizeOp(raw);
    if (!op) continue;
    if (op.type === "undo") {
      if (canvas.actions.length > 0) {
        canvas.actions.pop();
        canvas.resets++;
        accepted++;
      }
      continue;
    }
    if (op.type === "stroke") {
      const last = canvas.actions[canvas.actions.length - 1];
      if (last && last.type === "stroke" && last.id === op.id) {
        if (last.points.length + op.points.length > MAX_POINTS_PER_STROKE) continue;
        last.points.push(...op.points);
        accepted++;
        continue;
      }
    }
    if (canvas.actions.length >= MAX_ACTIONS_PER_CANVAS) continue;
    canvas.actions.push(op.type === "stroke" ? { ...op, points: [...op.points] } : op);
    accepted++;
  }
  if (accepted > 0) canvas.rev++;
  return accepted;
}

/** Deep copy so a view never aliases mutable backend state. */
export function cloneCanvas(canvas: CanvasSnapshot): CanvasSnapshot {
  return {
    rev: canvas.rev,
    resets: canvas.resets,
    actions: canvas.actions.map((a) => (a.type === "stroke" ? { ...a, points: [...a.points] } : a)),
  };
}
