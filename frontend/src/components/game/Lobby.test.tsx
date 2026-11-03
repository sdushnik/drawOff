import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { playerViewSchema } from "@drawoff/contracts";
import type { GameRoom } from "@/hooks/useGameRoom";
import { Lobby } from "./Lobby";

describe("Lobby roster accessibility", () => {
  it("announces roster changes and labels the host and disconnected players", () => {
    const view = playerViewSchema.parse({
      roomCode: "ABC123",
      serverNow: 0,
      me: { id: "host", name: "Host", isHost: true, connected: true, isBot: false },
      players: [
        { id: "host", name: "Host", isHost: true, connected: true, isBot: false },
        { id: "guest", name: "Guest", isHost: false, connected: false, isBot: false },
      ],
      hostId: "host",
      cycles: 1,
      phase: "LOBBY",
      deadline: null,
      pause: null,
      notice: null,
      match: null,
      role: null,
      prompt: null,
      suggestions: null,
      myCanvas: null,
      liveCanvases: null,
      gallery: null,
      judgingOvertime: false,
      roundResult: null,
      finalResult: null,
      interruptedReason: null,
    });
    const room = {
      capabilities: () => ({ demoPlayers: false, label: "Live room" }),
      act: vi.fn(),
    } as unknown as GameRoom;

    render(<Lobby view={view} room={room} onLeave={vi.fn()} />);

    expect(screen.getByRole("list", { name: "Players" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Host, host, connected; Guest, disconnected",
    );
    expect(screen.getByText("Host", { selector: ".sr-only" })).toBeInTheDocument();
    expect(screen.getByText("Disconnected", { selector: ".sr-only" })).toBeInTheDocument();
  });
});
