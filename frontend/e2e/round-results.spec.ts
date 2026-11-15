/**
 * E2E: round-result reveal, direct scoring, cumulative totals, and ties (#47).
 *
 * Exercises the production Compose stack through isolated browser contexts and
 * drives every score through the Judge's visible rating controls.
 */
import type { Page } from "@playwright/test";
import type { PlayerView } from "@drawoff/contracts";
import { drawCanvasStroke } from "./canvas-helpers";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, frontendServiceCall, storedSession } from "./service-helpers";

async function startRound(judge: Player, artists: Player[]): Promise<void> {
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 20_000,
  });
  await judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();
  await Promise.all(
    artists.map((artist) => expect(artist.page.getByLabel("Your canvas")).toBeVisible()),
  );
}

async function submitDrawings(artists: Player[]): Promise<void> {
  await Promise.all(
    artists.map((artist) => artist.page.getByRole("button", { name: "Submit early" }).click()),
  );
}

async function rateDrawings(page: Page, ratings: Record<string, number>): Promise<void> {
  for (const [label, rating] of Object.entries(ratings)) {
    await page.getByRole("spinbutton", { name: `${label} rating` }).fill(String(rating));
  }
  await page.getByRole("button", { name: "Submit all ratings" }).click();
}

async function expectFinalRoundReveal(
  players: Player[],
  entries: NonNullable<PlayerView["roundResult"]>["entries"],
  winnerNames: string[],
  expectedScores: Map<string, number>,
  playerNames: Map<string, string>,
): Promise<void> {
  await Promise.all(
    players.map(async (player) => {
      const topDrawing = player.page.getByText(/Top drawing:/);
      await expect(topDrawing).toBeVisible({ timeout: 10_000 });
      for (const winnerName of winnerNames) await expect(topDrawing).toContainText(winnerName);

      for (const entry of entries) {
        const playerName = playerNames.get(entry.artistId);
        if (!playerName) throw new Error(`Missing revealed Artist ${entry.artistId}.`);
        await expect(player.page.getByLabel(`${playerName}'s drawing`)).toBeVisible();
      }

      const leaderboard = player.page.getByRole("heading", { name: "Leaderboard" }).locator("..");
      for (const [name, score] of expectedScores) {
        await expect(leaderboard.getByRole("listitem").filter({ hasText: name })).toContainText(
          String(score),
        );
      }
      await expect(leaderboard.getByRole("listitem").filter({ hasText: player.name })).toHaveClass(
        /bg-muted/,
      );
    }),
  );
}

test("round results reveal direct scores once, persist across reconnect, and announce ties", async ({
  players: playerPool,
}) => {
  const players = await Promise.all([
    playerPool.create("Harper Host"),
    playerPool.create("Arlo Artist"),
    playerPool.create("Jules Artist"),
    playerPool.create("Mina Artist"),
  ]);
  const [host, arlo, jules, mina] = players as [Player, Player, Player, Player];
  const sessions = new Map<string, Player>();

  const code = await createRoom(host);
  await joinRoom(arlo, code);
  await joinRoom(jules, code);
  await joinRoom(mina, code);
  sessions.clear();
  for (const player of players) sessions.set((await storedSession(player.page)).playerId, player);

  await host.page.getByRole("button", { name: "Start match" }).click();
  await startRound(host, [arlo, jules, mina]);

  await drawCanvasStroke(arlo.page);
  await drawCanvasStroke(jules.page, [0.55, 0.2], [0.8, 0.45]);
  // Mina intentionally submits a blank canvas so its result can be scored zero.
  await submitDrawings([arlo, jules, mina]);

  await expect(host.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
  const judgingView = await currentView(host.page);
  expect(judgingView.gallery).toHaveLength(3);
  const blankLabel = judgingView.gallery!.find(({ canvas }) => canvas.actions.length === 0)?.label;
  if (!blankLabel) throw new Error("The blank submitted drawing was not present in the gallery.");
  const drawnLabels = judgingView
    .gallery!.filter(({ label }) => label !== blankLabel)
    .map(({ label }) => label);
  const firstRatings: Record<string, number> = {
    [drawnLabels[0]!]: 80,
    [drawnLabels[1]!]: 60,
    [blankLabel]: 0,
  };

  for (const artist of [arlo, jules, mina]) {
    await expect(host.page.getByText(artist.name, { exact: true })).toHaveCount(0);
    await expect(
      artist.page.getByText("Drawings are anonymous until the scores are locked in."),
    ).toBeVisible();
    await expect(artist.page.getByLabel(/^Drawing \d+$/)).toHaveCount(0);
  }

  await rateDrawings(host.page, firstRatings);
  await expect.poll(async () => (await currentView(host.page)).phase).toBe("ROUND_RESULT");
  const firstResultView = await currentView(host.page);
  const firstResult = firstResultView.roundResult!;
  expect(
    Object.fromEntries(firstResult.entries.map(({ label, rating }) => [label, rating])),
  ).toEqual(firstRatings);
  expect(
    firstResult.entries.find(({ label }) => label === blankLabel)?.canvas.actions,
  ).toHaveLength(0);
  expect(firstResult.winners).toEqual([
    firstResult.entries.find(({ rating }) => rating === 80)!.artistId,
  ]);
  expect(firstResultView.match!.scores[firstResult.judgeId]).toBe(0);

  const firstScores = new Map<string, number>();
  for (const player of players) {
    const id = (await storedSession(player.page)).playerId;
    firstScores.set(player.name, firstResultView.match!.scores[id] ?? 0);
  }
  expect([...firstScores.values()].sort((a, b) => b - a)).toEqual([80, 60, 0, 0]);

  const duplicate = await frontendServiceCall(host.page, "submitRatings", [firstRatings]);
  expect(duplicate).toEqual({ ok: true });
  await mina.page.reload();
  await expect.poll(async () => (await currentView(mina.page)).phase).toBe("ROUND_RESULT");
  const reconnectedView = await currentView(mina.page);
  expect(reconnectedView.match!.scores).toEqual(firstResultView.match!.scores);
  expect(reconnectedView.roundResult!.winners).toEqual(firstResult.winners);

  const firstWinnerNames = firstResult.winners.map((id) => sessions.get(id)!.name);
  const playerNames = new Map([...sessions].map(([id, player]) => [id, player.name]));
  await expectFinalRoundReveal(
    players,
    firstResult.entries,
    firstWinnerNames,
    firstScores,
    playerNames,
  );

  await startRound(arlo, [host, jules, mina]);
  await submitDrawings([host, jules, mina]);
  await expect(arlo.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
  const secondRatings = { "Drawing 1": 70, "Drawing 2": 70, "Drawing 3": 70 };
  await rateDrawings(arlo.page, secondRatings);
  await expect.poll(async () => (await currentView(arlo.page)).phase).toBe("ROUND_RESULT");
  const secondResultView = await currentView(arlo.page);
  const secondResult = secondResultView.roundResult!;
  expect(secondResult.winners).toHaveLength(3);
  expect(secondResult.winners).toEqual(secondResult.entries.map(({ artistId }) => artistId));
  expect(secondResultView.match!.scores[secondResult.judgeId]).toBe(firstScores.get(arlo.name));

  const cumulativeScores = new Map<string, number>();
  for (const player of players) {
    const id = (await storedSession(player.page)).playerId;
    const expected = (firstScores.get(player.name) ?? 0) + (player === arlo ? 0 : 70);
    expect(secondResultView.match!.scores[id]).toBe(expected);
    cumulativeScores.set(player.name, expected);
  }
  const tiedWinnerNames = secondResult.winners.map((id) => sessions.get(id)!.name);
  await expectFinalRoundReveal(
    players,
    secondResult.entries,
    tiedWinnerNames,
    cumulativeScores,
    playerNames,
  );
});
