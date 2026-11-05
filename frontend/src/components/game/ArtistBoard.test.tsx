import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CanvasSnapshot, DrawOp } from "@drawoff/contracts";
import { emptyCanvas } from "@/game/canvasOps";
import { ArtistBoard, mapPointerToCanvas } from "./ArtistBoard";

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

Object.defineProperty(window, "PointerEvent", { value: TestPointerEvent, configurable: true });
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
HTMLCanvasElement.prototype.setPointerCapture = vi.fn();

function renderBoard({
  initial = emptyCanvas(),
  locked = false,
  timeUp = false,
  onSend = vi.fn().mockResolvedValue(undefined),
  onSubmit = vi.fn().mockResolvedValue(true),
}: {
  initial?: CanvasSnapshot;
  locked?: boolean;
  timeUp?: boolean;
  onSend?: (ops: DrawOp[]) => Promise<void>;
  onSubmit?: () => Promise<unknown>;
} = {}) {
  const result = render(
    <ArtistBoard initial={initial} locked={locked} timeUp={timeUp} onSend={onSend} onSubmit={onSubmit} />,
  );
  const canvas = screen.getByLabelText("Your canvas");
  return { ...result, canvas, onSend, onSubmit };
}

function setCanvasRect(
  canvas: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
) {
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("ArtistBoard", () => {
  it("maps pointer coordinates proportionally after a responsive resize", () => {
    expect(mapPointerToCanvas(130, 115, { left: 10, top: 25, width: 240, height: 180 })).toEqual([
      300,
      225,
    ]);
    expect(mapPointerToCanvas(70, 47.5, { left: 10, top: 25, width: 120, height: 45 })).toEqual([
      300,
      225,
    ]);
    expect(mapPointerToCanvas(-10, 500, { left: 0, top: 0, width: 0, height: 0 })).toEqual([0, 0]);
  });

  it("supports touch pointer input without allowing canvas gestures to scroll the page", async () => {
    const { canvas, onSend } = renderBoard();
    setCanvasRect(canvas, { left: 10, top: 20, width: 200, height: 150 });
    expect(canvas).toHaveClass("aspect-[4/3]", "touch-none", "overscroll-contain");

    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 60,
      clientY: 45,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 110,
      clientY: 95,
    });
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(screen.getByRole("button", { name: /submit early/i }));

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const sent = vi.mocked(onSend).mock.calls.flatMap(([ops]) => ops);
    expect(sent).toEqual([
      expect.objectContaining({ type: "stroke", points: [150, 75, 300, 225] }),
    ]);
  });

  it("exposes selected tools, colors, and brush sizes and queues fill, undo, and clear", async () => {
    const { canvas, onSend } = renderBoard({
      initial: { actions: [{ type: "clear", id: "seed" }], rev: 0, resets: 0 },
    });
    setCanvasRect(canvas, { left: 0, top: 0, width: 600, height: 450 });

    const pen = screen.getByRole("button", { name: "Pen" });
    const eraser = screen.getByRole("button", { name: "Eraser" });
    const fill = screen.getByRole("button", { name: "Bucket fill" });
    expect(pen).toHaveAttribute("aria-pressed", "true");

    const firstColor = screen.getByRole("button", { name: "Color #1f1b16" });
    expect(firstColor).toHaveClass("size-7", "focus-visible:outline-3");

    fireEvent.click(screen.getByRole("button", { name: "Color #e5484d" }));
    fireEvent.click(screen.getByRole("button", { name: "Brush 16px" }));
    fireEvent.click(eraser);
    expect(eraser).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Color #e5484d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Brush 16px" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    fireEvent.click(fill);
    expect(fill).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 30, clientY: 40 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: /submit early/i }));

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const sent = vi.mocked(onSend).mock.calls.flatMap(([ops]) => ops);
    expect(sent).toEqual([
      expect.objectContaining({ type: "stroke", tool: "eraser", size: 16 }),
      expect.objectContaining({ type: "fill", color: "#e5484d", x: 30, y: 40 }),
      expect.objectContaining({ type: "undo" }),
      expect.objectContaining({ type: "clear" }),
    ]);
  });

  it("announces when drawing becomes locked without relying on its visual overlay", () => {
    const { rerender } = render(
      <ArtistBoard
        initial={emptyCanvas()}
        locked={false}
        timeUp={false}
        onSend={vi.fn().mockResolvedValue(undefined)}
        onSubmit={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(
      <ArtistBoard
        initial={emptyCanvas()}
        locked
        timeUp={false}
        onSend={vi.fn().mockResolvedValue(undefined)}
        onSubmit={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Submitted — you can continue drawing");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("pauses editing after early submit but keeps the continue control enabled", () => {
    renderBoard({ locked: true });
    expect(screen.getByRole("button", { name: "Pen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bucket fill" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Color #e5484d" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Brush 8px" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue drawing" })).toBeEnabled();
  });

  it("locks every control after the server deadline", () => {
    renderBoard({ timeUp: true });
    expect(screen.getByRole("button", { name: "Pen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bucket fill" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit early" })).toBeDisabled();
  });

  it("resumes editing when a submitted Artist presses continue", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    renderBoard({ locked: true, onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Continue drawing" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pen" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Submit early" })).toBeEnabled();
  });

  it("locks immediately on early submit and waits for every queued operation acknowledgement", async () => {
    let acknowledge!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { canvas } = renderBoard({ onSend, onSubmit });
    setCanvasRect(canvas, { left: 0, top: 0, width: 600, height: 450 });
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 30, clientY: 40 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: /submit early/i }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pen" })).toBeDisabled();
    fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 90, clientY: 100 });
    await act(async () => acknowledge());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    fireEvent.pointerDown(canvas, { pointerId: 3, clientX: 120, clientY: 130 });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
