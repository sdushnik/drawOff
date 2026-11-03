import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DrawOp, PlayerView, Session } from "@/game/types";
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

  // Restore a saved session (refresh / reconnect).
  useEffect(() => {
    const saved = loadSession(code);
    if (!saved) {
      setStatus("join");
      return;
    }
    let cancelled = false;
    serviceRef
      .current()
      .resumeSession(saved)
      .then((s) => !cancelled && setSession(s))
      .catch((e: ServiceError) => {
        if (cancelled) return;
        clearSession(code);
        setJoinError(e.code === "ROOM_NOT_FOUND" ? "That room has closed." : e.message);
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
    );
  }, [session, code]);

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
