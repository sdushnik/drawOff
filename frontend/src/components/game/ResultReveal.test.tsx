import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyCanvas, playerViewSchema, type PlayerView } from "@drawoff/contracts";
import type { GameRoom } from "@/hooks/useGameRoom";
import { FinalResults, RoundResults } from "./PhaseScreens";

vi.mock("./TimelapseCanvas", () => ({
  TimelapseCanvas: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

function setReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function resultView(overrides: Partial<PlayerView> = {}): PlayerView {
  return playerViewSchema.parse({
    roomCode: "ABC123",
    serverNow: 10_000,
    me: { id: "judge", name: "Jordan", isHost: true, connected: true, isBot: false },
    players: [
      { id: "judge", name: "Jordan", isHost: true, connected: true, isBot: false },
      { id: "artist-1", name: "Alex", isHost: false, connected: true, isBot: false },
      { id: "artist-2", name: "Sam", isHost: false, connected: true, isBot: false },
    ],
    hostId: "judge",
    cycles: 1,
    matchStarted: true,
    phase: "ROUND_RESULT",
    deadline: 22_000,
    pause: null,
    notice: null,
    match: {
      roundIndex: 0,
      totalRounds: 3,
      cycle: 1,
      judgeId: "judge",
      artistIds: ["artist-1", "artist-2"],
      order: ["judge", "artist-1", "artist-2"],
      scores: { judge: 0, "artist-1": 100, "artist-2": 100 },
    },
    role: "judge",
    prompt: "time machine",
    suggestions: null,
    drawingStatus: null,
    myCanvas: null,
    liveCanvases: null,
    gallery: null,
    judgingOvertime: false,
    roundResult: {
      roundIndex: 0,
      prompt: "time machine",
      judgeId: "judge",
      entries: [
        { label: "Drawing 1", artistId: "artist-1", rating: 100, canvas: emptyCanvas() },
        { label: "Drawing 2", artistId: "artist-2", rating: 100, canvas: emptyCanvas() },
      ],
      winners: ["artist-1", "artist-2"],
    },
    finalResult: null,
    interruptedReason: null,
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("animated result screens", () => {
  it("reveals round cards first and keeps tied winners and leaderboard hidden until completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    setReducedMotion(false);
    render(<RoundResults view={resultView()} clockOffset={0} />);

    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("Revealing results…")).toBeInTheDocument();
    expect(screen.queryByText("Top drawing:")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Leaderboard" })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2_700));
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByText(/Top drawing:/)).toHaveTextContent("Alex & Sam");
    expect(screen.getByRole("heading", { name: "Leaderboard" })).toBeInTheDocument();
  });

  it("immediately renders the complete round result for reduced motion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    setReducedMotion(true);
    render(<RoundResults view={resultView()} clockOffset={0} />);

    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByText(/Top drawing:/)).toHaveTextContent("Alex & Sam");
    expect(screen.getByRole("heading", { name: "Leaderboard" })).toBeInTheDocument();
  });

  it("reveals final standings before the winner celebration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    setReducedMotion(false);
    const view = resultView({
      phase: "FINAL_RESULT",
      deadline: null,
      role: null,
      roundResult: null,
      finalResult: {
        winners: ["artist-1", "artist-2"],
        standings: [
          { playerId: "artist-1", score: 100 },
          { playerId: "artist-2", score: 100 },
          { playerId: "judge", score: 0 },
        ],
        rounds: 3,
        cycles: 1,
      },
    });
    const room = { act: vi.fn() } as unknown as GameRoom;
    render(<FinalResults view={view} room={room} />);

    expect(screen.getByRole("heading", { name: "Final scores…" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Co-winners!" })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2_700));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Co-winners!" })).toBeInTheDocument();
    expect(screen.getByText("Alex & Sam")).toBeInTheDocument();
  });
});
