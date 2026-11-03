import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { playerViewSchema } from "@drawoff/contracts";
import type { PlayerView } from "@drawoff/contracts";
import type { GameRoom } from "@/hooks/useGameRoom";
import { Lobby } from "./Lobby";

function makeLobbyView(overrides: Partial<PlayerView> = {}) {
  return playerViewSchema.parse({
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
    ...overrides,
  });
}

describe("Lobby roster accessibility", () => {
  it("announces roster changes and labels the host and disconnected players", () => {
    const view = makeLobbyView();
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
    expect(screen.getByRole("button", { name: "Start match" })).toBeDisabled();
  });

  it("disables host controls and hides kick actions after a live match starts", () => {
    const lobby = makeLobbyView();
    const view = makeLobbyView({
      matchStarted: true,
      players: [
        lobby.players[0]!,
        { id: "guest", name: "Guest", isHost: false, connected: true, isBot: false },
        { id: "third", name: "Third", isHost: false, connected: true, isBot: false },
      ],
    });
    const room = {
      capabilities: () => ({ demoPlayers: false, label: "Live room" }),
      act: vi.fn(),
    } as unknown as GameRoom;

    const { rerender } = render(<Lobby view={view} room={room} onLeave={vi.fn()} />);

    for (const cycles of [1, 2, 3]) {
      expect(screen.getByRole("radio", { name: `${cycles} ${cycles === 1 ? "cycle" : "cycles"}` })).toBeDisabled();
    }
    expect(screen.queryByRole("button", { name: "Remove Guest" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Match started" })).toBeDisabled();

    rerender(
      <Lobby
        view={playerViewSchema.parse({ ...view, me: view.players[1] })}
        room={room}
        onLeave={vi.fn()}
      />,
    );
    expect(screen.getByText("The match has started.")).toBeInTheDocument();
  });

  it("shows the server-owned interruption and recovery notice", () => {
    const notice =
      "The match was canceled because a required player did not reconnect in time. No winner was declared. At least 3 connected players are needed to start a new match.";
    const room = {
      capabilities: () => ({ demoPlayers: false, label: "Live room" }),
      act: vi.fn(),
    } as unknown as GameRoom;

    render(
      <Lobby
        view={makeLobbyView({ notice })}
        room={room}
        onLeave={vi.fn()}
      />,
    );

    expect(screen.getByText(notice)).toHaveAttribute("role", "status");
    expect(screen.getByText(/Need at least 3 players/)).toBeInTheDocument();
  });
});
