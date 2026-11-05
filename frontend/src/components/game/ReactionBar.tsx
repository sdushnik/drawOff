import { useEffect, useRef, useState } from "react";
import type { Reaction, ReactionEmoji } from "@drawoff/contracts";
import { Button } from "@/components/ui/button";

const REACTIONS: ReadonlyArray<{ emoji: ReactionEmoji; name: string }> = [
  { emoji: "👏", name: "Applause" },
  { emoji: "😂", name: "Laugh" },
  { emoji: "🔥", name: "Fire" },
  { emoji: "❤️", name: "Love" },
  { emoji: "😮", name: "Wow" },
  { emoji: "🎨", name: "Art" },
];

const SEND_COOLDOWN_MS = 500;

export function ReactionBar({
  reactions,
  onReact,
}: {
  reactions: Reaction[];
  onReact: (emoji: ReactionEmoji) => Promise<boolean>;
}) {
  const [coolingDown, setCoolingDown] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const announcedIds = useRef(new Set<string>());
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const latest = [...reactions].reverse().find(({ id }) => !announcedIds.current.has(id));
    if (!latest) return;
    for (const reaction of reactions) announcedIds.current.add(reaction.id);
    setAnnouncement(`${latest.playerName} reacted ${latest.emoji}`);
  }, [reactions]);

  useEffect(() => () => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
  }, []);

  const send = (emoji: ReactionEmoji) => {
    if (coolingDown) return;
    setCoolingDown(true);
    void onReact(emoji);
    cooldownTimer.current = setTimeout(() => {
      cooldownTimer.current = null;
      setCoolingDown(false);
    }, SEND_COOLDOWN_MS);
  };

  return (
    <section className="relative mt-6 flex flex-col items-center gap-3" aria-label="Emoji reactions">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div
        className="pointer-events-none flex min-h-10 flex-wrap justify-center gap-2"
        aria-hidden="true"
      >
        {reactions.map((reaction) => (
          <span
            key={reaction.id}
            className="sticker-sm animate-pop bg-card px-2 py-1 text-sm font-semibold"
          >
            <span className="mr-1 text-xl">{reaction.emoji}</span>
            {reaction.playerName}
          </span>
        ))}
      </div>
      <div
        role="group"
        aria-label="Send a reaction"
        className="sticker flex flex-wrap justify-center gap-1.5 bg-card/95 p-2"
      >
        {REACTIONS.map(({ emoji, name }) => (
          <Button
            key={emoji}
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 text-2xl"
            aria-label={`React with ${name}`}
            disabled={coolingDown}
            onClick={() => send(emoji)}
          >
            {emoji}
          </Button>
        ))}
      </div>
    </section>
  );
}
