import type { PlayerView } from "@/game/types";

export function nameOf(view: PlayerView, id: string): string {
  return view.players.find((p) => p.id === id)?.name ?? "Someone who left";
}

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `~${h} h${rest ? ` ${rest} min` : ""}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
