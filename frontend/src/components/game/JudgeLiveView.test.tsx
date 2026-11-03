import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { LiveCanvas } from "@drawoff/contracts";
import { CanvasRenderer } from "@/game/render";
import { JudgeLiveView } from "./JudgeLiveView";

let renderCanvas: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  renderCanvas = vi.spyOn(CanvasRenderer.prototype, "render").mockImplementation(() => {});
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCanvas(index: number, revision = 0, locked = false): LiveCanvas {
  return {
    label: `Artist ${index}`,
    sequence: revision,
    canvas: {
      actions: revision > 0 ? [{ type: "clear", id: `clear-${index}-${revision}` }] : [],
      rev: revision,
      resets: 0,
    },
    locked,
  };
}

describe("JudgeLiveView", () => {
  it("shows anonymous read-only canvases and a submitted indicator", () => {
    render(<JudgeLiveView canvases={[makeCanvas(1), makeCanvas(2, 1, true)]} />);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Artist 1, live" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Artist 2, live" })).toBeInTheDocument();
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Alice|Bob|artist-1|artist-2/i)).not.toBeInTheDocument();
  });

  it("opens a drawing in focus and supports keyboard-focusable return and switch buttons", () => {
    render(<JudgeLiveView canvases={[makeCanvas(1), makeCanvas(2, 1, true)]} />);

    const artistTwoCard = screen.getByRole("button", { name: /Artist 2/ });
    expect(artistTwoCard).toHaveAttribute("type", "button");
    expect(artistTwoCard).toHaveClass("focus-visible:outline-3");
    artistTwoCard.focus();
    expect(artistTwoCard).toHaveFocus();
    fireEvent.click(artistTwoCard);

    expect(screen.getByRole("img", { name: "Artist 2, live" })).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Grid view/ })).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    const artistOneSwitch = screen.getByRole("button", { name: "Artist 1" });
    expect(artistOneSwitch).toHaveAttribute("type", "button");
    expect(artistOneSwitch).toHaveClass("focus-visible:outline-3");
    artistOneSwitch.focus();
    expect(artistOneSwitch).toHaveFocus();
    fireEvent.click(artistOneSwitch);
    expect(screen.getByRole("img", { name: "Artist 1, live" })).toBeInTheDocument();
  });

  it("keeps the selected drawing and renders new revisions while focused and after switching", () => {
    const initial = [makeCanvas(1), makeCanvas(2, 1)];
    const { rerender } = render(<JudgeLiveView canvases={initial} />);
    fireEvent.click(screen.getByRole("button", { name: /Artist 2/ }));

    const updated = [makeCanvas(1, 1), makeCanvas(2, 2, true)];
    rerender(<JudgeLiveView canvases={updated} />);

    expect(screen.getByRole("button", { name: "Artist 2" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(renderCanvas).toHaveBeenCalledWith(updated[1]!.canvas);

    fireEvent.click(screen.getByRole("button", { name: "Artist 1" }));
    expect(screen.getByRole("img", { name: "Artist 1, live" })).toBeInTheDocument();
    expect(renderCanvas).toHaveBeenCalledWith(updated[0]!.canvas);

    fireEvent.click(screen.getByRole("button", { name: /Grid view/ }));
    expect(screen.getByRole("img", { name: "Artist 1, live" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Artist 2, live" })).toBeInTheDocument();
  });

  it.each([
    ["small", 2, ["sm:grid-cols-2"]],
    ["larger", 12, ["sm:grid-cols-3", "lg:grid-cols-4"]],
  ] as const)("adapts the grid layout for a %s roster", (_size, count, layoutClasses) => {
    const { container } = render(
      <JudgeLiveView
        canvases={Array.from({ length: count }, (_, index) => makeCanvas(index + 1))}
      />,
    );
    const grid = container.firstElementChild;

    expect(grid).toHaveClass("grid-cols-1");
    for (const className of layoutClasses) expect(grid).toHaveClass(className);
    expect(screen.getAllByRole("button")).toHaveLength(count);
  });
});
