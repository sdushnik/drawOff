import { canvasInkPixelCount, drawCanvasStroke } from "./canvas-helpers";
import { expect, test } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";

test("an Artist visibly draws and edits with the core desktop tools", async ({ players }) => {
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
  const suggestion = judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first();
  const prompt = (await suggestion.textContent())?.trim();
  if (!prompt) throw new Error("The Judge did not receive a prompt suggestion.");
  await suggestion.click();

  await expect(artist.page.getByText(prompt, { exact: true }).first()).toBeVisible();
  const canvas = artist.page.getByLabel("Your canvas");
  await expect(canvas).toBeVisible();
  await expect(artist.page.getByRole("button", { name: "Pen" })).toBeVisible();
  await expect(artist.page.getByRole("button", { name: "Eraser" })).toBeVisible();
  await expect(artist.page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(artist.page.getByRole("button", { name: "Clear" })).toBeVisible();
  await expect(artist.page.getByRole("group", { name: "Colors" })).toBeVisible();
  await expect(artist.page.getByRole("group", { name: "Brush size" })).toBeVisible();
  await expect(judge.page.getByLabel(/Drawing [12], live/)).toHaveCount(2);
  await expect(judge.page.getByRole("group", { name: "Tools" })).toHaveCount(0);

  await expect.poll(() => canvasInkPixelCount(canvas)).toBe(0);
  const pen = artist.page.getByRole("button", { name: "Pen" });
  const blue = artist.page.getByRole("button", { name: "Color #0090ff" });
  const largeBrush = artist.page.getByRole("button", { name: "Brush 32px" });
  await blue.click();
  await largeBrush.click();
  await expect(pen).toHaveAttribute("aria-pressed", "true");
  await expect(blue).toHaveAttribute("aria-pressed", "true");
  await expect(largeBrush).toHaveAttribute("aria-pressed", "true");
  await drawCanvasStroke(artist.page, [0.18, 0.3], [0.7, 0.55]);
  await expect.poll(() => canvasInkPixelCount(canvas)).toBeGreaterThan(1_000);
  const penInk = await canvasInkPixelCount(canvas);

  const eraser = artist.page.getByRole("button", { name: "Eraser" });
  await eraser.click();
  await expect(eraser).toHaveAttribute("aria-pressed", "true");
  await drawCanvasStroke(artist.page, [0.4, 0.4], [0.53, 0.47]);
  await expect.poll(() => canvasInkPixelCount(canvas)).toBeLessThan(penInk - 100);

  await artist.page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => Math.abs((await canvasInkPixelCount(canvas)) - penInk) / penInk)
    .toBeLessThan(0.01);

  await artist.page.getByRole("button", { name: "Clear" }).click();
  await expect.poll(() => canvasInkPixelCount(canvas)).toBe(0);
});
