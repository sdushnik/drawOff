import { useNavigate, Link } from "@tanstack/react-router";
import { Gavel, Palette } from "lucide-react";
import type { GameRoom } from "@/hooks/useGameRoom";
import { useCountdown } from "@/hooks/useGameRoom";
import { ArtistBoard } from "./ArtistBoard";
import { JudgeLiveView } from "./JudgeLiveView";
import { JudgingGallery } from "./JudgingGallery";
import { Lobby } from "./Lobby";
import {
  FinalResults,
  Interrupted,
  Leaderboard,
  PauseOverlay,
  RoleReveal,
  RoundResults,
  WaitingForJudge,
  WordSelection,
} from "./PhaseScreens";
import { Timer } from "./Timer";

export function RoomScreen({ room }: { room: GameRoom }) {
  const view = room.view!;
  const navigate = useNavigate();
  const m = view.match;
  const paused = !!view.pause;
  const secondsLeft = useCountdown(view.deadline, room.clockOffset, paused);

  const leave = async () => {
    await room.leave();
    navigate({ to: "/" });
  };

  const showTimer = ["WORD_SELECTION", "DRAWING", "JUDGING"].includes(view.phase);

  return (
    <div className="min-h-screen pb-10">
      <header className="sticky top-0 z-20 border-b-[2.5px] border-ink bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <Link to="/" className="font-display text-2xl font-extrabold tracking-tight">
            Draw<span className="text-primary">Off</span>
          </Link>
          <span className="sticker-sm hidden bg-card px-2 font-display text-sm font-bold tracking-widest sm:inline">{view.roomCode}</span>
          <div className="flex-1" />
          {m && view.phase !== "FINAL_RESULT" && (
            <span className="hidden text-sm font-semibold sm:inline">
              Round {m.roundIndex + 1}/{m.totalRounds}
            </span>
          )}
          {view.role && (
            <span className="sticker-sm inline-flex items-center gap-1 bg-card px-2 py-0.5 text-sm font-bold">
              {view.role === "judge" ? <Gavel className="size-4" /> : <Palette className="size-4" />}
              {view.role === "judge" ? "Judge" : "Artist"}
            </span>
          )}
          {showTimer && <Timer deadline={view.deadline} clockOffset={room.clockOffset} frozen={paused} warnAt={view.phase === "JUDGING" ? 15 : 10} />}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-6">
        {view.phase === "LOBBY" && <Lobby view={view} room={room} onLeave={leave} />}
        {view.phase === "ROLE_REVEAL" && <RoleReveal view={view} />}
        {view.phase === "WORD_SELECTION" && <WordSelection view={view} room={room} />}

        {view.phase === "DRAWING" && view.role === "artist" && view.myCanvas && (
          <div className="flex flex-col gap-4">
            <PromptBanner label="Draw this" prompt={view.prompt ?? ""} />
            <ArtistBoard
              key={`${m?.roundIndex}-${view.prompt}`}
              initial={view.myCanvas.canvas}
              locked={view.myCanvas.locked}
              timeUp={secondsLeft === 0}
              onSend={room.sendDrawOps}
              onSubmit={() => room.act((s, ses) => s.submitCanvas(ses))}
            />
          </div>
        )}

        {view.phase === "DRAWING" && view.role === "judge" && view.liveCanvases && (
          <div className="flex flex-col gap-4">
            <PromptBanner label="They're drawing" prompt={view.prompt ?? ""} hint="Watching live · tap a drawing to focus" />
            <JudgeLiveView canvases={view.liveCanvases} />
          </div>
        )}

        {view.phase === "JUDGING" && view.role === "judge" && view.gallery && (
          <JudgingGallery
            key={`${m?.roundIndex}-${view.prompt}`}
            prompt={view.prompt ?? ""}
            gallery={view.gallery}
            overtime={view.judgingOvertime}
            onSubmit={(ratings) => room.act((s, ses) => s.submitRatings(ses, ratings))}
          />
        )}
        {view.phase === "JUDGING" && view.role === "artist" && (
          <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
            <WaitingForJudge view={view} />
            <Leaderboard view={view} />
          </div>
        )}

        {view.phase === "ROUND_RESULT" && view.roundResult && <RoundResults view={view} clockOffset={room.clockOffset} />}
        {view.phase === "FINAL_RESULT" && view.finalResult && <FinalResults view={view} room={room} />}
        {view.phase === "MATCH_INTERRUPTED" && <Interrupted view={view} room={room} />}
      </main>

      <PauseOverlay view={view} clockOffset={room.clockOffset} />
    </div>
  );
}

function PromptBanner({ label, prompt, hint }: { label: string; prompt: string; hint?: string }) {
  return (
    <div className="sticker flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-secondary px-4 py-3">
      <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
      <span className="font-display text-3xl font-extrabold">{prompt}</span>
      {hint && <span className="ml-auto text-sm font-medium">{hint}</span>}
    </div>
  );
}
