import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../../../backend/src/server.js";
import { ServiceProvider } from "@/services/ServiceProvider";
import { createSocketGameService } from "@/services/socketGameService";
import { useGameRoom } from "@/hooks/useGameRoom";
import { JudgeLiveView } from "./JudgeLiveView";

vi.mock("@/components/game/DrawingCanvas", () => ({
  DrawingCanvas: ({ canvas, ariaLabel }: { canvas: { rev: number }; ariaLabel?: string }) => (
    <canvas role="img" aria-label={ariaLabel} data-revision={canvas.rev} />
  ),
}));

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

interface FakeTimer {
  callback: () => void;
  dueAt: number;
}

function createClock() {
  let now = 1_000;
  let nextId = 0;
  const timers = new Map<number, FakeTimer>();
  return {
    now: () => now,
    setTimer(callback: () => void, delayMs: number) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: now + delayMs });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      timers.delete(handle as unknown as number);
    },
    runNext() {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0] ?? [];
      if (!timer) throw new Error("No match timer was scheduled.");
      timers.delete(id!);
      now = Math.max(now, timer.dueAt);
      timer.callback();
    },
  };
}

describe("JudgeLiveView Socket.IO integration", () => {
  it("renders real backend drawing updates through GameService while focused and switching", async () => {
    const clock = createClock();
    const { app, io } = createServer({
      logger: false,
      matchStateMachineOptions: {
        now: clock.now,
        random: () => 0,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const judgeService = createSocketGameService(address);
    const artistOneService = createSocketGameService(address);
    const artistTwoService = createSocketGameService(address);
    let stopArtistOneUpdates = () => {};
    let stopArtistTwoUpdates = () => {};

    try {
      const judge = await judgeService.createRoom("Judge Name");
      const artistOne = await artistOneService.joinRoom(judge.roomCode, "Artist One Name");
      const artistTwo = await artistTwoService.joinRoom(judge.roomCode, "Artist Two Name");
      stopArtistOneUpdates = artistOneService.subscribe(artistOne, () => {});
      stopArtistTwoUpdates = artistTwoService.subscribe(artistTwo, () => {});

      await judgeService.startMatch(judge);
      clock.runNext();
      await judgeService.selectPrompt(judge, "lighthouse");
      window.sessionStorage.setItem(`drawoff:session:${judge.roomCode}`, JSON.stringify(judge));

      function JudgeRoomHarness() {
        const room = useGameRoom(judge.roomCode);
        return room.view?.role === "judge" && room.view.liveCanvases ? (
          <JudgeLiveView canvases={room.view.liveCanvases} />
        ) : null;
      }

      render(
        <ServiceProvider service={judgeService}>
          <JudgeRoomHarness />
        </ServiceProvider>,
      );

      expect(await screen.findByRole("img", { name: "Drawing 1, live" })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Drawing 2, live" })).toBeInTheDocument();
      expect(
        screen.queryByText(/Judge Name|Artist One Name|Artist Two Name/i),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Drawing 2/ }));
      const selectedArtistTwo = screen.getByRole("button", { name: "Drawing 2" });
      expect(selectedArtistTwo).toHaveAttribute("aria-current", "true");

      await act(async () => {
        await artistTwoService.sendDrawOps(artistTwo, [{ type: "clear", id: "artist-two-clear" }]);
      });
      await waitFor(() =>
        expect(screen.getByRole("img", { name: "Drawing 2, live" })).toHaveAttribute(
          "data-revision",
          "1",
        ),
      );
      expect(screen.getByRole("button", { name: "Drawing 2" })).toHaveAttribute(
        "aria-current",
        "true",
      );

      fireEvent.click(screen.getByRole("button", { name: "Drawing 1" }));
      expect(screen.getByRole("img", { name: "Drawing 1, live" })).toHaveAttribute(
        "data-revision",
        "0",
      );
      await act(async () => {
        await artistOneService.sendDrawOps(artistOne, [{ type: "clear", id: "artist-one-clear" }]);
      });
      await waitFor(() =>
        expect(screen.getByRole("img", { name: "Drawing 1, live" })).toHaveAttribute(
          "data-revision",
          "1",
        ),
      );

      await act(async () => {
        await artistOneService.submitCanvas(artistOne);
      });
      await waitFor(() => expect(screen.getByText("Done")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Drawing 1" })).toHaveAttribute(
        "aria-current",
        "true",
      );

      fireEvent.click(screen.getByRole("button", { name: /Grid view/ }));
      expect(screen.getByRole("img", { name: "Drawing 1, live" })).toHaveAttribute(
        "data-revision",
        "1",
      );
      expect(screen.getByRole("img", { name: "Drawing 2, live" })).toHaveAttribute(
        "data-revision",
        "1",
      );
      expect(
        screen.queryByText(/Judge Name|Artist One Name|Artist Two Name/i),
      ).not.toBeInTheDocument();
    } finally {
      cleanup();
      stopArtistOneUpdates();
      stopArtistTwoUpdates();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  }, 15_000);
});
