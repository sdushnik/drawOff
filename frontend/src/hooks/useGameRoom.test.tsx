import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  playerViewSchema,
  type PlayerView,
  type Reaction,
  type Session,
} from "@drawoff/contracts";
import { JudgeLiveView } from "@/components/game/JudgeLiveView";
import { ServiceError, type GameService } from "@/services/gameService";
import { ServiceProvider } from "@/services/ServiceProvider";
import { useGameRoom } from "./useGameRoom";

vi.mock("@/components/game/DrawingCanvas", () => ({
  DrawingCanvas: ({ canvas, ariaLabel }: { canvas: { rev: number }; ariaLabel?: string }) => (
    <canvas role="img" aria-label={ariaLabel} data-revision={canvas.rev} />
  ),
}));

const savedSession = {
  roomCode: "ABC123",
  playerId: "player-1",
  token: "private-session-credential",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

function makeResultView(): PlayerView {
  return playerViewSchema.parse({
    roomCode: "ABC123",
    serverNow: 1_000,
    me: { id: "player-1", name: "Alex", isHost: true, connected: true, isBot: false },
    players: [{ id: "player-1", name: "Alex", isHost: true, connected: true, isBot: false }],
    hostId: "player-1",
    cycles: 1,
    matchStarted: true,
    phase: "ROUND_RESULT",
    deadline: 13_000,
    pause: null,
    notice: null,
    match: null,
    role: "judge",
    prompt: "owl",
    suggestions: null,
    drawingStatus: null,
    myCanvas: null,
    liveCanvases: null,
    gallery: null,
    judgingOvertime: false,
    roundResult: null,
    finalResult: null,
    interruptedReason: null,
  });
}

describe("useGameRoom saved-session recovery", () => {
  it("shows a recoverable rejoin message and clears stale credentials", async () => {
    window.sessionStorage.setItem("drawoff:session:ABC123", JSON.stringify(savedSession));
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

  it("streams Judge canvas revisions through the GameService subscription", async () => {
    const makeJudgeView = (artistTwoRevision: number, artistTwoLocked: boolean): PlayerView =>
      playerViewSchema.parse({
        roomCode: "ABC123",
        serverNow: 1_000 + artistTwoRevision,
        me: { id: "judge-id", name: "Jordan", isHost: true, connected: true, isBot: false },
        players: [
          { id: "judge-id", name: "Jordan", isHost: true, connected: true, isBot: false },
          { id: "artist-id-1", name: "Alice", isHost: false, connected: true, isBot: false },
          { id: "artist-id-2", name: "Bob", isHost: false, connected: true, isBot: false },
        ],
        hostId: "judge-id",
        cycles: 1,
        matchStarted: true,
        phase: "DRAWING",
        deadline: 10_000,
        pause: null,
        notice: null,
        match: {
          roundIndex: 0,
          totalRounds: 3,
          cycle: 1,
          judgeId: "judge-id",
          artistIds: ["artist-id-1", "artist-id-2"],
          order: ["judge-id", "artist-id-1", "artist-id-2"],
          scores: { "judge-id": 0, "artist-id-1": 0, "artist-id-2": 0 },
        },
        role: "judge",
        prompt: "lighthouse",
        suggestions: null,
        myCanvas: null,
        liveCanvases: [
          {
            label: "Artist 1",
            sequence: 0,
            canvas: { actions: [], rev: 0, resets: 0 },
            locked: false,
          },
          {
            label: "Artist 2",
            sequence: artistTwoRevision,
            canvas: {
              actions:
                artistTwoRevision > 0 ? [{ type: "clear", id: `clear-${artistTwoRevision}` }] : [],
              rev: artistTwoRevision,
              resets: 0,
            },
            locked: artistTwoLocked,
          },
        ],
        gallery: null,
        judgingOvertime: false,
        roundResult: null,
        finalResult: null,
        interruptedReason: null,
      });

    const initialView = makeJudgeView(0, false);
    let publishView: ((view: PlayerView) => void) | undefined;
    const service = {
      capabilities: { demoPlayers: false, label: "Live room" },
      resumeSession: vi.fn(async (session: Session) => session),
      subscribe: vi.fn((_session: Session, onView: (view: PlayerView) => void) => {
        publishView = onView;
        onView(initialView);
        return vi.fn();
      }),
    } as unknown as GameService;
    function JudgeRoomHarness() {
      const room = useGameRoom("ABC123");
      return room.view?.role === "judge" && room.view.liveCanvases ? (
        <JudgeLiveView canvases={room.view.liveCanvases} />
      ) : null;
    }

    window.sessionStorage.setItem("drawoff:session:ABC123", JSON.stringify(savedSession));
    render(
      <ServiceProvider service={service}>
        <JudgeRoomHarness />
      </ServiceProvider>,
    );

    expect(await screen.findByRole("img", { name: "Artist 2, live" })).toBeInTheDocument();
    expect(service.subscribe).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Alice|Bob|artist-id-1|artist-id-2/i)).not.toBeInTheDocument();

    act(() => publishView?.(makeJudgeView(2, true)));

    await waitFor(() => expect(screen.getByText("Done")).toBeInTheDocument());
    expect(screen.getByRole("img", { name: "Artist 2, live" })).toHaveAttribute(
      "data-revision",
      "2",
    );
    const artistTwoCard = screen.getByRole("button", { name: /Artist 2/ });
    expect(within(artistTwoCard).getByText("Done")).toBeInTheDocument();
    expect(within(artistTwoCard).queryByText("LIVE")).not.toBeInTheDocument();
  });

  it("delivers reactions for three seconds and sends allowlisted reactions through the service", async () => {
    let publishReaction: ((reaction: Reaction) => void) | undefined;
    const sendReaction = vi.fn(async () => {});
    const service = {
      capabilities: { demoPlayers: false, label: "Live room" },
      resumeSession: vi.fn(async (session: Session) => session),
      sendReaction,
      subscribe: vi.fn(
        (
          _session: Session,
          onView: (view: PlayerView) => void,
          _onError: unknown,
          onReaction: (reaction: Reaction) => void,
        ) => {
          publishReaction = onReaction;
          onView(makeResultView());
          return vi.fn();
        },
      ),
    } as unknown as GameService;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ServiceProvider service={service}>{children}</ServiceProvider>
    );
    window.sessionStorage.setItem("drawoff:session:ABC123", JSON.stringify(savedSession));
    const { result } = renderHook(() => useGameRoom("ABC123"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    act(() => publishReaction?.({
      id: "reaction-1",
      playerId: "player-2",
      playerName: "Ben",
      emoji: "🔥",
      sentAt: 1_000,
    }));
    expect(result.current.reactions).toHaveLength(1);
    act(() => vi.advanceTimersByTime(2_999));
    expect(result.current.reactions).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.reactions).toEqual([]);

    await act(async () => {
      await result.current.sendReaction("👏");
    });
    expect(sendReaction).toHaveBeenCalledWith(savedSession, "👏");
  });
});
