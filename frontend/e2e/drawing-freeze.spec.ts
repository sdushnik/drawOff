import type { Locator } from "@playwright/test";
import { expect, test, type Player } from "./fixtures";
import { drawCanvasStroke } from "./canvas-helpers";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, frontendServiceCall } from "./service-helpers";

const LATE_DRAW = { type: "clear", id: "late-draw-after-freeze" } as const;

function readyStatus(player: Player): Locator {
  return player.page.getByRole("status").filter({ hasText: "Artists ready" });
}

async function startDrawing(judge: Player, artists: Player[]): Promise<void> {
  const code = await createRoom(judge);
  for (const artist of artists) await joinRoom(artist, code);
  await judge.page.getByRole("button", { name: "Start match" }).click();
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  await judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();
  await expect(judge.page.getByLabel(/Drawing [12], live/)).toHaveCount(2);
  for (const artist of artists) {
    await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
  }
}

async function expectReadyProgress(players: Player[], progress: string): Promise<void> {
  for (const player of players) {
    const status = readyStatus(player);
    await expect(status).toHaveText(progress);
    for (const other of players) await expect(status).not.toContainText(other.name);
  }
}

async function expectJudging(judge: Player, artists: Player[]): Promise<void> {
  await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
  await expect(judge.page.getByText("0 of 2 rated")).toBeVisible();
  for (const artist of artists) {
    await expect(
      artist.page.getByText("Drawings are anonymous until the scores are locked in."),
    ).toBeVisible();
    await expect(artist.page.getByLabel("Your submitted drawing")).toBeVisible();
  }
}

test("an Artist can reverse ready until the final submission freezes every canvas", async ({
  players,
}) => {
  const judge = await players.create("Harper Judge");
  const firstArtist = await players.create("Arlo Artist");
  const finalArtist = await players.create("Jules Artist");
  const artists = [firstArtist, finalArtist];
  const participants = [judge, ...artists];

  await startDrawing(judge, artists);
  await expectReadyProgress(participants, "0 / 2 Artists ready");

  await drawCanvasStroke(firstArtist.page);
  await expect
    .poll(async () => (await currentView(firstArtist.page)).myCanvas?.canvas.rev ?? 0)
    .toBeGreaterThan(0);
  await firstArtist.page.getByRole("button", { name: "Submit early" }).click();
  await expectReadyProgress(participants, "1 / 2 Artists ready");
  await expect(firstArtist.page.getByRole("button", { name: "Continue drawing" })).toBeEnabled();
  await expect(firstArtist.page.getByRole("button", { name: "Pen" })).toBeDisabled();

  await firstArtist.page.reload();
  await expect(firstArtist.page.getByRole("button", { name: "Continue drawing" })).toBeEnabled();
  await expect(firstArtist.page.getByRole("button", { name: "Pen" })).toBeDisabled();
  await expectReadyProgress(participants, "1 / 2 Artists ready");

  await firstArtist.page.getByRole("button", { name: "Continue drawing" }).click();
  await expectReadyProgress(participants, "0 / 2 Artists ready");
  await expect(firstArtist.page.getByRole("button", { name: "Submit early" })).toBeEnabled();
  await expect(firstArtist.page.getByRole("button", { name: "Pen" })).toBeEnabled();

  await firstArtist.page.getByRole("button", { name: "Submit early" }).click();
  await expectReadyProgress(participants, "1 / 2 Artists ready");
  await drawCanvasStroke(finalArtist.page, [0.2, 0.2], [0.3, 0.3]);
  await finalArtist.page.getByRole("button", { name: "Submit early" }).click();

  await expectJudging(judge, artists);
  const frozen = await currentView(judge.page);
  expect(frozen.liveCanvases?.every(({ locked }) => locked)).toBe(true);
  expect(frozen.gallery?.map(({ label }) => label)).toEqual(["Drawing 1", "Drawing 2"]);
  const frozenGallery = frozen.gallery;

  expect(await frontendServiceCall(finalArtist.page, "submitCanvas")).toMatchObject({
    ok: false,
    code: "WRONG_PHASE",
  });
  expect(await frontendServiceCall(firstArtist.page, "sendDrawOps", [[LATE_DRAW]])).toMatchObject({
    ok: false,
    code: "WRONG_PHASE",
  });
  expect((await currentView(judge.page)).gallery).toEqual(frozenGallery);
});

test("the 75-second deadline freezes submitted and blank canvases", async ({ players }) => {
  const judge = await players.create("Deadline Judge");
  const drawingArtist = await players.create("Drawing Artist");
  const blankArtist = await players.create("Blank Artist");
  const artists = [drawingArtist, blankArtist];

  await startDrawing(judge, artists);
  await drawCanvasStroke(drawingArtist.page);
  await expect
    .poll(async () => (await currentView(drawingArtist.page)).myCanvas?.canvas.rev ?? 0)
    .toBeGreaterThan(0);
  expect((await currentView(blankArtist.page)).myCanvas?.canvas.actions).toHaveLength(0);
  await drawingArtist.page.getByRole("button", { name: "Submit early" }).click();
  await expectReadyProgress([judge, ...artists], "1 / 2 Artists ready");

  await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible({
    timeout: 85_000,
  });
  await expectJudging(judge, artists);
  const frozen = await currentView(judge.page);
  expect(frozen.liveCanvases?.every(({ locked }) => locked)).toBe(true);
  expect(frozen.gallery?.map(({ canvas }) => canvas.actions.length)).toEqual([1, 0]);
  const frozenGallery = frozen.gallery;

  expect(await frontendServiceCall(blankArtist.page, "sendDrawOps", [[LATE_DRAW]])).toMatchObject({
    ok: false,
    code: "WRONG_PHASE",
  });
  expect(await frontendServiceCall(drawingArtist.page, "submitCanvas")).toMatchObject({
    ok: false,
    code: "WRONG_PHASE",
  });
  expect((await currentView(judge.page)).gallery).toEqual(frozenGallery);
});
