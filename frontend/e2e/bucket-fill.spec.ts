import {
  canvasInkPixelCount,
  canvasPixel,
  clickCanvas,
  drawCanvasStroke,
  renderedCanvasHash,
} from "./canvas-helpers";
import { expect, test } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";

test("an Artist's bounded Bucket Fill appears live for the Judge", async ({ players }) => {
  const judge = await players.create("Harper Judge");
  const artist = await players.create("Arlo Artist");
  const otherArtist = await players.create("Jules Artist");
  const code = await createRoom(judge);

  await joinRoom(artist, code);
  await joinRoom(otherArtist, code);
  await judge.page.getByRole("button", { name: "Start match" }).click();
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  await judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();

  const canvas = artist.page.getByLabel("Your canvas");
  const otherCanvas = otherArtist.page.getByLabel("Your canvas");
  await expect(canvas).toBeVisible();
  await expect(otherCanvas).toBeVisible();
  const untouchedHash = await renderedCanvasHash(otherCanvas);

  await artist.page.getByRole("button", { name: "Brush 16px" }).click();
  await drawCanvasStroke(artist.page, [0.25, 0.25], [0.55, 0.25]);
  await drawCanvasStroke(artist.page, [0.55, 0.25], [0.55, 0.6]);
  await drawCanvasStroke(artist.page, [0.55, 0.6], [0.25, 0.6]);
  await drawCanvasStroke(artist.page, [0.25, 0.6], [0.25, 0.25]);
  const boundaryInk = await canvasInkPixelCount(canvas);

  const fill = artist.page.getByRole("button", { name: "Bucket fill" });
  const blue = artist.page.getByRole("button", { name: "Color #0090ff" });
  await fill.click();
  await blue.click();
  await expect(fill).toHaveAttribute("aria-pressed", "true");
  await expect(blue).toHaveAttribute("aria-pressed", "true");
  await clickCanvas(artist.page, [0.4, 0.42]);

  await expect.poll(() => canvasInkPixelCount(canvas)).toBeGreaterThan(boundaryInk + 10_000);
  await expect.poll(() => canvasPixel(canvas, [0.4, 0.42])).toEqual([0, 144, 255, 255]);
  await expect.poll(() => canvasPixel(canvas, [0.75, 0.75])).toEqual([255, 255, 255, 255]);

  const filledInk = await canvasInkPixelCount(canvas);
  await expect
    .poll(async () => {
      const judgeCanvases = [1, 2].map((number) =>
        judge.page.getByLabel(`Drawing ${number}, live`),
      );
      const matching = await Promise.all(
        judgeCanvases.map(async (judgeCanvas) => {
          const [interior, exterior, ink] = await Promise.all([
            canvasPixel(judgeCanvas, [0.4, 0.42]),
            canvasPixel(judgeCanvas, [0.75, 0.75]),
            canvasInkPixelCount(judgeCanvas),
          ]);
          return (
            interior.join(",") === "0,144,255,255" &&
            exterior.join(",") === "255,255,255,255" &&
            Math.abs(ink - filledInk) / filledInk < 0.01
          );
        }),
      );
      return matching.filter(Boolean).length;
    })
    .toBe(1);

  await expect.poll(() => renderedCanvasHash(otherCanvas)).toBe(untouchedHash);
  await expect(otherArtist.page.getByLabel(/Drawing [12], live/)).toHaveCount(0);
  await expect(otherArtist.page.getByLabel("Your canvas")).toBeVisible();
});
