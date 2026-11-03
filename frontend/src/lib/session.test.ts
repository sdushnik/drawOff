import { afterEach, describe, expect, it } from "vitest";
import { clearSession, loadSession, saveSession } from "./session";

const session = {
  roomCode: "ABC123",
  playerId: "player-1",
  token: "private-session-credential",
};

afterEach(() => {
  clearSession(session.roomCode);
});

describe("browser session persistence", () => {
  it("restores the room-scoped credential after a page refresh without changing the URL", () => {
    const url = window.location.href;

    saveSession(session);

    expect(loadSession(session.roomCode)).toEqual({ status: "valid", session });
    expect(window.sessionStorage.getItem("drawoff:session:ABC123")).toContain(session.token);
    expect(window.location.href).toBe(url);
  });

  it("clears malformed or cross-room stored credentials and reports them as invalid", () => {
    window.sessionStorage.setItem(
      "drawoff:session:ABC123",
      JSON.stringify({ ...session, roomCode: "XYZ789" }),
    );

    expect(loadSession(session.roomCode)).toEqual({ status: "invalid" });
    expect(window.sessionStorage.getItem("drawoff:session:ABC123")).toBeNull();

    window.sessionStorage.setItem("drawoff:session:ABC123", "not-json");
    expect(loadSession(session.roomCode)).toEqual({ status: "invalid" });
    expect(window.sessionStorage.getItem("drawoff:session:ABC123")).toBeNull();
  });
});
