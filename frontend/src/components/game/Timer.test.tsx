import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Timer } from "./Timer";

const { countdown } = vi.hoisted(() => ({ countdown: { seconds: 11 as number | null } }));
vi.mock("@/hooks/useGameRoom", () => ({
  useCountdown: () => countdown.seconds,
}));

const start = vi.fn();
const stop = vi.fn();
const oscillator = {
  type: "sine",
  frequency: { setValueAtTime: vi.fn() },
  connect: vi.fn(),
  start,
  stop,
};
const gain = {
  gain: {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  },
  connect: vi.fn(),
};

class FakeAudioContext {
  currentTime = 1;
  state = "running";
  destination = {};
  createOscillator = () => oscillator;
  createGain = () => gain;
  resume = vi.fn().mockResolvedValue(undefined);
}

const originalAudioContext = window.AudioContext;
Object.defineProperty(window, "AudioContext", {
  configurable: true,
  value: FakeAudioContext as unknown as typeof AudioContext,
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  countdown.seconds = 11;
  vi.clearAllMocks();
});

afterAll(() => {
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: originalAudioContext,
  });
});

describe("Timer countdown sound", () => {
  it("ticks during the last ten drawing seconds and lets the player mute it", () => {
    const { rerender } = render(
      <Timer deadline={20_000} clockOffset={0} countdownSound />,
    );
    expect(start).not.toHaveBeenCalled();

    countdown.seconds = 10;
    rerender(<Timer deadline={20_000} clockOffset={0} countdownSound />);
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("timer")).toHaveTextContent("0:10");

    fireEvent.click(screen.getByRole("button", { name: "Mute countdown sound" }));
    expect(window.localStorage.getItem("drawoff:countdown-sound")).toBe("off");

    countdown.seconds = 9;
    rerender(<Timer deadline={20_000} clockOffset={0} countdownSound />);
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Enable countdown sound" })).toBeInTheDocument();
  });
});
