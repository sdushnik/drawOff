import { useEffect, useState } from "react";

export const RESULT_CARDS_REVEAL_MS = 2_400;
export const RESULT_CELEBRATION_MS = 2_700;

export function stagedRevealCount(total: number, elapsedMs: number): number {
  if (total <= 0) return 0;
  const boundedElapsed = Math.max(0, elapsedMs);
  const interval = RESULT_CARDS_REVEAL_MS / total;
  return Math.min(total, Math.floor(boundedElapsed / interval) + 1);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Drives a short staged reveal from an authoritative start time. Passing a
 * mount-time start is suitable for terminal phases that have no deadline.
 */
export function useResultReveal(total: number, startedAt: number, clockOffset = 0) {
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const readElapsed = () => Math.max(0, Date.now() + clockOffset - startedAt);
  const [elapsedMs, setElapsedMs] = useState(readElapsed);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(media.matches);
    updatePreference();
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const updateElapsed = () => {
      const nextElapsed = readElapsed();
      setElapsedMs(nextElapsed);
      if (!reducedMotion && nextElapsed < RESULT_CELEBRATION_MS) {
        timer = window.setTimeout(updateElapsed, 50);
      }
    };
    updateElapsed();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [clockOffset, reducedMotion, startedAt]);

  return {
    revealedCount: reducedMotion ? total : stagedRevealCount(total, elapsedMs),
    celebrationReady: reducedMotion || total === 0 || elapsedMs >= RESULT_CELEBRATION_MS,
    reducedMotion,
  };
}
