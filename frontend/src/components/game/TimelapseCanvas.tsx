import { useEffect, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";
import type { CanvasAction, CanvasSnapshot } from "@drawoff/contracts";
import { Button } from "@/components/ui/button";
import { DrawingCanvas } from "./DrawingCanvas";

const PLAYBACK_MS = 5_000;

function actionWeight(action: CanvasAction): number {
  return action.type === "stroke" ? Math.max(1, action.points.length / 2) : 1;
}

/** Build a non-mutating partial snapshot for deterministic timelapse playback. */
export function timelapseSnapshot(canvas: CanvasSnapshot, progress: number): CanvasSnapshot {
  const boundedProgress = Math.min(1, Math.max(0, progress));
  const totalWeight = canvas.actions.reduce((total, action) => total + actionWeight(action), 0);
  let remaining = Math.ceil(totalWeight * boundedProgress);
  const actions: CanvasAction[] = [];

  for (const action of canvas.actions) {
    if (remaining <= 0) break;
    if (action.type !== "stroke") {
      actions.push(action);
      remaining -= 1;
      continue;
    }

    const pointPairs = Math.min(action.points.length / 2, remaining);
    if (pointPairs > 0) {
      actions.push({ ...action, points: action.points.slice(0, pointPairs * 2) });
      remaining -= pointPairs;
    }
    if (pointPairs < action.points.length / 2) break;
  }

  return {
    actions,
    rev: Math.ceil(canvas.rev * boundedProgress),
    resets: canvas.resets,
  };
}

export function TimelapseCanvas({
  canvas,
  ariaLabel,
}: {
  canvas: CanvasSnapshot;
  ariaLabel: string;
}) {
  const [frame, setFrame] = useState(canvas);
  const [playing, setPlaying] = useState(false);
  const animation = useRef<number | null>(null);
  const hasArtwork = canvas.actions.length > 0;
  const emptyFrame = useMemo(() => timelapseSnapshot(canvas, 0), [canvas]);

  useEffect(() => {
    setFrame(canvas);
    setPlaying(false);
  }, [canvas]);

  useEffect(() => {
    if (!playing) return;
    let startedAt: number | null = null;
    const step = (now: number) => {
      startedAt ??= now;
      const progress = Math.min(1, (now - startedAt) / PLAYBACK_MS);
      setFrame(timelapseSnapshot(canvas, progress));
      if (progress < 1) {
        animation.current = requestAnimationFrame(step);
      } else {
        animation.current = null;
        setPlaying(false);
      }
    };
    animation.current = requestAnimationFrame(step);
    return () => {
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
    };
  }, [canvas, playing]);

  return (
    <div className="relative">
      <DrawingCanvas canvas={frame} ariaLabel={ariaLabel} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!hasArtwork || playing}
        className="absolute bottom-2 left-2 bg-card/95"
        onClick={() => {
          setFrame(emptyFrame);
          setPlaying(true);
        }}
      >
        <Play /> {playing ? "Playing timelapse…" : "Play timelapse"}
      </Button>
    </div>
  );
}
