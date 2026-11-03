import { useState, type FormEvent, type ReactNode } from "react";
import { Crown, Gavel, Hourglass, Palette, PartyPopper, RotateCcw, Trophy, WifiOff, AlertOctagon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PROMPT_MAX } from "@/game/constants";
import { validatePrompt } from "@/game/rules";
import type { PlayerView } from "@/game/types";
import type { GameRoom } from "@/hooks/useGameRoom";
import { useCountdown } from "@/hooks/useGameRoom";
import { cn } from "@/lib/utils";
import { DrawingCanvas } from "./DrawingCanvas";
import { nameOf } from "./util";

function Center({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto flex w-full max-w-2xl flex-col items-center gap-5 py-6 text-center", className)}>{children}</div>;
}

export function RoleReveal({ view }: { view: PlayerView }) {
  const m = view.match!;
  const judge = view.role === "judge";
  return (
    <Center>
      <p className="font-display text-lg font-bold">
        Round {m.roundIndex + 1} of {m.totalRounds} · Cycle {m.cycle}
      </p>
      {view.notice && <p className="sticker-sm bg-secondary px-3 py-1 text-sm font-semibold">{view.notice}</p>}
      <div className={cn("sticker animate-pop w-full p-8", judge ? "tilt-l bg-accent text-accent-foreground" : "tilt-r bg-primary text-primary-foreground")}>
        {judge ? <Gavel className="mx-auto size-14" /> : <Palette className="mx-auto size-14" />}
        <h2 className="mt-3 text-5xl font-extrabold">{judge ? "You're the Judge" : "You're an Artist"}</h2>
        <p className="mt-2 text-lg font-medium">
          {judge ? "Pick the word, watch everyone draw, then rate every drawing." : "Draw the word in 60 seconds. Only the judge can see your work."}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2 text-sm">
        <span className="sticker-sm bg-card px-3 py-1 font-semibold">
          <Gavel className="mr-1 inline size-4" /> {nameOf(view, m.judgeId)}
        </span>
        {m.artistIds.map((id) => (
          <span key={id} className="sticker-sm bg-card px-3 py-1">
            <Palette className="mr-1 inline size-4" /> {nameOf(view, id)}
          </span>
        ))}
      </div>
    </Center>
  );
}

export function WordSelection({ view, room }: { view: PlayerView; room: GameRoom }) {
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (view.role !== "judge") {
    return (
      <Center>
        <Hourglass className="size-14 animate-wobble" />
        <h2 className="text-4xl font-extrabold">{nameOf(view, view.match!.judgeId)} is picking a word…</h2>
        <p className="text-muted-foreground">Warm up those wrists.</p>
      </Center>
    );
  }

  const pick = async (word: string) => {
    setBusy(true);
    const ok = await room.act((s, ses) => s.selectPrompt(ses, word));
    if (!ok) setBusy(false);
  };
  const submitCustom = (e: FormEvent) => {
    e.preventDefault();
    const r = validatePrompt(custom);
    if (!r.ok) return setError(r.error);
    pick(r.value);
  };

  return (
    <Center>
      <h2 className="text-4xl font-extrabold">Pick the word</h2>
      <div className="grid w-full gap-3 sm:grid-cols-3">
        {view.suggestions!.map((s, i) => (
          <Button
            key={s}
            variant={(["hero", "sunny", "teal"] as const)[i]}
            size="xl"
            disabled={busy}
            onClick={() => pick(s)}
            className={cn("h-24 whitespace-normal text-xl", i === 0 ? "tilt-l" : i === 2 ? "tilt-r" : "")}
          >
            {s}
          </Button>
        ))}
      </div>
      <form onSubmit={submitCustom} className="sticker flex w-full flex-col gap-2 p-4 text-left">
        <label htmlFor="custom-word" className="font-display font-bold">
          …or write your own
        </label>
        <div className="flex gap-2">
          <Input
            id="custom-word"
            value={custom}
            maxLength={PROMPT_MAX}
            placeholder="e.g. a very nervous pineapple"
            onChange={(e) => {
              setCustom(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" disabled={busy}>
            Use it
          </Button>
        </div>
        {error && <p className="text-sm font-semibold text-destructive">{error}</p>}
      </form>
    </Center>
  );
}

export function WaitingForJudge({ view }: { view: PlayerView }) {
  return (
    <Center>
      <Gavel className="size-14 animate-wobble" />
      <h2 className="text-4xl font-extrabold">{nameOf(view, view.match!.judgeId)} is judging…</h2>
      <p className="text-muted-foreground">Drawings are anonymous until the scores are locked in.</p>
      {view.myCanvas && (
        <div className="sticker tilt-l w-full max-w-md overflow-hidden">
          <DrawingCanvas canvas={view.myCanvas.canvas} ariaLabel="Your submitted drawing" />
          <p className="border-t-[2.5px] border-ink px-3 py-2 font-display font-bold">Your “{view.prompt}”</p>
        </div>
      )}
    </Center>
  );
}

export function RoundResults({ view, clockOffset }: { view: PlayerView; clockOffset: number }) {
  const r = view.roundResult!;
  const m = view.match!;
  const left = useCountdown(view.deadline, clockOffset);
  const entries = [...r.entries].sort((a, b) => b.rating - a.rating);
  const isLast = m.roundIndex + 1 >= m.totalRounds;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="text-center">
        <p className="font-display font-bold">
          Round {m.roundIndex + 1} of {m.totalRounds} · judged by {nameOf(view, r.judgeId)}
        </p>
        <h2 className="text-4xl font-extrabold">“{r.prompt}”</h2>
        <p className="mt-1 text-lg">
          <PartyPopper className="mr-1 inline size-5" />
          Top drawing: <strong>{r.winners.map((id) => nameOf(view, id)).join(" & ")}</strong>
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((e, i) => {
            const winner = r.winners.includes(e.artistId);
            return (
              <article key={e.label} className={cn("sticker animate-pop overflow-hidden", winner && "ring-4 ring-secondary")} style={{ animationDelay: `${i * 90}ms` }}>
                <DrawingCanvas canvas={e.canvas} ariaLabel={`${nameOf(view, e.artistId)}'s drawing`} />
                <div className="flex items-center justify-between gap-2 border-t-[2.5px] border-ink px-3 py-2">
                  <span className="min-w-0 truncate font-semibold">
                    {winner && <Crown className="mr-1 inline size-4" />}
                    {nameOf(view, e.artistId)}
                  </span>
                  <span className="sticker-sm bg-secondary px-2 font-display text-lg font-extrabold">+{e.rating}</span>
                </div>
              </article>
            );
          })}
        </div>
        <Leaderboard view={view} />
      </div>
      <p className="text-center text-sm text-muted-foreground">
        {isLast ? "Final results" : "Next round"} in {left ?? 0}s
      </p>
    </div>
  );
}

export function Leaderboard({ view }: { view: PlayerView }) {
  const m = view.match;
  if (!m) return null;
  const rows = m.order.map((id) => ({ id, score: m.scores[id] ?? 0 })).sort((a, b) => b.score - a.score);
  return (
    <aside className="sticker h-fit p-4">
      <h3 className="text-xl font-extrabold">Leaderboard</h3>
      <ol className="mt-3 flex flex-col gap-1.5">
        {rows.map((row, i) => (
          <li key={row.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1", row.id === view.me.id && "bg-muted")}>
            <span className="w-5 font-display font-bold">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{nameOf(view, row.id)}</span>
            <span className="font-display font-bold tabular-nums">{row.score}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function FinalResults({ view, room }: { view: PlayerView; room: GameRoom }) {
  const f = view.finalResult!;
  const top = f.standings[0]?.score ?? 0;
  return (
    <Center className="max-w-xl">
      <Trophy className="size-16 animate-float" />
      <p className="font-display font-bold">
        {f.rounds} rounds · {f.cycles} {f.cycles === 1 ? "cycle" : "cycles"}
      </p>
      <h2 className="text-5xl font-extrabold">
        {f.winners.length > 1 ? "Co-winners!" : `${nameOf(view, f.winners[0] ?? "")} wins!`}
      </h2>
      {f.winners.length > 1 && <p className="text-lg font-semibold">{f.winners.map((id) => nameOf(view, id)).join(" & ")}</p>}
      <ol className="sticker w-full p-4 text-left">
        {f.standings.map((s, i) => (
          <li key={s.playerId} className={cn("flex items-center gap-3 border-b-2 border-dashed border-ink/20 py-2 last:border-0", s.score === top && "font-bold")}>
            <span className="w-6 font-display text-lg font-bold">{i + 1}</span>
            <span className="flex-1 truncate">
              {s.score === top && <Crown className="mr-1 inline size-4" />}
              {nameOf(view, s.playerId)}
            </span>
            <span className="font-display text-lg tabular-nums">{s.score}</span>
          </li>
        ))}
      </ol>
      {view.me.isHost ? (
        <Button variant="hero" size="xl" onClick={() => room.act((s, ses) => s.rematch(ses))}>
          <RotateCcw /> Play again
        </Button>
      ) : (
        <p className="text-muted-foreground">Waiting for the host to start a rematch…</p>
      )}
    </Center>
  );
}

export function Interrupted({ view, room }: { view: PlayerView; room: GameRoom }) {
  return (
    <Center>
      <AlertOctagon className="size-14" />
      <h2 className="text-4xl font-extrabold">Match interrupted</h2>
      <p className="text-lg">{view.interruptedReason}</p>
      <p className="text-sm text-muted-foreground">No winner this time — scores from an unfinished match don't count.</p>
      <Button variant="hero" size="lg" onClick={() => room.act((s, ses) => s.returnToLobby(ses))}>
        Back to the lobby
      </Button>
    </Center>
  );
}

export function PauseOverlay({ view, clockOffset }: { view: PlayerView; clockOffset: number }) {
  const left = useCountdown(view.pause?.until ?? null, clockOffset);
  if (!view.pause) return null;
  return (
    <div role="alertdialog" aria-label="Game paused" className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div className="sticker animate-pop max-w-sm p-6 text-center">
        <WifiOff className="mx-auto size-10" />
        <h2 className="mt-2 text-2xl font-extrabold">Paused</h2>
        <p className="mt-1">Waiting for {view.pause.playerName} to reconnect… {left}s</p>
      </div>
    </div>
  );
}
