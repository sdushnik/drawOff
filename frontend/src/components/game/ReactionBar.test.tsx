import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reaction } from "@drawoff/contracts";
import { ReactionBar } from "./ReactionBar";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const reaction: Reaction = {
  id: "reaction-1",
  playerId: "player-1",
  playerName: "Alex",
  emoji: "🔥",
  sentAt: 1_000,
};

describe("ReactionBar", () => {
  it("offers the fixed accessible reaction set and applies a short send cooldown", () => {
    vi.useFakeTimers();
    const onReact = vi.fn(async () => true);
    render(<ReactionBar reactions={[]} onReact={onReact} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "React with Fire" }));
    expect(onReact).toHaveBeenCalledWith("🔥");
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("button", { name: "React with Fire" })).toBeEnabled();
  });

  it("shows incoming reactions visually and announces only their arrival", () => {
    const { rerender } = render(<ReactionBar reactions={[]} onReact={vi.fn(async () => true)} />);
    const liveRegion = screen.getByRole("status");

    rerender(<ReactionBar reactions={[reaction]} onReact={vi.fn(async () => true)} />);
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(liveRegion).toHaveTextContent("Alex reacted 🔥");

    rerender(<ReactionBar reactions={[]} onReact={vi.fn(async () => true)} />);
    expect(screen.queryByText("Alex")).not.toBeInTheDocument();
    expect(liveRegion).toHaveTextContent("Alex reacted 🔥");
  });
});
