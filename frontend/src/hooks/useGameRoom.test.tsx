import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError, type GameService } from "@/services/gameService";
import { ServiceProvider } from "@/services/ServiceProvider";
import { useGameRoom } from "./useGameRoom";

const savedSession = {
  roomCode: "ABC123",
  playerId: "player-1",
  token: "private-session-credential",
};

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("useGameRoom saved-session recovery", () => {
  it("shows a recoverable rejoin message and clears stale credentials", async () => {
    window.sessionStorage.setItem(
      "drawoff:session:ABC123",
      JSON.stringify(savedSession),
    );
    const resumeSession = vi
      .fn()
      .mockRejectedValue(new ServiceError("UNAUTHORIZED", "Unauthorized."));
    const service = { resumeSession } as unknown as GameService;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ServiceProvider service={service}>{children}</ServiceProvider>
    );

    const { result } = renderHook(() => useGameRoom("ABC123"), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("join"));
    expect(result.current.joinError).toMatch(/saved session is no longer valid.*rejoin/i);
    expect(window.sessionStorage.getItem("drawoff:session:ABC123")).toBeNull();
  });

  it("does not silently ignore malformed saved credentials", async () => {
    window.sessionStorage.setItem("drawoff:session:ABC123", "not-json");
    const service = { resumeSession: vi.fn() } as unknown as GameService;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ServiceProvider service={service}>{children}</ServiceProvider>
    );

    const { result } = renderHook(() => useGameRoom("ABC123"), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("join"));
    expect(result.current.joinError).toMatch(/saved session data is invalid.*rejoin/i);
    expect(service.resumeSession).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("drawoff:session:ABC123")).toBeNull();
  });
});
