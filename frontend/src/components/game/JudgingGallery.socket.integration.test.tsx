import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketIOServer } from "socket.io";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "@drawoff/contracts";
import { createSocketGameService } from "@/services/socketGameService";
import { emptyCanvas } from "@/game/canvasOps";
import { JudgingGallery } from "./JudgingGallery";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];

afterEach(cleanup);

describe("JudgingGallery Socket.IO integration", () => {
  it("sends one anonymous rating per label and preserves ratings to retry a server failure", async () => {
    const httpServer = createHttpServer();
    const io = new SocketIOServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const service = createSocketGameService(address);
    const session: Session = { roomCode: "ABC123", playerId: "judge", token: "session-token" };
    const requests: unknown[] = [];
    let stopUpdates = () => {};
    let releaseFirstFailure!: () => void;
    const firstRequestPending = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });

    io.on("connection", (socket) => {
      socket.on("state:subscribe", (_payload, acknowledge) => acknowledge({}));
      socket.on("ratings:submit", (payload, acknowledge) => {
        requests.push(payload);
        if (requests.length === 1) {
          void firstRequestPending.then(() =>
            socket.emit("error", {
              code: "SERVICE_UNAVAILABLE",
              message: "Simulated rating service failure.",
            }),
          );
        } else {
          acknowledge({});
        }
      });
    });

    try {
      stopUpdates = service.subscribe(session, () => {});
      render(
        <JudgingGallery
          prompt="owl"
          gallery={[
            { label: "Drawing 1", canvas: emptyCanvas() },
            { label: "Drawing 2", canvas: emptyCanvas() },
          ]}
          overtime={false}
          onSubmit={(ratings) => service.submitRatings(session, ratings)}
        />,
      );

      fireEvent.change(screen.getByLabelText("Drawing 1 rating"), { target: { value: "0" } });
      fireEvent.change(screen.getByLabelText("Drawing 2 rating"), { target: { value: "100" } });
      const submit = screen.getByRole("button", { name: /submit all ratings/i });
      await act(async () => {
        fireEvent.click(submit);
        fireEvent.click(submit);
      });

      await waitFor(() => expect(requests).toHaveLength(1));
      const exactPayload = {
        session,
        ratings: { "Drawing 1": 0, "Drawing 2": 100 },
      };
      expect(requests[0]).toEqual(exactPayload);
      expect(screen.getByRole("button", { name: /submitting/i })).toBeDisabled();

      await act(async () => {
        releaseFirstFailure();
        await firstRequestPending;
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /submit all ratings/i })).toBeEnabled(),
      );
      expect(screen.getByLabelText("Drawing 1 rating")).toHaveValue(0);
      expect(screen.getByLabelText("Drawing 2 rating")).toHaveValue(100);

      fireEvent.click(screen.getByRole("button", { name: /submit all ratings/i }));
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]).toEqual(exactPayload);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /submitting/i })).toBeDisabled(),
      );
    } finally {
      stopUpdates();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });
});
