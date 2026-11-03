import { useEffect, useRef } from "react";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "@/game/constants";
import { CanvasRenderer } from "@/game/render";
import type { CanvasSnapshot } from "@drawoff/contracts";
import { cn } from "@/lib/utils";

/** Read-only canvas that replays a synchronized snapshot incrementally. */
export function DrawingCanvas({
  canvas,
  className,
  ariaLabel,
}: {
  canvas: CanvasSnapshot;
  className?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<CanvasRenderer | null>(null);

  useEffect(() => {
    if (!renderer.current) {
      const ctx = ref.current?.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      renderer.current = new CanvasRenderer(ctx);
    }
    const id = requestAnimationFrame(() => renderer.current?.render(canvas));
    return () => cancelAnimationFrame(id);
  }, [canvas]);

  return (
    <canvas
      ref={ref}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      role="img"
      aria-label={ariaLabel}
      className={cn("canvas-surface block aspect-[4/3] h-auto w-full", className)}
    />
  );
}
