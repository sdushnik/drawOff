import type { Page } from "@playwright/test";
import type { PlayerView } from "@drawoff/contracts";
import { createSocketGameService } from "../src/services/socketGameService";
import { drawCanvasStroke } from "./canvas-helpers";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { frontendServiceCall, serverUrl, storedSession } from "./service-helpers";

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

async function expectVisibleRoleReveal(
  players: Player[],
  judge: Player,
  roundIndex: number,
): Promise<void> {
  const artists = players.filter((player) => player !== judge);

  await Promise.all(
    players.map(async (player) => {
      await expect(
        player.page.getByText(`Round ${roundIndex + 1} of 3 · Cycle 1`, { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      const roles = player.page.getByRole("list", { name: "Round roles" });
      await expect(roles).toContainText(`Judge: ${judge.name}`);
      for (const artist of artists) await expect(roles).toContainText(`Artist: ${artist.name}`);
      await expect(player.page.getByText(/spectator|idle/i)).toHaveCount(0);
    }),
  );

  await expect(judge.page.getByRole("heading", { name: "You're the Judge" })).toBeVisible();
  for (const artist of artists) {
    await expect(artist.page.getByRole("heading", { name: "You're an Artist" })).toBeVisible();
  }
}

test("three players visibly rotate Judge once across a complete cycle", async ({
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

    await expectVisibleRoleReveal(players, judge, round);
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
        await drawCanvasStroke(artist.page);
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
