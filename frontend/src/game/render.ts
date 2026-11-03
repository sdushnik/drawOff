import { CANVAS_BACKGROUND, CANVAS_HEIGHT, CANVAS_WIDTH } from "./constants";
import { floodFill, hexToRgba } from "./floodFill";
import type { CanvasAction, CanvasSnapshot } from "@drawoff/contracts";

/**
 * Incremental canvas renderer. Replays only what changed since the last call;
 * redraws from scratch when history was rewritten (undo).
 */
export class CanvasRenderer {
  private resets = -1;
  private count = 0;
  private lastPoints = 0;

  constructor(private ctx: CanvasRenderingContext2D) {}

  render(snapshot: CanvasSnapshot) {
    const actions = snapshot.actions;
    if (snapshot.resets !== this.resets || actions.length < this.count) {
      this.resets = snapshot.resets;
      this.count = 0;
      this.lastPoints = 0;
      this.paintBackground();
    }
    // Continue the previously last stroke if it grew.
    if (this.count > 0) {
      const prev = actions[this.count - 1];
      if (prev && prev.type === "stroke" && prev.points.length > this.lastPoints) {
        this.drawStroke(prev, Math.max(0, this.lastPoints - 2));
        this.lastPoints = prev.points.length;
      }
    }
    for (let i = this.count; i < actions.length; i++) {
      const a = actions[i]!;
      this.drawAction(a);
      this.lastPoints = a.type === "stroke" ? a.points.length : 0;
    }
    this.count = actions.length;
  }

  private paintBackground() {
    this.ctx.fillStyle = CANVAS_BACKGROUND;
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  private drawAction(a: CanvasAction) {
    if (a.type === "clear") return this.paintBackground();
    if (a.type === "fill") {
      const img = this.ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      floodFill(img.data, CANVAS_WIDTH, CANVAS_HEIGHT, a.x, a.y, hexToRgba(a.color));
      this.ctx.putImageData(img, 0, 0);
      return;
    }
    this.drawStroke(a, 0);
  }

  private drawStroke(a: Extract<CanvasAction, { type: "stroke" }>, from: number) {
    const ctx = this.ctx;
    const p = a.points;
    const color = a.tool === "eraser" ? CANVAS_BACKGROUND : a.color;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = a.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (p.length === 2) {
      ctx.beginPath();
      ctx.arc(p[0]!, p[1]!, a.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(p[from]!, p[from + 1]!);
    for (let i = from + 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    ctx.stroke();
  }
}
