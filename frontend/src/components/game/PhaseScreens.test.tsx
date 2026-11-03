import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { playerViewSchema, type PlayerView } from "@drawoff/contracts";
import { emptyCanvas } from "@/game/canvasOps";
import type { GameRoom } from "@/hooks/useGameRoom";
import { PauseOverlay, RoleReveal, WordSelection } from "./PhaseScreens";
import { RoomScreen } from "./RoomScreen";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("./ArtistBoard", () => ({ ArtistBoard: () => <div data-testid="artist-board" /> }));
vi.mock("./JudgeLiveView", () => ({ JudgeLiveView: () => <div data-testid="judge-live-view" /> }));
vi.mock("./Timer", () => ({ Timer: () => null }));

function makeView(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerViewSchema.parse({
    roomCode: "ABC123",
    serverNow: 1_000,
    me: { id: "judge", name: "Jordan", isHost: true, connected: true, isBot: false },
    players: [
      { id: "judge", name: "Jordan", isHost: true, connected: true, isBot: false },
      { id: "artist-1", name: "Alex", isHost: false, connected: true, isBot: false },
      { id: "artist-2", name: "Sam", isHost: false, connected: true, isBot: false },
    ],
    hostId: "judge",
    cycles: 2,
    phase: "ROLE_REVEAL",
    deadline: 5_000,
    pause: null,
    notice: null,
    match: {
      roundIndex: 4,
      totalRounds: 12,
      cycle: 2,
      judgeId: "judge",
      artistIds: ["artist-1", "artist-2"],
      order: ["judge", "artist-1", "artist-2"],
      scores: { judge: 0, "artist-1": 0, "artist-2": 0 },
    },
    role: "judge",
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

function makeRoom(): GameRoom {
  return {
    clockOffset: 0,
    act: vi.fn().mockResolvedValue(true),
    sendDrawOps: vi.fn(),
    leave: vi.fn(),
  } as unknown as GameRoom;
}

describe("role reveal and prompt selection", () => {
  it.each([
    ["judge", "You're the Judge"],
    ["artist", "You're an Artist"],
  ] as const)("shows role and round metadata for the %s", (role, heading) => {
    render(<RoleReveal view={makeView({ role })} />);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText("Round 5 of 12 · Cycle 2")).toBeInTheDocument();
    const roles = screen.getByRole("list", { name: "Round roles" });
    expect(roles).toHaveTextContent("Judge: Jordan");
    expect(roles).toHaveTextContent("Artist: Alex");
    expect(roles).toHaveTextContent("Artist: Sam");
    expect(roles).toHaveClass("w-full", "flex-wrap");
  });

  it("announces a server-owned phase notice politely", () => {
    render(<RoleReveal view={makeView({ notice: "The match recovered and will resume." })} />);

    expect(screen.getByRole("status")).toHaveTextContent("The match recovered and will resume.");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("gives only the Judge prompt choices and labeled custom-prompt controls before confirmation", () => {
    const room = makeRoom();
    render(
      <WordSelection
        view={makeView({
          phase: "WORD_SELECTION",
          suggestions: ["paper moon", "sleepy dragon", "tiny volcano"],
        })}
        room={room}
      />,
    );

    const suggestions = screen.getByRole("group", { name: "Prompt suggestions" });
    expect(within(suggestions).getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("form", { name: "Custom prompt" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "…or write your own" })).toBeInTheDocument();
    expect(screen.queryByText("confirmed prompt")).not.toBeInTheDocument();

    fireEvent.click(within(suggestions).getByRole("button", { name: "paper moon" }));
    expect(room.act).toHaveBeenCalledOnce();

    expect(suggestions).toHaveClass("w-full", "sm:grid-cols-3");
    const input = screen.getByRole("textbox", { name: "…or write your own" });
    expect(input.parentElement).toHaveClass("flex-col", "sm:flex-row");
    expect(screen.getByRole("button", { name: "Use it" })).toHaveClass("w-full", "sm:w-auto");
  });

  it("keeps Artists waiting without exposing prompt choices or submission controls before confirmation", () => {
    render(
      <WordSelection
        view={makeView({
          me: { id: "artist-1", name: "Alex", isHost: false, connected: true, isBot: false },
          phase: "WORD_SELECTION",
          role: "artist",
          prompt: null,
          suggestions: null,
        })}
        room={makeRoom()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Jordan is picking a word…" })).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the Judge to confirm the prompt/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Prompt suggestions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Custom prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("paper moon")).not.toBeInTheDocument();
    expect(screen.queryByText("confirmed prompt")).not.toBeInTheDocument();
  });

  it("announces custom-prompt validation errors and associates them with the input", () => {
    render(
      <WordSelection
        view={makeView({
          phase: "WORD_SELECTION",
          suggestions: ["paper moon", "sleepy dragon", "tiny volcano"],
        })}
        room={makeRoom()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "…or write your own" });
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));

    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Enter a word or phrase.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
  });
});

describe("pause accessibility", () => {
  it("presents a modal pause state without creating a per-second live region", () => {
    render(
      <PauseOverlay
        view={makeView({ pause: { playerName: "Alex", until: Date.now() + 30_000 } })}
        clockOffset={0}
      />,
    );

    const dialog = screen.getByRole("alertdialog", { name: "Game paused" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent(/Waiting for Alex to reconnect/);
    expect(dialog).not.toHaveAttribute("aria-live");
  });
});

describe("RoomScreen confirmed prompt", () => {
  it.each(["judge", "artist"] as const)(
    "shows the server-confirmed prompt to the %s only after drawing begins",
    (role) => {
      const view = makeView({
        phase: "DRAWING",
        role,
        prompt: "confirmed prompt",
        liveCanvases: role === "judge" ? [] : null,
        myCanvas: role === "artist" ? { canvas: emptyCanvas(), locked: false } : null,
      });

      render(<RoomScreen room={{ ...makeRoom(), view } as GameRoom} />);

      expect(screen.getByText("confirmed prompt")).toBeInTheDocument();
      expect(screen.getByText(role === "judge" ? "They're drawing" : "Draw this")).toBeInTheDocument();
      if (role === "artist") expect(screen.getByTestId("artist-board")).toBeInTheDocument();
      if (role === "judge") expect(screen.getByTestId("judge-live-view")).toBeInTheDocument();
    },
  );

  it("shows all locked anonymous canvases to the Judge after the drawing deadline", () => {
    const view = makeView({
      phase: "JUDGING",
      prompt: "confirmed prompt",
      liveCanvases: [
        { label: "Artist 1", sequence: 1, canvas: emptyCanvas(), locked: true },
        { label: "Artist 2", sequence: 2, canvas: emptyCanvas(), locked: true },
      ],
    });

    render(<RoomScreen room={{ ...makeRoom(), view } as GameRoom} />);

    expect(screen.getByText("Drawings are frozen")).toBeInTheDocument();
    expect(screen.getByText("All canvases are locked")).toBeInTheDocument();
    expect(screen.getByTestId("judge-live-view")).toBeInTheDocument();
  });
});
