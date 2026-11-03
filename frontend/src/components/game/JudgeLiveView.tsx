import { useState } from "react";
import { ArrowLeft, Eye, LayoutGrid, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LiveCanvas } from "@/game/types";
import { cn } from "@/lib/utils";
import { DrawingCanvas } from "./DrawingCanvas";

/** Read-only live spectating for the judge: Grid View and Focus View. */
export function JudgeLiveView({ canvases }: { canvases: LiveCanvas[] }) {
  const [focus, setFocus] = useState<string | null>(null);
  const focused = canvases.find((c) => c.label === focus) ?? null;
  const cols =
    canvases.length <= 2 ? "sm:grid-cols-2" : canvases.length <= 4 ? "sm:grid-cols-2" : canvases.length <= 9 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-3 lg:grid-cols-4";

  if (focused) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => setFocus(null)}>
            <ArrowLeft /> <LayoutGrid /> Grid view
          </Button>
          <span className="font-display text-xl font-bold">{focused.label}</span>
          {focused.locked ? <LockedBadge /> : <LiveBadge />}
        </div>
        <div className="sticker mx-auto w-full max-w-3xl overflow-hidden">
          <DrawingCanvas canvas={focused.canvas} ariaLabel={`${focused.label}, live`} />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2" aria-label="Switch drawing">
          {canvases.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => setFocus(c.label)}
              aria-current={c.label === focus}
              className={cn(
                "sticker-sm w-28 shrink-0 cursor-pointer overflow-hidden bg-card text-left transition-transform hover:-translate-y-0.5",
                c.label === focus && "ring-2 ring-primary ring-offset-2 ring-offset-background",
              )}
            >
              <DrawingCanvas canvas={c.canvas} />
              <span className="block truncate border-t-2 border-ink px-1.5 py-0.5 text-xs font-semibold">{c.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("grid grid-cols-1 gap-4", cols)}>
      {canvases.map((c, i) => (
        <button
          key={c.label}
          type="button"
          onClick={() => setFocus(c.label)}
          className={cn(
            "sticker group cursor-pointer overflow-hidden text-left transition-transform hover:-translate-y-1",
            i % 2 === 0 ? "hover:-rotate-1" : "hover:rotate-1",
          )}
        >
          <DrawingCanvas canvas={c.canvas} ariaLabel={`${c.label}, live`} />
          <div className="flex items-center justify-between border-t-[2.5px] border-ink px-3 py-2">
            <span className="font-display font-bold">{c.label}</span>
            <span className="flex items-center gap-2">
              {c.locked ? <LockedBadge /> : <LiveBadge />}
              <Eye className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border-2 border-ink bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-primary-foreground" /> LIVE
    </span>
  );
}

function LockedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border-2 border-ink bg-secondary px-2 py-0.5 text-xs font-bold">
      <Lock className="size-3" /> Done
    </span>
  );
}
