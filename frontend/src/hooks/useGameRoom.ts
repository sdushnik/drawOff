import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DrawOp, PlayerView, Reaction, ReactionEmoji, Session } from "@drawoff/contracts";
import { ServiceError, type GameService } from "@/services/gameService";
import { useGameService } from "@/services/ServiceProvider";
import { clearSession, loadSession, saveSession } from "@/lib/session";

export type RoomStatus = "loading" | "join" | "ready";

export function useGameRoom(code: string) {
  const getService = useGameService();
  const serviceRef = useRef(getService);
  serviceRef.current = getService;

  const [status, setStatus] = useState<RoomStatus>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const reactionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => () => {
    for (const timer of reactionTimers.current.values()) clearTimeout(timer);
    reactionTimers.current.clear();
  }, []);

  // Restore a saved session (refresh / reconnect).
  useEffect(() => {
    const saved = loadSession(code);
    if (saved.status === "empty") {
      setStatus("join");
      return;
    }
    if (saved.status === "invalid") {
      setJoinError("Saved session data is invalid. Rejoin this room to continue.");
      setStatus("join");
      return;
    }
    let cancelled = false;
    serviceRef
      .current()
      .resumeSession(saved.session)
      .then((s) => !cancelled && setSession(s))
      .catch((error: unknown) => {
        if (cancelled) return;
        const errorCode = error instanceof ServiceError ? error.code : null;
        if (errorCode === "ROOM_NOT_FOUND" || errorCode === "UNAUTHORIZED") clearSession(code);
        setJoinError(
          errorCode === "ROOM_NOT_FOUND"
            ? "That room has closed. Join another room to continue."
            : errorCode === "UNAUTHORIZED"
              ? "Your saved session is no longer valid. Rejoin this room to continue."
              : error instanceof Error
                ? `Couldn't restore your saved session: ${error.message}`
                : "Couldn't restore your saved session. Try joining again.",
        );
        setStatus("join");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  useEffect(() => {
    if (!session) return;
    return serviceRef.current().subscribe(
      session,
      (v) => {
        setClockOffset(v.serverNow - Date.now());
        setView(v);
        setStatus("ready");
      },
      (e) => {
        if (e.code === "UNAUTHORIZED" || e.code === "ROOM_NOT_FOUND") {
          clearSession(code);
          setSession(null);
          setView(null);
          setJoinError(e.code === "UNAUTHORIZED" ? "You're no longer in this room." : "That room has closed.");
          setStatus("join");
        }
      },
      (reaction) => {
        setReactions((current) =>
          current.some(({ id }) => id === reaction.id) ? current : [...current, reaction],
        );
        const existing = reactionTimers.current.get(reaction.id);
        if (existing) clearTimeout(existing);
        reactionTimers.current.set(
          reaction.id,
          setTimeout(() => {
            reactionTimers.current.delete(reaction.id);
            setReactions((current) => current.filter(({ id }) => id !== reaction.id));
          }, 3_000),
        );
      },
    );
  }, [session, code]);

  useEffect(() => {
    if (view?.phase === "ROUND_RESULT" || view?.phase === "FINAL_RESULT") return;
    for (const timer of reactionTimers.current.values()) clearTimeout(timer);
    reactionTimers.current.clear();
    setReactions([]);
  }, [view?.phase]);

  const join = useCallback(
    async (name: string) => {
      setJoinError(null);
      try {
        const s = await serviceRef.current().joinRoom(code, name);
        saveSession(s);
        setSession(s);
      } catch (e) {
        setJoinError(e instanceof Error ? e.message : "Couldn't join.");
      }
    },
    [code],
  );

  /** Run a service action for this session, surfacing failures as toasts. */
  const act = useCallback(
    async (fn: (service: GameService, session: Session) => Promise<unknown>) => {
      if (!session) return false;
      try {
        await fn(serviceRef.current(), session);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
        return false;
      }
    },
    [session],
  );

  /** High-frequency and best-effort: rejections near the deadline are expected, never toasted. */
  const sendDrawOps = useCallback(
    async (ops: DrawOp[]) => {
      if (session) await serviceRef.current().sendDrawOps(session, ops);
    },
    [session],
  );

  const sendReaction = useCallback(
    async (emoji: ReactionEmoji) => {
      if (!session) return false;
      try {
        await serviceRef.current().sendReaction(session, emoji);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't send reaction.");
        return false;
      }
    },
    [session],
  );

  const leave = useCallback(async () => {
    if (session) {
      try {
        await serviceRef.current().leaveRoom(session);
      } catch {
        /* already gone */
      }
      clearSession(code);
    }
  }, [session, code]);

  return {
    status,
    session,
    view,
    joinError,
    clockOffset,
    join,
    act,
    sendDrawOps,
    sendReaction,
    reactions,
    leave,
    capabilities: () => serviceRef.current().capabilities,
  };
}

export type GameRoom = ReturnType<typeof useGameRoom>;

/** Seconds remaining until a server deadline, re-rendering a few times a second. */
export function useCountdown(deadline: number | null, clockOffset: number, frozen = false) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null || frozen) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline, frozen]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - (now + clockOffset)) / 1000));
}
