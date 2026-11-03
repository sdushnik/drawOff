import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Session } from "@drawoff/contracts";
import { Home } from "../routes/index";
import { ServiceProvider } from "@/services/ServiceProvider";
import type { GameService } from "@/services/gameService";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigate };
});

const session: Session = { roomCode: "ABC123", playerId: "player-1", token: "secret-token" };

function createService() {
  return {
    capabilities: { demoPlayers: false, label: "Test service" },
    createRoom: vi.fn(async (_name: string) => session),
    joinRoom: vi.fn(async (_code: string, _name: string) => session),
    resumeSession: vi.fn(async () => session),
    leaveRoom: vi.fn(async () => {}),
    kickPlayer: vi.fn(async () => {}),
    setCycles: vi.fn(async () => {}),
    addDemoPlayer: vi.fn(async () => {}),
    startMatch: vi.fn(async () => {}),
    selectPrompt: vi.fn(async () => {}),
    sendDrawOps: vi.fn(async () => {}),
    submitCanvas: vi.fn(async () => {}),
    submitRatings: vi.fn(async () => {}),
    rematch: vi.fn(async () => {}),
    returnToLobby: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  } satisfies GameService;
}

function renderHome(service = createService()) {
  render(
    <ServiceProvider service={service}>
      <Home />
    </ServiceProvider>,
  );
  return service;
}

afterEach(() => {
  window.sessionStorage.clear();
  navigate.mockReset();
});

describe("home room entry", () => {
  it("contains guest-entry content at 320px and stacks controls before the small breakpoint", () => {
    renderHome();

    const main = document.querySelector("main");
    const layout = main?.firstElementChild;
    const sections = main?.querySelectorAll("section");
    const form = screen.getByRole("button", { name: /create a room/i }).closest("form");
    const joinInput = screen.getByLabelText("Room code or invite link");
    const joinControls = joinInput.parentElement;

    expect(main).not.toHaveClass("overflow-hidden");
    expect(layout).toHaveClass("w-full", "min-w-0", "px-4", "sm:px-5");
    expect(sections).toHaveLength(2);
    for (const section of sections ?? []) expect(section).toHaveClass("min-w-0");
    expect(form).toHaveClass("w-full", "min-w-0", "max-w-md");
    expect(joinControls).toHaveClass("min-w-0", "flex-col", "sm:flex-row");
    expect(joinInput).toHaveClass("min-w-0");
    expect(screen.getByRole("button", { name: /^join$/i })).toHaveClass("w-full", "sm:w-auto");
  });

  it("labels both inputs and rejects invalid names and room codes before service calls", () => {
    const service = renderHome();

    expect(screen.getByLabelText("Your name")).toBeInTheDocument();
    expect(screen.getByLabelText("Room code or invite link")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: /create a room/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Name must be 2–20 characters.");
    expect(service.createRoom).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Room code or invite link"), { target: { value: "AB12" } });
    fireEvent.click(screen.getByRole("button", { name: /^join$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Name must be 2–20 characters.");
    expect(service.joinRoom).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "A valid name that is too long" } });
    fireEvent.click(screen.getByRole("button", { name: /^join$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Name must be 2–20 characters.");
    expect(service.joinRoom).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: /^join$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid room code or invite link.");
    expect(service.joinRoom).not.toHaveBeenCalled();
  });

  it("creates a room with a normalized name, saves the session, and navigates", async () => {
    const service = renderHome();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "  Ada   Lovelace  " } });

    fireEvent.click(screen.getByRole("button", { name: /create a room/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/room/$code", params: { code: "ABC123" } }));
    expect(service.createRoom).toHaveBeenCalledWith("Ada Lovelace");
    expect(window.sessionStorage.getItem("drawoff:session:ABC123")).toContain(session.token);
  });

  it("joins with a normalized invite link, saves the session, and navigates", async () => {
    const service = renderHome();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "  Ada   Lovelace  " } });
    fireEvent.change(screen.getByLabelText("Room code or invite link"), {
      target: { value: "https://draw.example/room/abc123?invite=1" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^join$/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/room/$code", params: { code: "ABC123" } }));
    expect(service.joinRoom).toHaveBeenCalledWith("ABC123", "Ada Lovelace");
    expect(window.sessionStorage.getItem("drawoff:session:ABC123")).toContain(session.token);
  });

  it("disables both actions while pending and prevents duplicate service requests", async () => {
    const service = renderHome();
    let resolveCreate!: (value: Session) => void;
    service.createRoom.mockReturnValueOnce(
      new Promise<Session>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });

    fireEvent.click(screen.getByRole("button", { name: /create a room/i }));

    const createButton = screen.getByRole("button", { name: /create a room/i });
    const joinButton = screen.getByRole("button", { name: /^join$/i });
    expect(createButton).toBeDisabled();
    expect(joinButton).toBeDisabled();
    fireEvent.click(createButton);
    fireEvent.click(joinButton);
    expect(service.createRoom).toHaveBeenCalledTimes(1);
    expect(service.joinRoom).not.toHaveBeenCalled();

    resolveCreate(session);
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  });

  it("shows service failures accessibly and permits a retry", async () => {
    const service = renderHome();
    service.createRoom
      .mockRejectedValueOnce(new Error("Network unavailable."))
      .mockResolvedValueOnce(session);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });

    fireEvent.click(screen.getByRole("button", { name: /create a room/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable.");
    const createButton = screen.getByRole("button", { name: /create a room/i });
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);

    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(service.createRoom).toHaveBeenCalledTimes(2);
  });
});
