import type { Page } from "@playwright/test";
import { expect, type Player } from "./fixtures";

type NavigationOutcome = { kind: "success" } | { kind: "error"; message: string };

export async function waitForClientAndServer(page: Page): Promise<void> {
  const nameInput = page.getByLabel("Your name");
  await expect
    .poll(
      async () =>
        nameInput
          .evaluate((input) => Object.keys(input).some((key) => key.startsWith("__reactProps$")))
          .catch(() => false),
      { message: "The frontend did not finish hydrating its name input.", timeout: 15_000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          try {
            const response = await fetch("/health");
            const payload = (await response.json()) as { status?: string };
            return { ok: response.ok, status: payload.status ?? null };
          } catch (error) {
            return { ok: false, status: error instanceof Error ? error.message : String(error) };
          }
        }),
      { message: "The hydrated frontend could not reach the ready E2E backend.", timeout: 15_000 },
    )
    .toEqual({ ok: true, status: "ready" });
}

async function waitForNavigationOutcome(
  page: Page,
  successfulPath: RegExp,
  action: string,
): Promise<NavigationOutcome> {
  try {
    const handle = await page.waitForFunction(
      (source) => {
        const pattern = new RegExp(source);
        if (pattern.test(location.pathname)) return { kind: "success" };
        const message = document.querySelector('[role="alert"]')?.textContent?.trim();
        return message ? { kind: "error", message } : null;
      },
      successfulPath.source,
      { timeout: 15_000 },
    );
    return (await handle.jsonValue()) as NavigationOutcome;
  } catch (error) {
    const message = await page
      .getByRole("alert")
      .textContent()
      .catch(() => null);
    throw new Error(
      `${action} produced neither navigation nor a visible error. URL: ${page.url()}. ` +
        `Visible error: ${message ?? "none"}. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function waitForLobbyOutcome(page: Page, action: string): Promise<NavigationOutcome> {
  try {
    const handle = await page.waitForFunction(
      () => {
        const inLobby = [...document.querySelectorAll("h1, h2, h3")].some(
          ({ textContent }) => textContent?.trim() === "Players",
        );
        if (inLobby) return { kind: "success" };
        const message = document.querySelector('[role="alert"]')?.textContent?.trim();
        return message ? { kind: "error", message } : null;
      },
      undefined,
      { timeout: 15_000 },
    );
    return (await handle.jsonValue()) as NavigationOutcome;
  } catch (error) {
    const message = await page
      .getByRole("alert")
      .textContent()
      .catch(() => null);
    throw new Error(
      `${action} produced neither the lobby nor a visible error. URL: ${page.url()}. ` +
        `Visible error: ${message ?? "none"}. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function createRoom(player: Player): Promise<string> {
  await player.page.goto("/");
  await waitForClientAndServer(player.page);
  await player.page.getByLabel("Your name").fill(player.name);
  await expect(player.page.getByLabel("Your name")).toHaveValue(player.name);
  await player.page.getByRole("button", { name: /Create a room/ }).click();
  const outcome = await waitForNavigationOutcome(
    player.page,
    /^\/room\/[A-Z0-9]{5,6}$/,
    `Creating a room for ${player.name}`,
  );
  if (outcome.kind === "error") {
    throw new Error(`Creating a room for ${player.name} failed: ${outcome.message}`);
  }
  await expect(player.page.getByRole("heading", { name: "Players" })).toBeVisible();
  return new URL(player.page.url()).pathname.split("/").at(-1)!;
}

export async function joinRoom(player: Player, code: string): Promise<void> {
  await player.page.goto(`/room/${code}`);
  await waitForClientAndServer(player.page);
  await player.page.getByLabel("Your name").fill(player.name);
  await expect(player.page.getByLabel("Your name")).toHaveValue(player.name);
  await player.page.getByRole("button", { name: "Join room" }).click();
  const outcome = await waitForLobbyOutcome(player.page, `Joining room ${code} as ${player.name}`);
  if (outcome.kind === "error") {
    throw new Error(`Joining room ${code} as ${player.name} failed: ${outcome.message}`);
  }
  await expect(player.page.getByRole("heading", { name: "Players" })).toBeVisible();
}
