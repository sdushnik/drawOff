import type { Locator, Page } from "@playwright/test";
import type { DrawOp, PlayerView, Session } from "@drawoff/contracts";
import { createSocketGameService } from "../src/services/socketGameService";
import { expect, test, type Player } from "./fixtures";

type NavigationOutcome = { kind: "success" } | { kind: "error"; message: string };

async function waitForClientAndServer(page: Page): Promise<void> {
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
  method: "startMatch" | "sendDrawOps" | "submitCanvas" | "submitRatings",
  args: unknown[] = [],
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const session = await storedSession(page);
  const service = createSocketGameService(serverUrl());
  let unsubscribe = () => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      unsubscribe = service.subscribe(session, () => resolve(), reject);
    });
    if (method === "startMatch") await service.startMatch(session);
    if (method === "sendDrawOps") await service.sendDrawOps(session, args[0] as DrawOp[]);
    if (method === "submitCanvas") await service.submitCanvas(session);
    if (method === "submitRatings") {
      await service.submitRatings(session, args[0] as Record<string, number>);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unsubscribe();
  }
}

async function currentView(page: Page): Promise<PlayerView> {
  const session = await storedSession(page);
  const service = createSocketGameService(serverUrl());
  return new Promise((resolve, reject) => {
    let unsubscribe = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the current player view."));
    }, 5_000);
    unsubscribe = service.subscribe(
      session,
      (view) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(view);
      },
      (error) => {
        clearTimeout(timer);
        unsubscribe();
        reject(error);
      },
    );
  });
}

async function storedSession(page: Page): Promise<Session> {
  return page.evaluate(() => {
    const code = location.pathname.split("/").at(-1)!.toUpperCase();
    const raw = sessionStorage.getItem(`drawoff:session:${code}`);
    if (!raw) throw new Error("The browser session was not stored.");
    return JSON.parse(raw) as Session;
  });
}

function serverUrl(): string {
  return process.env["DRAWOFF_E2E_BASE_URL"] ?? "http://127.0.0.1:8080";
}

async function renderedCanvasHash(canvas: Locator): Promise<string> {
  await expect(canvas).toBeVisible();
  return canvas.evaluate(async (element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("Expected a canvas element.");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("The browser did not provide a 2D canvas context.");
    const rgba = context.getImageData(0, 0, element.width, element.height).data;
    const digest = await crypto.subtle.digest("SHA-256", rgba);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
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

test("three isolated browsers complete a private match and rematch through the real server", async ({
  players: playerPool,
}) => {
  const players = await Promise.all([
    playerPool.create("Harper Host"),
    playerPool.create("Arlo Artist"),
    playerPool.create("Jules Artist"),
  ]);
  const [host, arlo, jules] = players;

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

    await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
      timeout: 15_000,
    });
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

    const unauthorizedDraw = await frontendServiceCall(judge.page, "sendDrawOps", [
      [
        {
          type: "clear",
          id: `judge-cannot-draw-${round}`,
        },
      ],
    ]);
    expect(unauthorizedDraw).toMatchObject({ ok: false, code: "FORBIDDEN" });

    await expect
      .poll(async () => {
        const view = await currentView(judge.page);
        const sequences = view.liveCanvases?.map(({ sequence }) => sequence) ?? [];
        return sequences.length === 2 && sequences.every((sequence) => sequence > 0);
      })
      .toBe(true);

    const duplicateOp = {
      type: "stroke",
      id: `duplicate-${round}`,
      tool: "pen",
      color: "#111111",
      size: 8,
      points: [20, 20, 30, 30],
    };
    expect(await frontendServiceCall(artists[0]!.page, "sendDrawOps", [[duplicateOp]])).toEqual({
      ok: true,
    });
    expect(await frontendServiceCall(artists[0]!.page, "sendDrawOps", [[duplicateOp]])).toEqual({
      ok: true,
    });

    await expect
      .poll(async () => {
        const view = await currentView(judge.page);
        return (
          view.liveCanvases?.map(
            ({ canvas }) => canvas.actions.filter(({ id }) => id === duplicateOp.id).length,
          ) ?? []
        );
      })
      .toEqual([1, 0]);

    let synchronizedFillHash: string | null = null;
    if (round === 0) {
      const fillId = "parity-fill";
      const mixedHistory = [
        {
          type: "stroke",
          id: "parity-boundary",
          tool: "pen",
          color: "#1f1b16",
          size: 8,
          points: [120, 120, 240, 120, 240, 240, 120, 240, 120, 120],
        },
        { type: "fill", id: fillId, x: 180, y: 180, color: "#0090ff" },
        { type: "clear", id: "parity-clear" },
        { type: "undo", id: "parity-undo" },
      ];
      expect(await frontendServiceCall(artists[0]!.page, "sendDrawOps", [mixedHistory])).toEqual({
        ok: true,
      });

      await expect
        .poll(
          async () => {
            const artistCanvas = (await currentView(artists[0]!.page)).myCanvas?.canvas;
            const judgeCanvas = (await currentView(judge.page)).liveCanvases?.find(({ canvas }) =>
              canvas.actions.some(({ id }) => id === fillId),
            )?.canvas;
            return artistCanvas && judgeCanvas
              ? JSON.stringify(artistCanvas) === JSON.stringify(judgeCanvas)
              : false;
          },
          { message: "Artist and Judge did not converge on the same ordered fill snapshot." },
        )
        .toBe(true);
      const artistSnapshot = (await currentView(artists[0]!.page)).myCanvas?.canvas;
      const judgeSnapshot = (await currentView(judge.page)).liveCanvases?.find(({ canvas }) =>
        canvas.actions.some(({ id }) => id === fillId),
      )?.canvas;
      if (!artistSnapshot || !judgeSnapshot) {
        throw new Error("Artist and Judge did not receive the synchronized fill snapshot.");
      }
      expect(artistSnapshot.actions.map(({ type }) => type).slice(-2)).toEqual(["stroke", "fill"]);
      expect(artistSnapshot.resets).toBeGreaterThan(0);
      expect(judgeSnapshot).toEqual(artistSnapshot);
      const fillLabel = (await currentView(judge.page)).liveCanvases?.find(({ canvas }) =>
        canvas.actions.some(({ id }) => id === fillId),
      )?.label;
      if (!fillLabel) throw new Error("The Judge's synchronized fill label was not found.");
      // These operations intentionally use a second authenticated socket to exercise
      // backend ordering and deduplication. Reload the Artist UI so its local canvas
      // is seeded from that same server-held snapshot before comparing rendered pixels.
      await artists[0]!.page.reload();
      await expect(artists[0]!.page.getByLabel("Your canvas")).toBeVisible();
      await expect(judge.page.getByRole("alertdialog", { name: "Game paused" })).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await renderedCanvasHash(artists[0]!.page.getByLabel("Your canvas"))) ===
            (await renderedCanvasHash(judge.page.getByLabel(`${fillLabel}, live`))),
        )
        .toBe(true);
      const artistHash = await renderedCanvasHash(artists[0]!.page.getByLabel("Your canvas"));
      expect(await renderedCanvasHash(judge.page.getByLabel(`${fillLabel}, live`))).toBe(
        artistHash,
      );
      synchronizedFillHash = artistHash;
    }

    const privateArtistView = await currentView(artists[1]!.page);
    expect(privateArtistView.liveCanvases).toBeNull();
    expect(privateArtistView.gallery).toBeNull();

    if (round === 0) {
      const beforeReload = (await currentView(artists[0]!.page)).myCanvas?.canvas;
      expect(beforeReload?.rev).toBeGreaterThan(0);
      expect(beforeReload?.actions.filter(({ id }) => id === duplicateOp.id)).toHaveLength(1);
      expect(beforeReload?.actions.filter(({ id }) => id === "parity-fill")).toHaveLength(1);
      await artists[0]!.page.reload();
      await expect(artists[0]!.page.getByLabel("Your canvas")).toBeVisible();
      await expect(judge.page.getByRole("alertdialog", { name: "Game paused" })).toHaveCount(0);
      await expect
        .poll(async () => {
          const restored = (await currentView(artists[0]!.page)).myCanvas?.canvas;
          return {
            revisionPreserved: (restored?.rev ?? -1) >= (beforeReload?.rev ?? 0),
            synchronizedActionCopies:
              restored?.actions.filter(({ id }) => id === duplicateOp.id).length ?? 0,
          };
        })
        .toEqual({ revisionPreserved: true, synchronizedActionCopies: 1 });
      const restoredSnapshot = (await currentView(artists[0]!.page)).myCanvas?.canvas;
      if (!restoredSnapshot || !synchronizedFillHash) {
        throw new Error("The synchronized fill snapshot was not restored after reconnect.");
      }
      expect(await renderedCanvasHash(artists[0]!.page.getByLabel("Your canvas"))).toBe(
        synchronizedFillHash,
      );
    }

    await Promise.all(
      artists.map((artist) => artist.page.getByRole("button", { name: "Submit early" }).click()),
    );

    await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
    await expect(judge.page.getByText("0 of 2 rated")).toBeVisible();
    const judgingView = await currentView(judge.page);
    expect(judgingView.liveCanvases?.every(({ locked }) => locked)).toBe(true);
    expect(judgingView.gallery?.map(({ label }) => label)).toEqual(["Drawing 1", "Drawing 2"]);
    expect(
      judgingView.players.filter(({ name }) => name.startsWith("Anonymous player")),
    ).toHaveLength(2);
    for (const artist of artists) {
      await expect(
        artist.page.getByText("Drawings are anonymous until the scores are locked in."),
      ).toBeVisible();
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

    const duplicateRatings = await frontendServiceCall(judge.page, "submitRatings", [
      {
        "Drawing 1": 80,
        "Drawing 2": 60,
      },
    ]);
    expect(duplicateRatings).toEqual({ ok: true });
  }

  await expect(host!.page.getByText("3 rounds · 1 cycle")).toBeVisible({ timeout: 20_000 });
  await expect(host!.page.getByRole("button", { name: "Play again" })).toBeVisible();
  for (const player of players)
    await expect(player.page.getByText(/wins!|Co-winners!/)).toBeVisible();
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

  const newcomer = await playerPool.create("Nova Newcomer");
  players.push(newcomer);
  await joinRoom(newcomer, code);
  await expect(host!.page.getByText("4 rounds ·", { exact: false })).toBeVisible();
  await host!.page.getByRole("button", { name: "Start match" }).click();
  await expect(host!.page.getByText("Round 1 of 4")).toBeVisible();
  await expect(host!.page.getByText("Artist: Nova Newcomer")).toBeVisible();
  const rematchView = await currentView(host!.page);
  expect(rematchView.match?.order).toHaveLength(4);
  expect(Object.values(rematchView.match?.scores ?? {})).toEqual([0, 0, 0, 0]);
});

test("a required browser timing out cancels the incomplete match without a winner", async ({
  players: playerPool,
}) => {
  const players = await Promise.all([
    playerPool.create("Timeout Host"),
    playerPool.create("Returning Artist"),
    playerPool.create("Missing Artist"),
  ]);
  const [host, returning, missing] = players;

  const code = await createRoom(host!);
  await joinRoom(returning!, code);
  await joinRoom(missing!, code);
  await host!.page.getByRole("button", { name: "Start match" }).click();
  await expect(host!.page.getByRole("heading", { name: "Pick the word" })).toBeVisible();
  await host!.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();
  await expect(missing!.page.getByLabel("Your canvas")).toBeVisible();

  await missing!.context.close();
  await expect(host!.page.getByRole("alertdialog", { name: "Game paused" })).toBeVisible();
  await expect(host!.page.getByRole("heading", { name: "Players" })).toBeVisible({
    timeout: 35_000,
  });
  await expect(
    host!.page.getByRole("status").filter({ hasText: /match was canceled/i }),
  ).toContainText("No winner was declared");
  await expect(host!.page.getByText(/wins!|Co-winners!/)).toHaveCount(0);
  await expect(returning!.page.getByRole("heading", { name: "Players" })).toBeVisible();
});
