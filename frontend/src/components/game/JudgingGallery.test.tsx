import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { JudgingGallery } from "./JudgingGallery";
import { emptyCanvas } from "@/game/canvasOps";

// Radix Slider measures layout; jsdom lacks ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom has no canvas; the renderer skips drawing when there's no context.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];

const gallery = [
  { label: "Drawing 1", canvas: emptyCanvas() },
  { label: "Drawing 2", canvas: emptyCanvas() },
];

describe("JudgingGallery", () => {
  it("only allows submitting once every drawing has a valid 0–100 rating", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<JudgingGallery prompt="owl" gallery={gallery} overtime={false} onSubmit={onSubmit} />);

    expect(screen.getByText("owl")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 rated")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Drawing 1 rating"), { target: { value: "86" } });
    expect(screen.getByText("1 of 2 rated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rate 1 more/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Drawing 2 rating"), { target: { value: "150" } });
    expect(screen.getByText("Whole number from 0 to 100.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rate 1 more/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Drawing 2 rating"), { target: { value: "0" } });
    const submit = screen.getByRole("button", { name: /submit all ratings/i });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ "Drawing 1": 86, "Drawing 2": 0 });
  });
});
