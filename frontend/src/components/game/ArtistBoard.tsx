import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Eraser, PaintBucket, Pencil, Send, Trash2, Undo2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyOps, cloneCanvas } from "@/game/canvasOps";
import { BRUSH_SIZES, CANVAS_HEIGHT, CANVAS_WIDTH, PALETTE } from "@/game/constants";
import { CanvasRenderer } from "@/game/render";
import type { CanvasSnapshot, DrawOp, DrawTool } from "@drawoff/contracts";
import { cn } from "@/lib/utils";

const FLUSH_MS = 80;
const MAX_MERGED_POINTS = 500;

let uid = 0;
const newId = () => `${Date.now().toString(36)}${(uid++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Props {
  initial: CanvasSnapshot;
  locked: boolean;
  timeUp: boolean;
  onSend: (ops: DrawOp[]) => Promise<void>;
  onSubmit: () => Promise<unknown>;
}

export function mapPointerToCanvas(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
): [number, number] {
  if (rect.width <= 0 || rect.height <= 0) return [0, 0];
  return [
    Math.min(CANVAS_WIDTH, Math.max(0, Math.round(((clientX - rect.left) / rect.width) * CANVAS_WIDTH))),
    Math.min(CANVAS_HEIGHT, Math.max(0, Math.round(((clientY - rect.top) / rect.height) * CANVAS_HEIGHT))),
  ];
}

/**
 * The artist's private canvas. Draws locally for zero latency and streams the
 * exact same ops (batched) to the backend, which relays them to the judge only.
 */
export function ArtistBoard({ initial, locked, timeUp, onSend, onSubmit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<CanvasRenderer | null>(null);
  const local = useRef<CanvasSnapshot>(cloneCanvas(initial));
  const queue = useRef<DrawOp[]>([]);
  const activeStroke = useRef<string | null>(null);
  const lastPoint = useRef<[number, number] | null>(null);
  const frame = useRef<number | null>(null);
  const sendSequence = useRef<Promise<void>>(Promise.resolve());

  const [tool, setTool] = useState<DrawTool>("pen");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [size, setSize] = useState<number>(BRUSH_SIZES[1]);
  const [actionCount, setActionCount] = useState(initial.actions.length);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const disabled = locked || timeUp || submitted || submitting;
  const blocked = useRef(disabled);
  const externallyDisabled = useRef(locked || timeUp);
  externallyDisabled.current = locked || timeUp;

  useEffect(() => {
    blocked.current = disabled;
  }, [disabled]);

  const paint = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!renderer.current) {
        const ctx = canvasRef.current?.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        renderer.current = new CanvasRenderer(ctx);
      }
      renderer.current.render(local.current);
      setActionCount(local.current.actions.length);
    });
  }, []);

  useEffect(() => {
    paint();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [paint]);

  const flush = useCallback(() => {
    const sending = sendSequence.current.then(async () => {
      while (queue.current.length > 0) {
        const batch = queue.current.splice(0, 60);
        try {
          await onSend(batch);
        } catch (error) {
          queue.current.unshift(...batch);
          throw error;
        }
      }
    });
    sendSequence.current = sending.catch(() => undefined);
    return sending;
  }, [onSend]);

  useEffect(() => {
    const id = setInterval(flush, FLUSH_MS);
    return () => {
      clearInterval(id);
      flush();
    };
  }, [flush]);

  const emit = (op: DrawOp) => {
    if (blocked.current) return;
    applyOps(local.current, [op]);
    const last = queue.current[queue.current.length - 1];
    if (
      op.type === "stroke" &&
      last?.type === "stroke" &&
      last.id === op.id &&
      last.points.length < MAX_MERGED_POINTS
    ) {
      last.points.push(...op.points);
    } else {
      queue.current.push(op.type === "stroke" ? { ...op, points: [...op.points] } : op);
    }
    paint();
  };

  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (blocked.current) return;
    e.preventDefault();
    const [x, y] = mapPointerToCanvas(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    if (tool === "fill") {
      emit({ type: "fill", id: newId(), x, y, color });
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const id = newId();
    activeStroke.current = id;
    lastPoint.current = [x, y];
    emit({ type: "stroke", id, tool, color: tool === "eraser" ? "#ffffff" : color, size, points: [x, y] });
  };

  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const id = activeStroke.current;
    if (!id || blocked.current) return;
    const [x, y] = mapPointerToCanvas(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    const prev = lastPoint.current;
    if (prev && Math.abs(prev[0] - x) + Math.abs(prev[1] - y) < 2) return;
    lastPoint.current = [x, y];
    emit({ type: "stroke", id, tool: tool === "eraser" ? "eraser" : "pen", color: tool === "eraser" ? "#ffffff" : color, size, points: [x, y] });
  };

  const onUp = () => {
    activeStroke.current = null;
    lastPoint.current = null;
  };

  useEffect(() => {
    if (disabled) onUp();
  }, [disabled]);

  const submit = async () => {
    if (blocked.current) return;
    blocked.current = true;
    setSubmitted(true);
    setSubmitting(true);
    let accepted = true;
    try {
      await flush();
      const result = await onSubmit();
      if (result === false) {
        accepted = false;
        setSubmitted(false);
      }
    } catch {
      accepted = false;
      setSubmitted(false);
    } finally {
      setSubmitting(false);
      blocked.current = externallyDisabled.current || accepted;
    }
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
      <div className="relative min-w-0 flex-1">
        <div className={cn("sticker overflow-hidden p-0", disabled && "opacity-95")}>
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            aria-label="Your canvas"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            className={cn(
              "canvas-surface block aspect-[4/3] h-auto w-full touch-none overscroll-contain",
              disabled ? "cursor-not-allowed" : tool === "fill" ? "cursor-cell" : "cursor-crosshair",
            )}
          />
        </div>
        {disabled && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span
              className="sticker animate-pop inline-flex items-center gap-2 bg-secondary px-4 py-2 font-display text-lg font-bold"
              role="status"
              aria-live="polite"
            >
              <Lock className="size-5" /> {locked || submitted ? "Submitted!" : "Pencils down!"}
            </span>
          </div>
        )}
      </div>

      <aside className="sticker flex flex-wrap items-center gap-3 p-3 lg:w-56 lg:flex-col lg:items-stretch">
        <div className="flex gap-1.5" role="group" aria-label="Tools">
          {(
            [
              ["pen", Pencil, "Pen"],
              ["eraser", Eraser, "Eraser"],
              ["fill", PaintBucket, "Bucket fill"],
            ] as const
          ).map(([t, Icon, label]) => (
            <Button
              key={t}
              variant="tool"
              size="icon"
              data-active={tool === t}
              aria-pressed={tool === t}
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={() => setTool(t)}
            >
              <Icon />
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-6 gap-1.5" role="group" aria-label="Colors">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              disabled={disabled}
              onClick={() => {
                setColor(c);
                if (tool === "eraser") setTool("pen");
              }}
              className={cn(
                "size-7 cursor-pointer rounded-full border-2 border-ink transition-transform hover:scale-110 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink disabled:cursor-not-allowed",
                color === c && "ring-2 ring-ink ring-offset-2 ring-offset-card scale-110",
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <div className="flex items-center gap-1.5" role="group" aria-label="Brush size">
          {BRUSH_SIZES.map((s) => (
            <Button
              key={s}
              variant="tool"
              size="icon"
              data-active={size === s}
              aria-pressed={size === s}
              aria-label={`Brush ${s}px`}
              disabled={disabled}
              onClick={() => setSize(s)}
            >
              <span className="rounded-full bg-current" style={{ width: Math.min(s, 24) / 1.2 + 2, height: Math.min(s, 24) / 1.2 + 2 }} />
            </Button>
          ))}
        </div>

        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" disabled={disabled || actionCount === 0} onClick={() => emit({ type: "undo", id: newId() })}>
            <Undo2 /> Undo
          </Button>
          <Button variant="outline" size="sm" disabled={disabled || actionCount === 0} onClick={() => emit({ type: "clear", id: newId() })}>
            <Trash2 /> Clear
          </Button>
        </div>

        <Button variant="hero" className="w-full" disabled={disabled} onClick={submit}>
          <Send /> {locked || submitted ? "Submitted" : "Submit early"}
        </Button>
      </aside>
    </div>
  );
}
