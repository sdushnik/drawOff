import { useState } from "react";
import { Bot, Check, Copy, Crown, LogOut, Play, UserPlus, X, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CYCLE_OPTIONS, MIN_PLAYERS } from "@/game/constants";
import { estimateMatchSeconds, totalRounds } from "@/game/rules";
import type { Cycles, PlayerView } from "@drawoff/contracts";
import type { GameRoom } from "@/hooks/useGameRoom";
import { cn } from "@/lib/utils";
import { formatDuration, initials } from "./util";

export function Lobby({ view, room, onLeave }: { view: PlayerView; room: GameRoom; onLeave: () => void }) {
  const [copied, setCopied] = useState(false);
  const isHost = view.me.isHost;
  const matchStarted = view.matchStarted || view.phase !== "LOBBY";
  const connected = view.players.filter((p) => p.connected).length;
  const canStart = connected >= MIN_PLAYERS;
  const rounds = totalRounds(connected, view.cycles);
  const estimate = estimateMatchSeconds(connected, view.cycles);
  const demo = room.capabilities().demoPlayers;

  const copyLink = async () => {
    const link = `${window.location.origin}/room/${view.roomCode}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.message(link);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[1.1fr_1fr]">
      <section className="sticker p-5">
        <div className="flex items-center justify-between">
          <h2 id="room-roster-heading" className="text-2xl font-extrabold">Players</h2>
          <span className="font-display text-lg font-bold">{view.players.length}</span>
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          Room {view.roomCode} roster:{" "}
          {view.players
            .map(
              (player) =>
                `${player.name}${player.isHost ? ", host" : ""}, ${player.connected ? "connected" : "disconnected"}`,
            )
            .join("; ")}
        </p>
        <ul aria-labelledby="room-roster-heading" className="mt-4 flex flex-col gap-2">
          {view.players.map((p, i) => (
            <li
              key={p.id}
              className={cn(
                "sticker-sm animate-pop flex items-center gap-3 bg-card px-3 py-2",
                !p.connected && "opacity-60",
              )}
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-full border-2 border-ink font-display text-sm font-bold",
                  ["bg-primary text-primary-foreground", "bg-secondary", "bg-accent text-accent-foreground"][i % 3],
                )}
              >
                {initials(p.name)}
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold">
                {p.name}
                {p.id === view.me.id && <span className="text-muted-foreground"> (you)</span>}
              </span>
              {p.isHost && (
                <span className="inline-flex items-center gap-1">
                  <Crown className="size-5 text-secondary-foreground" aria-hidden="true" />
                  <span className="sr-only">Host</span>
                </span>
              )}
              {p.isBot && (
                <span className="inline-flex items-center gap-1 rounded-full border-2 border-ink bg-muted px-2 text-xs font-bold">
                  <Bot className="size-3" /> demo
                </span>
              )}
              {!p.connected && (
                <span className="inline-flex items-center gap-1">
                  <WifiOff className="size-4" aria-hidden="true" />
                  <span className="sr-only">Disconnected</span>
                </span>
              )}
              {isHost && !matchStarted && p.id !== view.me.id && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${p.name}`}
                  onClick={() => room.act((s, ses) => s.kickPlayer(ses, p.id))}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {demo && isHost && (
          <Button variant="outline" className="mt-4 w-full" onClick={() => room.act((s, ses) => s.addDemoPlayer(ses))}>
            <UserPlus /> Add a demo player
          </Button>
        )}
        {!canStart && (
          <p className="mt-3 text-sm text-muted-foreground">
            Need at least {MIN_PLAYERS} players — {MIN_PLAYERS - connected} more to go.
            {demo && isHost ? " Invite friends or add demo players to try it solo." : ""}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-6">
        <div className="sticker tilt-r bg-secondary p-5">
          <p className="text-xs font-bold uppercase tracking-wider">Room code</p>
          <p className="font-display text-5xl font-extrabold tracking-[0.15em]">{view.roomCode}</p>
          <Button variant="outline" className="mt-3" onClick={copyLink}>
            {copied ? <Check /> : <Copy />} {copied ? "Copied!" : "Copy invite link"}
          </Button>
        </div>

        <div className="sticker p-5">
          <h2 className="text-xl font-extrabold">Match length</h2>
          <p className="text-sm text-muted-foreground">In one cycle, everyone judges once.</p>
          <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Cycles">
            {CYCLE_OPTIONS.map((c) => (
              <Button
                key={c}
                role="radio"
                aria-checked={view.cycles === c}
                variant="tool"
                data-active={view.cycles === c}
                disabled={!isHost || matchStarted}
                onClick={() => room.act((s, ses) => s.setCycles(ses, c as Cycles))}
                className="h-12 font-display text-base"
              >
                {c} {c === 1 ? "cycle" : "cycles"}
              </Button>
            ))}
          </div>
          <p className="mt-3 text-sm font-medium">
            {rounds} rounds · {formatDuration(estimate)} <span className="text-muted-foreground">(estimate)</span>
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {isHost ? (
            <Button
              variant="hero"
              size="xl"
              className="flex-1"
              disabled={!canStart || matchStarted}
              onClick={() => room.act((s, ses) => s.startMatch(ses))}
            >
              <Play /> {matchStarted ? "Match started" : "Start match"}
            </Button>
          ) : (
            <div className="sticker flex-1 px-4 py-3 text-center font-semibold">
              {matchStarted ? "The match has started." : "Waiting for the host to start…"}
            </div>
          )}
          <Button variant="outline" size="xl" onClick={onLeave}>
            <LogOut /> Leave
          </Button>
        </div>
      </section>
    </div>
  );
}
