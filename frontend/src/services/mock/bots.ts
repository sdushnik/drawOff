/** Simulated players for the mock backend. They act only through the engine's public API. */
import { CANVAS_HEIGHT, CANVAS_WIDTH, PALETTE } from "@/game/constants";
import type { GameEngine } from "@/game/engine";
import type { DrawOp } from "@/game/types";

export const BOT_NAMES = [
  "Pixel Pete",
  "Sketchy Sam",
  "Doodle Dana",
  "Crayon Kai",
  "Inky Iris",
  "Brushy Bo",
  "Scribble Sue",
  "Marker Max",
  "Pastel Pia",
  "Chalky Cho",
];

interface DrawPlan {
  strokeId: string | null;
  queue: number[];
  color: string;
  size: number;
  idleTicks: number;
  fillAfter: { x: number; y: number } | null;
  submitAt: number | null;
}

const INK = PALETTE.filter((c) => c !== "#ffffff");

export class BotDirector {
  private plans = new Map<string, DrawPlan>();
  private seq = 0;

  constructor(
    private engine: GameEngine,
    private random: () => number = Math.random,
  ) {}

  step(code: string) {
    const room = this.engine.getRoom(code);
    if (!room || room.pause || !room.match) return;
    const now = this.engine.now();
    const elapsed = now - room.phaseStartedAt;
    const round = room.match.round;

    for (const bot of room.players) {
      if (!bot.isBot || !bot.connected) continue;
      try {
        if (room.phase === "WORD_SELECTION" && round.judgeId === bot.id && elapsed > 2500) {
          const s = round.suggestions;
          this.engine.selectPrompt(code, bot.token, this.pick(s));
          return; // phase changed
        }
        if (room.phase === "DRAWING" && round.artistIds.includes(bot.id)) {
          this.draw(code, bot.id, bot.token, elapsed, room.deadline ? room.deadline - now : 0);
        }
        if (room.phase === "JUDGING" && round.judgeId === bot.id) {
          if (elapsed > 3500 + round.drawings.length * 700) {
            const ratings: Record<string, number> = {};
            for (const d of round.drawings) ratings[d.label] = 20 + Math.floor(this.random() * 81);
            this.engine.submitRatings(code, bot.token, ratings);
            return;
          }
        }
      } catch {
        // Bots ignore rejected actions (e.g. phase just changed).
      }
    }
    if (room.phase !== "DRAWING") this.plans.clear();
  }

  private draw(code: string, botId: string, token: string, elapsed: number, remaining: number) {
    const drawing = this.engine.getRoom(code)?.match?.round.drawings.find((d) => d.artistId === botId);
    if (!drawing || drawing.locked || elapsed < 1200) return;

    let plan: DrawPlan | undefined = this.plans.get(botId);
    if (!plan) {
      plan = {
        strokeId: null,
        queue: [],
        color: "#1f1b16",
        size: 6,
        idleTicks: 0,
        fillAfter: null,
        submitAt: this.random() < 0.35 ? 42_000 + this.random() * 12_000 : null,
      };
      this.plans.set(botId, plan);
    }
    if (plan.submitAt !== null && elapsed > plan.submitAt) {
      this.engine.submitCanvas(code, token);
      return;
    }
    if (remaining < 1500) return;
    if (plan.idleTicks > 0) {
      plan.idleTicks--;
      return;
    }

    const ops: DrawOp[] = [];
    if (plan.queue.length === 0) {
      if (plan.fillAfter) {
        ops.push({ type: "fill", id: this.id(), x: plan.fillAfter.x, y: plan.fillAfter.y, color: this.pick(INK) });
        plan.fillAfter = null;
      }
      this.newShape(plan);
      plan.idleTicks = 4 + Math.floor(this.random() * 12);
    }
    const take = 2 * (3 + Math.floor(this.random() * 4));
    const points = plan.queue.splice(0, take);
    if (points.length >= 2) {
      ops.push({ type: "stroke", id: plan.strokeId!, tool: "pen", color: plan.color, size: plan.size, points });
      // Keep the next chunk connected to this one.
      if (plan.queue.length > 0) plan.queue.unshift(points[points.length - 2]!, points[points.length - 1]!);
    }
    if (ops.length) this.engine.sendOps(code, token, ops);
  }

  private newShape(plan: DrawPlan) {
    const r = this.random;
    const cx = 80 + r() * (CANVAS_WIDTH - 160);
    const cy = 70 + r() * (CANVAS_HEIGHT - 140);
    const size = 30 + r() * 90;
    const pts: number[] = [];
    const kind = Math.floor(r() * 5);
    plan.fillAfter = null;
    if (kind === 0) {
      for (let a = 0; a <= Math.PI * 2 + 0.2; a += 0.25) pts.push(cx + Math.cos(a) * size, cy + Math.sin(a) * size);
      if (r() < 0.6) plan.fillAfter = { x: cx, y: cy };
    } else if (kind === 1) {
      for (let x = -size * 1.5; x <= size * 1.5; x += 10) pts.push(cx + x, cy + Math.sin(x / 14) * size * 0.35);
    } else if (kind === 2) {
      for (let a = 0; a < Math.PI * 6; a += 0.3) {
        const rr = (a / (Math.PI * 6)) * size;
        pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
    } else if (kind === 3) {
      const corners: [number, number][] = [
        [cx - size, cy - size * 0.7],
        [cx + size, cy - size * 0.7],
        [cx + size, cy + size * 0.7],
        [cx - size, cy + size * 0.7],
        [cx - size, cy - size * 0.7],
      ];
      for (let i = 0; i < corners.length - 1; i++) {
        for (let t = 0; t <= 1; t += 0.2) {
          const [ax, ay] = corners[i]!;
          const [bx, by] = corners[i + 1]!;
          pts.push(ax + (bx - ax) * t, ay + (by - ay) * t);
        }
      }
      if (r() < 0.5) plan.fillAfter = { x: cx, y: cy };
    } else {
      for (let i = 0; i < 9; i++) pts.push(cx - size + (i * size) / 4, cy + (i % 2 === 0 ? -1 : 1) * size * 0.3);
    }
    plan.queue = pts.map((n) => Math.round(n));
    plan.strokeId = this.id();
    plan.color = this.pick(INK);
    plan.size = this.pick([3, 6, 10, 14]);
  }

  private pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.random() * arr.length)]!;
  }

  private id() {
    return `b${++this.seq}_${Math.floor(this.random() * 1e6).toString(36)}`;
  }
}
