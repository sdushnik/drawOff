import { Timer as TimerIcon } from "lucide-react";
import { useCountdown } from "@/hooks/useGameRoom";
import { cn } from "@/lib/utils";

export function Timer({
  deadline,
  clockOffset,
  frozen,
  warnAt = 10,
  className,
}: {
  deadline: number | null;
  clockOffset: number;
  frozen?: boolean;
  warnAt?: number;
  className?: string;
}) {
  const seconds = useCountdown(deadline, clockOffset, frozen);
  if (seconds === null) return null;
  const warn = seconds <= warnAt;
  return (
    <div
      role="timer"
      aria-live="off"
      className={cn(
        "sticker-sm inline-flex items-center gap-1.5 px-3 py-1 font-display text-lg font-bold tabular-nums",
        warn ? "bg-primary text-primary-foreground animate-wobble" : "bg-card",
        className,
      )}
    >
      <TimerIcon className="size-4" />
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </div>
  );
}
