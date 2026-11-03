import { useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RoomScreen } from "@/components/game/RoomScreen";
import { NAME_MAX } from "@/game/constants";
import { validateName } from "@/game/rules";
import { useGameRoom } from "@/hooks/useGameRoom";

export const Route = createFileRoute("/room/$code")({
  head: ({ params }) => ({
    meta: [
      { title: `Room ${params.code.toUpperCase()} — DrawOff` },
      { name: "description", content: "You've been invited to a DrawOff room. Enter your name to join the drawing party." },
      { property: "og:title", content: `Join DrawOff room ${params.code.toUpperCase()}` },
      { property: "og:description", content: "One judge, everyone draws. Tap to join the room." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RoomPage,
});

function RoomPage() {
  const { code } = Route.useParams();
  const room = useGameRoom(code.toUpperCase());

  if (room.status === "ready" && room.view) return <RoomScreen room={room} />;
  if (room.status === "join") return <JoinForm code={code.toUpperCase()} error={room.joinError} onJoin={room.join} />;
  return (
    <div className="flex min-h-screen items-center justify-center gap-2 font-display text-lg font-bold">
      <Loader2 className="size-5 animate-spin" /> Connecting…
    </div>
  );
}

function JoinForm({ code, error, onJoin }: { code: string; error: string | null; onJoin: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = validateName(name);
    if (!r.ok) return setLocal(r.error);
    setLocal(null);
    setBusy(true);
    await onJoin(r.value);
    setBusy(false);
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="sticker flex w-full max-w-sm flex-col gap-4 p-6">
        <Link to="/" className="font-display text-2xl font-extrabold">
          Draw<span className="text-primary">Off</span>
        </Link>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Joining room</p>
          <p className="font-display text-4xl font-extrabold tracking-[0.15em]">{code}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="join-name" className="font-display font-bold">
            Your name
          </label>
          <Input id="join-name" autoFocus value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
        </div>
        {(local || error) && (
          <p role="alert" className="text-sm font-semibold text-destructive">
            {local ?? error}
          </p>
        )}
        <Button type="submit" variant="hero" size="lg" disabled={busy}>
          Join room
        </Button>
      </form>
    </main>
  );
}
