import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JudgingGallery } from "./JudgingGallery";
import { emptyCanvas } from "@/game/canvasOps";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];

const gallery = [
  { label: "Drawing 1", canvas: emptyCanvas() },
  { label: "Drawing 2", canvas: emptyCanvas() },
];

function rate(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(`${label} rating`), { target: { value } });
}

describe("JudgingGallery", () => {
  it("shows the prompt and frozen drawings using anonymous labels and accessible names", () => {
    render(<JudgingGallery prompt="owl" gallery={gallery} overtime={false} onSubmit={vi.fn()} />);

    expect(screen.getByText("owl")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Drawing 1" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Drawing 2" })).toBeInTheDocument();
    expect(screen.getByLabelText("Drawing 1 rating slider")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Drawing 2 rating" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Artist Alice");
    expect(document.body.textContent).not.toContain("player-id-123");
    expect(screen.getByText("0 of 2 rated")).toBeInTheDocument();
  });

  it("does not count empty, fractional, or out-of-range values as rated", () => {
    const onSubmit = vi.fn();
    render(<JudgingGallery prompt="owl" gallery={gallery} overtime={false} onSubmit={onSubmit} />);

    const submit = screen.getByRole("button", { name: /rate 2 more/i });
    expect(submit).toBeDisabled();

    rate("Drawing 1", "1.5");
    expect(screen.getByText("Whole number from 0 to 100.")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 rated")).toBeInTheDocument();

    rate("Drawing 1", "-1");
    expect(screen.getByText("0 of 2 rated")).toBeInTheDocument();
    rate("Drawing 1", "101");
    expect(screen.getByText("0 of 2 rated")).toBeInTheDocument();

    rate("Drawing 1", "");
    rate("Drawing 2", "86");
    expect(screen.getByText("1 of 2 rated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rate 1 more/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("enables submit only when every drawing has one integer rating, including 0 and 100", () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<JudgingGallery prompt="owl" gallery={gallery} overtime={false} onSubmit={onSubmit} />);

    rate("Drawing 1", "0");
    expect(screen.getByText("1 of 2 rated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rate 1 more/i })).toBeDisabled();

    rate("Drawing 2", "100");
    const submit = screen.getByRole("button", { name: /submit all ratings/i });
    expect(screen.getByText("2 of 2 rated")).toBeInTheDocument();
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ "Drawing 1": 0, "Drawing 2": 100 });
  });

  it("suppresses duplicate submissions while the request is pending", async () => {
    let resolveSubmission!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolveSubmission = resolve;
    });
    const onSubmit = vi.fn().mockReturnValue(pending);
    render(<JudgingGallery prompt="owl" gallery={gallery} overtime={false} onSubmit={onSubmit} />);
    rate("Drawing 1", "0");
    rate("Drawing 2", "100");

    const submit = screen.getByRole("button", { name: /submit all ratings/i });
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /submitting/i })).toBeDisabled();
    await act(async () => {
      resolveSubmission(true);
      await pending;
    });
    expect(screen.getByRole("button", { name: /submitting/i })).toBeDisabled();
  });

  it("preserves ratings and enables retry when submission fails", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(true);
    render(<JudgingGallery prompt="owl" gallery={gallery} overtime={false} onSubmit={onSubmit} />);
    rate("Drawing 1", "0");
    rate("Drawing 2", "100");

    fireEvent.click(screen.getByRole("button", { name: /submit all ratings/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /submit all ratings/i })).toBeEnabled(),
    );

    expect(screen.getByText("2 of 2 rated")).toBeInTheDocument();
    expect(screen.getByLabelText("Drawing 1 rating")).toHaveValue(0);
    expect(screen.getByLabelText("Drawing 2 rating")).toHaveValue(100);

    fireEvent.click(screen.getByRole("button", { name: /submit all ratings/i }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({ "Drawing 1": 0, "Drawing 2": 100 });
  });
});
