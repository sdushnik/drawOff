import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasSnapshot } from "@drawoff/contracts";
import { TimelapseCanvas, timelapseSnapshot } from "./TimelapseCanvas";

vi.mock("./DrawingCanvas", () => ({
  DrawingCanvas: ({ canvas, ariaLabel }: { canvas: CanvasSnapshot; ariaLabel: string }) => (
    <div role="img" aria-label={ariaLabel} data-actions={canvas.actions.length} />
  ),
}));

afterEach(cleanup);

const artwork: CanvasSnapshot = {
  actions: [
    {
      type: "stroke",
      id: "stroke-1",
      tool: "pen",
      color: "#000000",
      size: 8,
      points: [10, 10, 20, 20, 30, 30],
    },
    { type: "fill", id: "fill-1", x: 100, y: 100, color: "#0090ff" },
    { type: "clear", id: "clear-1" },
  ],
  rev: 3,
  resets: 1,
};

describe("TimelapseCanvas", () => {
  it("builds deterministic frames without mutating the final artwork", () => {
    const original = structuredClone(artwork);

    expect(timelapseSnapshot(artwork, 0).actions).toEqual([]);
    expect(timelapseSnapshot(artwork, 0.4).actions).toEqual([
      expect.objectContaining({ type: "stroke", points: [10, 10, 20, 20] }),
    ]);
    expect(timelapseSnapshot(artwork, 0.8).actions.map(({ type }) => type)).toEqual([
      "stroke",
      "fill",
    ]);
    expect(timelapseSnapshot(artwork, 1).actions).toEqual(artwork.actions);
    expect(artwork).toEqual(original);
  });

  it("shows the final drawing until playback is requested", () => {
    render(<TimelapseCanvas canvas={artwork} ariaLabel="Alex's drawing" />);

    expect(screen.getByRole("img", { name: "Alex's drawing" })).toHaveAttribute(
      "data-actions",
      "3",
    );
    fireEvent.click(screen.getByRole("button", { name: "Play timelapse" }));
    expect(screen.getByRole("img", { name: "Alex's drawing" })).toHaveAttribute(
      "data-actions",
      "0",
    );
    expect(screen.getByRole("button", { name: "Playing timelapse…" })).toBeDisabled();
  });
});
