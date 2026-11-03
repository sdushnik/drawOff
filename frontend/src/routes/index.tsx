import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Gavel, Palette, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NAME_MAX } from "@/game/constants";
import { validateName, validateRoomCode } from "@/game/rules";
import { useGameService } from "@/services/ServiceProvider";
import { saveSession } from "@/lib/session";
import stickers from "@/assets/doodle-stickers.png";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DrawOff — one judge, everyone draws" },
      {
        name: "description",
        content: "A real-time drawing party game. Start a private room, share the code, and let the judge rate every drawing 0–100.",
      },
      { property: "og:title", content: "DrawOff — one judge, everyone draws" },
      { property: "og:description", content: "Private rooms, 60-second drawings, a live-watching judge, and 0–100 scores." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

export function Home() {
  const navigate = useNavigate();
  const getService = useGameService();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "join" | null>(null);

  const go = async (mode: "create" | "join", e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    const n = validateName(name);
    if (!n.ok) return setError(n.error);
    const roomCode = mode === "join" ? validateRoomCode(code) : null;
    if (roomCode && !roomCode.ok) return setError(roomCode.error);
    setBusy(mode);
    try {
      const session =
        mode === "create"
          ? await getService().createRoom(n.value)
          : await getService().joinRoom(roomCode!.value, n.value);
      saveSession(session);
      navigate({ to: "/room/$code", params: { code: session.roomCode } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(null);
    }
  };

  return (
    <main className="min-h-screen overflow-hidden">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-10 lg:grid-cols-2 lg:py-16">
        <section>
          <span className="sticker-sm inline-flex items-center gap-1.5 bg-secondary px-3 py-1 text-sm font-bold">
            <Sparkles className="size-4" /> A party game for 3+ friends
          </span>
          <h1 className="mt-5 text-6xl font-extrabold leading-[0.95] sm:text-7xl">
            Draw<span className="text-primary">Off</span>
          </h1>
          <p className="mt-4 max-w-md text-xl font-medium">
            One judge picks the word. Everyone else draws it in 60 seconds. The judge watches live — then scores every
            drawing from 0 to 100.
          </p>

          <form onSubmit={(e) => go("create", e)} className="sticker mt-8 flex max-w-md flex-col gap-4 p-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="name" className="font-display font-bold">
                Your name
              </label>
              <Input id="name" value={name} maxLength={NAME_MAX} autoComplete="nickname" placeholder="e.g. Doodle Queen" onChange={(e) => setName(e.target.value)} />
            </div>
            <Button type="submit" variant="hero" size="lg" disabled={busy !== null}>
              Create a room <ArrowRight />
            </Button>
            <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
              <span className="h-0.5 flex-1 bg-ink/15" /> or join friends <span className="h-0.5 flex-1 bg-ink/15" />
            </div>
            <div className="flex gap-2">
              <Input aria-label="Room code or invite link" value={code} placeholder="Room code or link" className="min-w-0 uppercase tracking-widest placeholder:normal-case placeholder:tracking-normal" onChange={(e) => setCode(e.target.value)} />
              <Button type="button" variant="teal" size="lg" className="shrink-0" disabled={busy !== null} onClick={() => go("join")}>
                Join
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm font-semibold text-destructive">
                {error}
              </p>
            )}
          </form>
        </section>

        <section className="relative">
          <img src={stickers} alt="Pencil, paint bucket, gavel, crown and brush stickers" width={1024} height={1024} className="mx-auto w-full max-w-lg animate-float drop-shadow-[6px_6px_0_var(--ink)]" />
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {[
              { icon: Gavel, title: "1 judge", text: "Picks the word & rates" },
              { icon: Palette, title: "Everyone draws", text: "Private canvases, 60s" },
              { icon: Sparkles, title: "Fair rotation", text: "Everyone judges once" },
            ].map(({ icon: Icon, title, text }, i) => (
              <div key={title} className={`sticker p-3 ${i === 1 ? "tilt-r" : "tilt-l"}`}>
                <Icon className="size-5" />
                <p className="mt-1 font-display font-bold">{title}</p>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
