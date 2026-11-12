import type { Locator, Page } from "@playwright/test";
import { expect, test, type Player } from "./fixtures";
import { canvasInkPixelCount, drawCanvasStroke, renderedCanvasHash } from "./canvas-helpers";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, frontendServiceCall } from "./service-helpers";

function gridCard(page: Page, label: string): Locator {
  return page.getByRole("button").filter({ has: page.getByLabel(`${label}, live`) });
}

async function synchronizedLabel(judge: Player, artist: Player): Promise<string> {
  await expect
    .poll(async () => (await currentView(artist.page)).myCanvas?.canvas.actions[0]?.id ?? null)
    .not.toBeNull();
  const actionId = (await currentView(artist.page)).myCanvas?.canvas.actions[0]?.id;
  if (!actionId) throw new Error("The Artist's synchronized drawing action was not found.");

  await expect
    .poll(async () => {
      const view = await currentView(judge.page);
      return (
        view.liveCanvases?.find(({ canvas }) => canvas.actions.some(({ id }) => id === actionId))
          ?.label ?? null
      );
    })
    .not.toBeNull();

  const label = (await currentView(judge.page)).liveCanvases?.find(({ canvas }) =>
    canvas.actions.some(({ id }) => id === actionId),
  )?.label;
  if (!label) throw new Error("The Judge did not receive the Artist's synchronized canvas.");
  return label;
}

async function expectSynchronizedRendering(
  judge: Player,
  label: string,
  artist: Player,
): Promise<void> {
  await expect
    .poll(async () => {
      const artistCanvas = (await currentView(artist.page)).myCanvas?.canvas;
      const judgeCanvas = (await currentView(judge.page)).liveCanvases?.find(
        (canvas) => canvas.label === label,
      )?.canvas;
      return artistCanvas && judgeCanvas
        ? JSON.stringify(artistCanvas) === JSON.stringify(judgeCanvas)
        : false;
    })
    .toBe(true);
  await expect
    .poll(() => canvasInkPixelCount(judge.page.getByLabel(`${label}, live`)))
    .toBeGreaterThan(0);
}

test("the Judge switches live anonymous canvases without gaining edit access", async ({
  players,
}) => {
  const judge = await players.create("Harper Judge");
  const firstArtist = await players.create("Arlo Artist");
  const secondArtist = await players.create("Jules Artist");
  const code = await createRoom(judge);
  await joinRoom(firstArtist, code);
  await joinRoom(secondArtist, code);

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
  await expect(judge.page.getByLabel("Your canvas")).toHaveCount(0);
  await expect(judge.page.getByRole("group", { name: "Tools" })).toHaveCount(0);
  await expect(judge.page.getByRole("button", { name: "Submit early" })).toHaveCount(0);
  await expect(judge.page.getByText(firstArtist.name, { exact: true })).toHaveCount(0);
  await expect(judge.page.getByText(secondArtist.name, { exact: true })).toHaveCount(0);

  expect(
    await frontendServiceCall(judge.page, "sendDrawOps", [
      [{ type: "clear", id: "judge-cannot-draw-live-view" }],
    ]),
  ).toMatchObject({ ok: false, code: "FORBIDDEN" });

  await drawCanvasStroke(firstArtist.page, [0.05, 0.08], [0.18, 0.2]);
  await drawCanvasStroke(secondArtist.page, [0.65, 0.65], [0.8, 0.78]);
  const firstLabel = await synchronizedLabel(judge, firstArtist);
  const secondLabel = await synchronizedLabel(judge, secondArtist);
  expect(new Set([firstLabel, secondLabel])).toEqual(new Set(["Drawing 1", "Drawing 2"]));

  await expectSynchronizedRendering(judge, firstLabel, firstArtist);
  await expectSynchronizedRendering(judge, secondLabel, secondArtist);
  await expect(gridCard(judge.page, firstLabel).getByText("LIVE", { exact: true })).toBeVisible();
  await expect(gridCard(judge.page, secondLabel).getByText("LIVE", { exact: true })).toBeVisible();

  await gridCard(judge.page, firstLabel).click();
  await expect(judge.page.getByRole("button", { name: /Grid view/ })).toBeVisible();
  const focusedFirst = judge.page.getByLabel(`${firstLabel}, live`);
  const beforeFocusedUpdate = await renderedCanvasHash(focusedFirst);

  await drawCanvasStroke(firstArtist.page, [0.3, 0.25], [0.48, 0.42]);
  await expect.poll(() => renderedCanvasHash(focusedFirst)).not.toBe(beforeFocusedUpdate);
  await expectSynchronizedRendering(judge, firstLabel, firstArtist);
  expect((await currentView(judge.page)).phase).toBe("DRAWING");

  await judge.page.getByRole("button", { name: secondLabel, exact: true }).click();
  await expectSynchronizedRendering(judge, secondLabel, secondArtist);
  expect((await currentView(judge.page)).phase).toBe("DRAWING");

  await judge.page.getByRole("button", { name: /Grid view/ }).click();
  await expect(judge.page.getByLabel(/Drawing [12], live/)).toHaveCount(2);
  await expectSynchronizedRendering(judge, firstLabel, firstArtist);
  await expectSynchronizedRendering(judge, secondLabel, secondArtist);

  await firstArtist.page.getByRole("button", { name: "Submit early" }).click();
  await expect(gridCard(judge.page, firstLabel).getByText("Done", { exact: true })).toBeVisible();
  await expect(gridCard(judge.page, secondLabel).getByText("LIVE", { exact: true })).toBeVisible();
  await expect(judge.page.getByText(firstArtist.name, { exact: true })).toHaveCount(0);
  await expect(judge.page.getByText(secondArtist.name, { exact: true })).toHaveCount(0);
  expect((await currentView(judge.page)).phase).toBe("DRAWING");
});
