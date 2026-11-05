import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESULT_CELEBRATION_MS,
  stagedRevealCount,
  useResultReveal,
} from "./useResultReveal";

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("result reveal progress", () => {
  it("reveals any supported card count sequentially within the reveal budget", () => {
    expect(stagedRevealCount(3, 0)).toBe(1);
    expect(stagedRevealCount(3, 799)).toBe(1);
    expect(stagedRevealCount(3, 800)).toBe(2);
    expect(stagedRevealCount(3, 1_600)).toBe(3);
    expect(stagedRevealCount(20, RESULT_CELEBRATION_MS)).toBe(20);
  });

  it("advances cards and celebration from the authoritative start time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    setReducedMotion(false);
    const { result } = renderHook(() => useResultReveal(3, 10_000));

    expect(result.current.revealedCount).toBe(1);
    expect(result.current.celebrationReady).toBe(false);

    act(() => vi.advanceTimersByTime(1_650));
    expect(result.current.revealedCount).toBe(3);
    expect(result.current.celebrationReady).toBe(false);

    act(() => vi.advanceTimersByTime(1_050));
    expect(result.current.celebrationReady).toBe(true);
  });

  it("catches up after reconnect instead of restarting the sequence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    setReducedMotion(false);

    const { result } = renderHook(() => useResultReveal(4, 15_000));

    expect(result.current.revealedCount).toBe(4);
    expect(result.current.celebrationReady).toBe(true);
  });

  it("shows everything immediately when reduced motion is requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    setReducedMotion(true);

    const { result } = renderHook(() => useResultReveal(5, 30_000));

    expect(result.current.revealedCount).toBe(5);
    expect(result.current.celebrationReady).toBe(true);
  });
});
