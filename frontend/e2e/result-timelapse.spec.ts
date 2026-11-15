/**
 * E2E: on-demand result timelapse and motion-aware reveal progress (#48).
 */
import {
  canvasInkPixelCount,
  canvasPixel,
  clickCanvas,
  drawCanvasStroke,
  renderedCanvasHash,
} from "./canvas-helpers";
import { expect, test } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, storedSession } from "./service-helpers";

test("result timelapse replays retained history while reduced motion skips reveal delays", async ({
  players,
}) => {
  const judge = await players.create("Harper Judge");
  const mixedArtist = await players.create("Arlo Artist");
  const reducedArtist = await players.create("Jules Artist");
  await reducedArtist.page.emulateMedia({ reducedMotion: "reduce" });

  const code = await createRoom(judge);
  await joinRoom(mixedArtist, code);
  await joinRoom(reducedArtist, code);
  await judge.page.getByRole("button", { name: "Start match" }).click();
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  await judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();

  await expect(mixedArtist.page.getByLabel("Your canvas")).toBeVisible();
  await expect(reducedArtist.page.getByLabel("Your canvas")).toBeVisible();

  await drawCanvasStroke(mixedArtist.page, [0.1, 0.15], [0.4, 0.35]);
  await mixedArtist.page.getByRole("button", { name: "Bucket fill" }).click();
  await mixedArtist.page.getByRole("button", { name: "Color #0090ff" }).click();
  await clickCanvas(mixedArtist.page, [0.8, 0.8]);
  await clickCanvas(mixedArtist.page, [0.85, 0.85]);
  await clickCanvas(mixedArtist.page, [0.9, 0.9]);
  await mixedArtist.page.getByRole("button", { name: "Clear" }).click();
  await mixedArtist.page.getByRole("button", { name: "Pen" }).click();
  await mixedArtist.page.getByRole("button", { name: "Color #46a758" }).click();
  await drawCanvasStroke(mixedArtist.page, [0.55, 0.55], [0.75, 0.7]);
  await expect
    .poll(async () =>
      (await currentView(mixedArtist.page)).myCanvas?.canvas.actions.map(({ type }) => type),
    )
    .toEqual(["stroke", "fill", "fill", "fill", "clear", "stroke"]);
  await mixedArtist.page.getByRole("button", { name: "Bucket fill" }).click();
  await mixedArtist.page.getByRole("button", { name: "Color #f76b15" }).click();
  await clickCanvas(mixedArtist.page, [0.9, 0.9]);
  await expect
    .poll(async () => (await currentView(mixedArtist.page)).myCanvas?.canvas.actions.length)
    .toBe(7);
  await mixedArtist.page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => {
      const canvas = (await currentView(mixedArtist.page)).myCanvas?.canvas;
      return { actionTypes: canvas?.actions.map(({ type }) => type), resets: canvas?.resets };
    })
    .toEqual({
      actionTypes: ["stroke", "fill", "fill", "fill", "clear", "stroke"],
      resets: 1,
    });

  await drawCanvasStroke(reducedArtist.page, [0.6, 0.15], [0.85, 0.3]);
  await Promise.all(
    [mixedArtist, reducedArtist].map(({ page }) =>
      page.getByRole("button", { name: "Submit early" }).click(),
    ),
  );

  await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
  const judgingView = await currentView(judge.page);
  const mixedGalleryEntry = judgingView.gallery?.find(({ canvas }) => canvas.resets === 1);
  if (!mixedGalleryEntry) throw new Error("The mixed undo history did not reach judging.");
  expect(mixedGalleryEntry.canvas.actions.map(({ type }) => type)).toEqual([
    "stroke",
    "fill",
    "fill",
    "fill",
    "clear",
    "stroke",
  ]);
  const otherLabel = judgingView.gallery?.find(
    ({ label }) => label !== mixedGalleryEntry.label,
  )?.label;
  if (!otherLabel) throw new Error("The control drawing did not reach judging.");

  await judge.page
    .getByRole("spinbutton", { name: `${mixedGalleryEntry.label} rating` })
    .fill("90");
  await judge.page.getByRole("spinbutton", { name: `${otherLabel} rating` }).fill("70");
  await judge.page.getByRole("button", { name: "Submit all ratings" }).click();

  await expect(judge.page.getByLabel(`${mixedArtist.name}'s drawing`)).toBeVisible();
  await expect(judge.page.getByRole("button", { name: "Play timelapse" })).toHaveCount(1);
  await expect(judge.page.getByText("Revealing results…")).toBeVisible();
  await expect(judge.page.getByText(/Top drawing:/)).toHaveCount(0);
  await expect(judge.page.getByRole("heading", { name: "Leaderboard" })).toHaveCount(0);

  await expect(reducedArtist.page.getByRole("button", { name: "Play timelapse" })).toHaveCount(2);
  await expect(reducedArtist.page.getByText(/Top drawing:/)).toContainText(mixedArtist.name);
  await expect(reducedArtist.page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await expect(
    reducedArtist.page
      .getByLabel(`${mixedArtist.name}'s drawing`)
      .locator("../..")
      .getByText("+90"),
  ).toBeVisible();
  await expect(
    reducedArtist.page
      .getByLabel(`${reducedArtist.name}'s drawing`)
      .locator("../..")
      .getByText("+70"),
  ).toBeVisible();

  const mixedCanvas = reducedArtist.page.getByLabel(`${mixedArtist.name}'s drawing`);
  const controlCanvas = reducedArtist.page.getByLabel(`${reducedArtist.name}'s drawing`);
  const mixedCard = mixedCanvas.locator("../..");
  const finalHash = await renderedCanvasHash(mixedCanvas);
  const finalInk = await canvasInkPixelCount(mixedCanvas);
  const controlHash = await renderedCanvasHash(controlCanvas);
  const beforePlayback = await currentView(reducedArtist.page);
  const beforeResult = structuredClone(beforePlayback.roundResult);
  const beforeScores = structuredClone(beforePlayback.match?.scores);

  await reducedArtist.page.waitForTimeout(400);
  expect(await renderedCanvasHash(mixedCanvas)).toBe(finalHash);
  await mixedCard.getByRole("button", { name: "Play timelapse" }).click();
  await expect(mixedCard.getByRole("button", { name: "Playing timelapse…" })).toBeDisabled();
  await expect.poll(() => canvasInkPixelCount(mixedCanvas)).toBeLessThan(finalInk / 2);
  await expect
    .poll(() => canvasPixel(mixedCanvas, [0.95, 0.95]), {
      timeout: 5_000,
      intervals: [25],
    })
    .toEqual([0, 144, 255, 255]);
  await expect.poll(() => renderedCanvasHash(mixedCanvas), { timeout: 7_000 }).toBe(finalHash);
  await expect(mixedCard.getByRole("button", { name: "Play timelapse" })).toBeEnabled();

  expect(await renderedCanvasHash(controlCanvas)).toBe(controlHash);
  const afterPlayback = await currentView(reducedArtist.page);
  const mixedArtistId = (await storedSession(mixedArtist.page)).playerId;
  expect(afterPlayback.roundResult).toEqual(beforeResult);
  expect(afterPlayback.match?.scores).toEqual(beforeScores);
  expect(
    afterPlayback.roundResult?.entries.find(({ artistId }) => artistId === mixedArtistId)?.canvas,
  ).toEqual(mixedGalleryEntry.canvas);

  await expect(judge.page.getByRole("button", { name: "Play timelapse" })).toHaveCount(2);
  await expect(judge.page.getByText(/Top drawing:/)).toContainText(mixedArtist.name);
  await expect(judge.page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await judge.page.reload();
  await expect(judge.page.getByText(/Top drawing:/)).toContainText(mixedArtist.name);
  await expect(judge.page.getByText("Revealing results…")).toHaveCount(0);
  await expect(judge.page.getByRole("button", { name: "Play timelapse" })).toHaveCount(2);
});
