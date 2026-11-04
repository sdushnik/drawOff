import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { PlayerView } from "@drawoff/contracts";

type Player = { context: BrowserContext; page: Page; name: string };
type NavigationOutcome = { kind: "success" } | { kind: "error"; message: string };

async function isolatedPlayer(browser: Browser, name: string): Promise<Player> {
  const context = await browser.newContext();
  return { context, page: await context.newPage(), name };
}

async function waitForClientAndServer(page: Page): Promise<void> {
  const nameInput = page.getByLabel("Your name");
  await expect.poll(
    async () => nameInput.evaluate((input) =>
      Object.keys(input).some((key) => key.startsWith("__reactProps$"))
    ).catch(() => false),
    { message: "The frontend did not finish hydrating its name input.", timeout: 15_000 },
  ).toBe(true);
  await expect.poll(
    async () => page.evaluate(async () => {
      try {
        const response = await fetch("http://127.0.0.1:3100/health");
        const payload = await response.json() as { status?: string };
        return { ok: response.ok, status: payload.status ?? null };
      } catch (error) {
        return { ok: false, status: error instanceof Error ? error.message : String(error) };
      }
    }),
    { message: "The hydrated frontend could not reach the ready E2E backend.", timeout: 15_000 },
  ).toEqual({ ok: true, status: "ready" });
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
    return await handle.jsonValue() as NavigationOutcome;
  } catch (error) {
    const message = await page.getByRole("alert").textContent().catch(() => null);
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
        const inLobby = [...document.querySelectorAll("h1, h2, h3")]
          .some(({ textContent }) => textContent?.trim() === "Players");
        if (inLobby) return { kind: "success" };
        const message = document.querySelector('[role="alert"]')?.textContent?.trim();
        return message ? { kind: "error", message } : null;
      },
      undefined,
      { timeout: 15_000 },
    );
    return await handle.jsonValue() as NavigationOutcome;
  } catch (error) {
    const message = await page.getByRole("alert").textContent().catch(() => null);
    throw new Error(
      `${action} produced neither the lobby nor a visible error. URL: ${page.url()}. ` +
      `Visible error: ${message ?? "none"}. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function createRoom(player: Player): Promise<string> {
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
  return new URL(player.page.url()).pathname.split("/").at(-1)!;
}

async function joinRoom(player: Player, code: string): Promise<void> {
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

async function frontendServiceCall(
  page: Page,
  method: "startMatch" | "sendDrawOps" | "submitRatings",
  args: unknown[] = [],
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  return page.evaluate(
    async ({ method, args }) => {
      const code = location.pathname.split("/").at(-1)!.toUpperCase();
      const raw = sessionStorage.getItem(`drawoff:session:${code}`);
      if (!raw) throw new Error("The browser session was not stored.");
      const session = JSON.parse(raw);
      const serviceModule = await (0, eval)('import("/src/services/index.ts")');
      const service = serviceModule.getGameService();
      try {
        await service[method](session, ...args);
        return { ok: true } as const;
      } catch (error) {
        return {
          ok: false,
          code: typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN",
          message: error instanceof Error ? error.message : String(error),
        } as const;
      }
    },
    { method, args },
  );
}

async function currentView(page: Page): Promise<PlayerView> {
  return page.evaluate(async () => {
    const code = location.pathname.split("/").at(-1)!.toUpperCase();
    const raw = sessionStorage.getItem(`drawoff:session:${code}`);
    if (!raw) throw new Error("The browser session was not stored.");
    const session = JSON.parse(raw);
    const serviceModule = await (0, eval)('import("/src/services/index.ts")');
    const service = serviceModule.getGameService();

    return new Promise((resolve, reject) => {
      let unsubscribe = () => undefined;
      const timer = window.setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for the current player view."));
      }, 5_000);
      unsubscribe = service.subscribe(
        session,
        (view: PlayerView) => {
          window.clearTimeout(timer);
          unsubscribe();
          resolve(view);
        },
        (error: Error) => {
          window.clearTimeout(timer);
          unsubscribe();
          reject(error);
        },
      );
    });
  });
}

async function drawStroke(page: Page): Promise<void> {
  const canvas = page.getByLabel("Your canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Artist canvas has no bounding box.");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 80, { steps: 4 });
  await page.mouse.up();
}

test("three isolated browsers complete a private match and rematch through the real server", async ({ browser }) => {
  const players = await Promise.all([
    isolatedPlayer(browser, "Harper Host"),
    isolatedPlayer(browser, "Arlo Artist"),
    isolatedPlayer(browser, "Jules Artist"),
  ]);
  const [host, arlo, jules] = players;

  try {
    const code = await createRoom(host!);
    const start = host!.page.getByRole("button", { name: "Start match" });
    await expect(start).toBeDisabled();
    await joinRoom(arlo!, code);

    const unauthorizedStart = await frontendServiceCall(arlo!.page, "startMatch");
    expect(unauthorizedStart).toMatchObject({ ok: false, code: "FORBIDDEN" });
    await expect(start).toBeDisabled();

    await joinRoom(jules!, code);
    await expect(start).toBeEnabled();
    await start.click();

    const judgeOrder = [host!, arlo!, jules!];
    for (let round = 0; round < judgeOrder.length; round += 1) {
      const judge = judgeOrder[round]!;
      const artists = players.filter((player) => player !== judge);

      await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible();
      const firstSuggestion = judge.page
        .getByRole("group", { name: "Prompt suggestions" })
        .getByRole("button")
        .first();
      const prompt = (await firstSuggestion.textContent())?.trim();
      if (!prompt) throw new Error("The Judge did not receive a prompt suggestion.");
      await firstSuggestion.click();

      await expect(judge.page.getByLabel("Drawing 1, live")).toBeVisible();
      await expect(judge.page.getByLabel("Drawing 2, live")).toBeVisible();
      await expect(judge.page.getByLabel("Your canvas")).toHaveCount(0);
      await Promise.all(
        artists.map(async (artist) => {
          await expect(artist.page.getByText(prompt, { exact: true }).first()).toBeVisible();
          await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
          await expect(artist.page.getByLabel(/Drawing [12], live/)).toHaveCount(0);
          await drawStroke(artist.page);
        }),
      );

      const unauthorizedDraw = await frontendServiceCall(judge.page, "sendDrawOps", [[{
        type: "clear",
        id: `judge-cannot-draw-${round}`,
      }]]);
      expect(unauthorizedDraw).toMatchObject({ ok: false, code: "FORBIDDEN" });

      await expect.poll(async () => {
        const view = await currentView(judge.page);
        const sequences = view.liveCanvases?.map(({ sequence }) => sequence) ?? [];
        return sequences.length === 2 && sequences.every((sequence) => sequence > 0);
      }).toBe(true);

      const duplicateOp = {
        type: "stroke",
        id: `duplicate-${round}`,
        tool: "pen",
        color: "#111111",
        size: 8,
        points: [20, 20, 30, 30],
      };
      expect(await frontendServiceCall(artists[0]!.page, "sendDrawOps", [[duplicateOp]])).toEqual({ ok: true });
      expect(await frontendServiceCall(artists[0]!.page, "sendDrawOps", [[duplicateOp]])).toEqual({ ok: true });

      await expect.poll(async () => {
        const view = await currentView(judge.page);
        return view.liveCanvases?.map(({ canvas }) =>
          canvas.actions.filter(({ id }) => id === duplicateOp.id).length
        ) ?? [];
      }).toEqual([1, 0]);
      const privateArtistView = await currentView(artists[1]!.page);
      expect(privateArtistView.liveCanvases).toBeNull();
      expect(privateArtistView.gallery).toBeNull();

      if (round === 0) {
        const beforeReload = (await currentView(artists[0]!.page)).myCanvas?.canvas;
        expect(beforeReload?.rev).toBeGreaterThan(0);
        expect(beforeReload?.actions.filter(({ id }) => id === duplicateOp.id)).toHaveLength(1);
        await artists[0]!.page.reload();
        await expect(artists[0]!.page.getByLabel("Your canvas")).toBeVisible();
        await expect(judge.page.getByRole("alertdialog", { name: "Game paused" })).toHaveCount(0);
        await expect.poll(async () => {
          const restored = (await currentView(artists[0]!.page)).myCanvas?.canvas;
          return {
            revisionPreserved: (restored?.rev ?? -1) >= (beforeReload?.rev ?? 0),
            synchronizedActionCopies:
              restored?.actions.filter(({ id }) => id === duplicateOp.id).length ?? 0,
          };
        }).toEqual({ revisionPreserved: true, synchronizedActionCopies: 1 });
      }

      await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
      await expect(judge.page.getByText("0 of 2 rated")).toBeVisible();
      const judgingView = await currentView(judge.page);
      expect(judgingView.liveCanvases?.every(({ locked }) => locked)).toBe(true);
      expect(judgingView.gallery?.map(({ label }) => label)).toEqual(["Drawing 1", "Drawing 2"]);
      expect(judgingView.players.filter(({ name }) => name.startsWith("Anonymous player"))).toHaveLength(2);
      for (const artist of artists) {
        await expect(artist.page.getByText("Drawings are anonymous until the scores are locked in.")).toBeVisible();
        await expect(artist.page.getByLabel("Your submitted drawing")).toBeVisible();
        await expect(artist.page.getByLabel(/^Drawing [12]$/)).toHaveCount(0);
        await expect(judge.page.getByText(artist.name, { exact: true })).toHaveCount(0);
      }

      await judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" }).fill("80");
      await judge.page.getByRole("spinbutton", { name: "Drawing 2 rating" }).fill("60");
      await judge.page.getByRole("button", { name: "Submit all ratings" }).dblclick();

      await expect(judge.page.getByText(/Top drawing:/)).toBeVisible();
      for (const artist of artists) {
        await expect(judge.page.getByText(artist.name, { exact: true }).first()).toBeVisible();
      }

      const duplicateRatings = await frontendServiceCall(judge.page, "submitRatings", [{
        "Drawing 1": 80,
        "Drawing 2": 60,
      }]);
      expect(duplicateRatings).toEqual({ ok: true });
    }

    await expect(host!.page.getByText("3 rounds · 1 cycle")).toBeVisible();
    await expect(host!.page.getByRole("button", { name: "Play again" })).toBeVisible();
    for (const player of players) await expect(player.page.getByText(/wins!|Co-winners!/)).toBeVisible();
    const expectedScores = new Map([
      ["Harper Host", "160"],
      ["Arlo Artist", "140"],
      ["Jules Artist", "120"],
    ]);
    for (const [name, score] of expectedScores) {
      await expect(host!.page.locator("ol li").filter({ hasText: name })).toContainText(score);
    }

    await host!.page.getByRole("button", { name: "Play again" }).click();
    await expect(host!.page).toHaveURL(new RegExp(`/room/${code}$`));
    await expect(host!.page.getByRole("heading", { name: "Players" })).toBeVisible();
    await expect(host!.page.getByText("Leaderboard")).toHaveCount(0);

    const newcomer = await isolatedPlayer(browser, "Nova Newcomer");
    players.push(newcomer);
    await joinRoom(newcomer, code);
    await expect(host!.page.getByText("4 rounds ·", { exact: false })).toBeVisible();
    await host!.page.getByRole("button", { name: "Start match" }).click();
    await expect(host!.page.getByText("Round 1 of 4")).toBeVisible();
    await expect(host!.page.getByText("Artist: Nova Newcomer")).toBeVisible();
    const rematchView = await currentView(host!.page);
    expect(rematchView.match?.order).toHaveLength(4);
    expect(Object.values(rematchView.match?.scores ?? {})).toEqual([0, 0, 0, 0]);
  } finally {
    await Promise.all(players.map(({ context }) => context.close()));
  }
});

test("a required browser timing out cancels the incomplete match without a winner", async ({ browser }) => {
  const players = await Promise.all([
    isolatedPlayer(browser, "Timeout Host"),
    isolatedPlayer(browser, "Returning Artist"),
    isolatedPlayer(browser, "Missing Artist"),
  ]);
  const [host, returning, missing] = players;

  try {
    const code = await createRoom(host!);
    await joinRoom(returning!, code);
    await joinRoom(missing!, code);
    await host!.page.getByRole("button", { name: "Start match" }).click();
    await expect(host!.page.getByRole("heading", { name: "Pick the word" })).toBeVisible();
    await host!.page.getByRole("group", { name: "Prompt suggestions" }).getByRole("button").first().click();
    await expect(missing!.page.getByLabel("Your canvas")).toBeVisible();

    await missing!.context.close();
    await expect(host!.page.getByRole("alertdialog", { name: "Game paused" })).toBeVisible();
    await expect(host!.page.getByRole("heading", { name: "Players" })).toBeVisible({ timeout: 5_000 });
    await expect(host!.page.getByRole("status").filter({ hasText: /match was canceled/i })).toContainText("No winner was declared");
    await expect(host!.page.getByText(/wins!|Co-winners!/)).toHaveCount(0);
    await expect(returning!.page.getByRole("heading", { name: "Players" })).toBeVisible();
  } finally {
    await Promise.all(players.map(({ context }) => context.close().catch(() => undefined)));
  }
});
