import { sessionSchema, type Session } from "@drawoff/contracts";

const key = (code: string) => `drawoff:session:${code.toUpperCase()}`;

export type SavedSession =
  | { status: "empty" }
  | { status: "invalid" }
  | { status: "valid"; session: Session };

export function loadSession(code: string): SavedSession {
  if (typeof window === "undefined") return { status: "empty" };
  try {
    const raw = window.sessionStorage.getItem(key(code));
    if (!raw) return { status: "empty" };
    const parsed: unknown = JSON.parse(raw);
    const result = sessionSchema.safeParse(parsed);
    if (result.success && result.data.roomCode.toUpperCase() === code.toUpperCase()) {
      return { status: "valid", session: result.data };
    }
    window.sessionStorage.removeItem(key(code));
    return { status: "invalid" };
  } catch {
    try {
      window.sessionStorage.removeItem(key(code));
    } catch {
      /* ignore */
    }
    return { status: "invalid" };
  }
}

export function saveSession(session: Session): void {
  if (typeof window === "undefined") return;
  try {
    const validSession = sessionSchema.parse(session);
    window.sessionStorage.setItem(key(validSession.roomCode), JSON.stringify(validSession));
  } catch {
    /* ignore */
  }
}

export function clearSession(code: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key(code));
  } catch {
    /* ignore */
  }
}
