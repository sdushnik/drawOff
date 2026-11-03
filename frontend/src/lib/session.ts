import type { Session } from "@/game/types";

const key = (code: string) => `drawoff:session:${code.toUpperCase()}`;

export function loadSession(code: string): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key(code));
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session) {
  try {
    window.sessionStorage.setItem(key(session.roomCode), JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function clearSession(code: string) {
  try {
    window.sessionStorage.removeItem(key(code));
  } catch {
    /* ignore */
  }
}
