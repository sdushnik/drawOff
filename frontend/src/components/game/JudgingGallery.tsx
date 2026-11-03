import { useMemo, useState } from "react";
import { Gavel, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { isValidRating } from "@/game/rules";
import type { CanvasSnapshot } from "@drawoff/contracts";
import { cn } from "@/lib/utils";
import { DrawingCanvas } from "./DrawingCanvas";

interface Props {
  prompt: string;
  gallery: { label: string; canvas: CanvasSnapshot }[];
  overtime: boolean;
  onSubmit: (ratings: Record<string, number>) => Promise<unknown>;
}

/** Anonymous gallery: one 0–100 whole-number rating per drawing, submitted once. */
export function JudgingGallery({ prompt, gallery, overtime, onSubmit }: Props) {
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const parsed = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of gallery) {
      const raw = ratings[g.label];
      if (raw === undefined || raw.trim() === "") continue;
      const n = Number(raw);
      if (isValidRating(n)) out[g.label] = n;
    }
    return out;
  }, [ratings, gallery]);

  const rated = Object.keys(parsed).length;
  const complete = rated === gallery.length;

  const submit = async () => {
    if (!complete) return;
    setSubmitting(true);
    const ok = await onSubmit(parsed);
    if (!ok) setSubmitting(false);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="sticker flex flex-wrap items-center justify-between gap-3 bg-secondary px-4 py-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider">The word was</p>
          <p className="font-display text-2xl font-extrabold">{prompt}</p>
        </div>
        <p className="font-display text-lg font-bold" aria-live="polite">
          {rated} of {gallery.length} rated
        </p>
      </div>

      {overtime && (
        <div role="alert" className="sticker flex items-center gap-2 bg-primary px-4 py-2 font-semibold text-primary-foreground">
          <AlertTriangle className="size-5" /> Overtime! Finish your ratings or the round will be replayed.
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {gallery.map((g) => {
          const value = ratings[g.label] ?? "";
          const valid = g.label in parsed;
          const invalid = value.trim() !== "" && !valid;
          return (
            <article
              key={g.label}
              className={cn("sticker overflow-hidden transition-transform", !valid && "outline-dashed outline-2 outline-offset-4 outline-primary")}
            >
              <DrawingCanvas canvas={g.canvas} ariaLabel={g.label} />
              <div className="flex flex-col gap-2 border-t-[2.5px] border-ink p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-lg font-bold">{g.label}</h3>
                  {!valid && <span className="text-xs font-bold uppercase text-primary">Unrated</span>}
                </div>
                <div className="flex items-center gap-3">
                  <Slider
                    aria-label={`${g.label} rating slider`}
                    min={0}
                    max={100}
                    step={1}
                    value={[parsed[g.label] ?? 50]}
                    onValueChange={([v = 50]) => setRatings((r) => ({ ...r, [g.label]: String(v) }))}
                    className={cn(!valid && "opacity-60")}
                  />
                  <Input
                    aria-label={`${g.label} rating`}
                    inputMode="numeric"
                    placeholder="0–100"
                    value={value}
                    onChange={(e) => setRatings((r) => ({ ...r, [g.label]: e.target.value.replace(/[^\d]/g, "").slice(0, 3) }))}
                    aria-invalid={invalid}
                    className={cn("w-20 text-center font-display text-lg font-bold", invalid && "border-destructive")}
                  />
                </div>
                {invalid && <p className="text-xs font-semibold text-destructive">Whole number from 0 to 100.</p>}
              </div>
            </article>
          );
        })}
      </div>

      <div className="sticky bottom-3 z-10 flex justify-center">
        <Button variant="hero" size="xl" disabled={!complete || submitting} onClick={submit}>
          <Gavel /> {complete ? "Submit all ratings" : `Rate ${gallery.length - rated} more`}
        </Button>
      </div>
    </div>
  );
}
