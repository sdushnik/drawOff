import { expect, test } from "./fixtures";
import { canvasInkPixelCount, drawCanvasStroke } from "./canvas-helpers";
import { createRoom, joinRoom } from "./room-helpers";

test("an Artist's muted drawing countdown persists after reload", async ({ players }) => {
  const host = await players.create("Harper Host");
  const mutedArtist = await players.create("Arlo Artist");
  const otherArtist = await players.create("Jules Artist");
  const code = await createRoom(host);

  await joinRoom(mutedArtist, code);
  await joinRoom(otherArtist, code);
  await host.page.getByRole("button", { name: "Start match" }).click();
  await expect(host.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  const suggestion = host.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first();
  const prompt = (await suggestion.textContent())?.trim();
  if (!prompt) throw new Error("The Judge did not receive a prompt suggestion.");
  await suggestion.click();

  for (const player of [host, mutedArtist, otherArtist]) {
    await expect(player.page.getByRole("timer")).toBeVisible();
  }
  await expect
    .poll(async () => {
      const seconds = await Promise.all(
        [host, mutedArtist, otherArtist].map(async ({ page }) =>
          countdownSeconds((await page.getByRole("timer").textContent()) ?? ""),
        ),
      );
      return Math.max(...seconds) - Math.min(...seconds);
    })
    .toBeLessThanOrEqual(1);

  const mute = mutedArtist.page.getByRole("button", { name: "Mute countdown sound" });
  await expect(mute).toBeVisible();
  await mute.click();
  await expect(
    mutedArtist.page.getByRole("button", { name: "Enable countdown sound" }),
  ).toBeVisible();
  await expect(mutedArtist.page.getByLabel("Your canvas")).toBeVisible();
  await expect(host.page.getByLabel(/Drawing [12], live/)).toHaveCount(2);
  await expect(otherArtist.page.getByLabel("Your canvas")).toBeVisible();

  await drawCanvasStroke(mutedArtist.page);
  const inkBeforeReload = await canvasInkPixelCount(mutedArtist.page.getByLabel("Your canvas"));
  expect(inkBeforeReload).toBeGreaterThan(0);
  const countdownBeforeReload = countdownSeconds(
    (await mutedArtist.page.getByRole("timer").textContent()) ?? "",
  );

  await mutedArtist.page.reload();
  await expect(mutedArtist.page.getByText(prompt, { exact: true }).first()).toBeVisible();
  await expect(mutedArtist.page.getByLabel("Your canvas")).toBeVisible();
  await expect(
    mutedArtist.page.getByRole("button", { name: "Enable countdown sound" }),
  ).toBeVisible();
  await expect
    .poll(() => canvasInkPixelCount(mutedArtist.page.getByLabel("Your canvas")))
    .toBeGreaterThanOrEqual(Math.floor(inkBeforeReload * 0.95));
  const inkAfterReload = await canvasInkPixelCount(mutedArtist.page.getByLabel("Your canvas"));
  expect(inkAfterReload).toBeLessThanOrEqual(Math.ceil(inkBeforeReload * 1.05));

  const countdownAfterReload = countdownSeconds(
    (await mutedArtist.page.getByRole("timer").textContent()) ?? "",
  );
  expect(countdownAfterReload).toBeGreaterThan(0);
  expect(countdownAfterReload).toBeLessThanOrEqual(countdownBeforeReload);
  await expect(host.page.getByLabel(/Drawing [12], live/)).toHaveCount(2);
  await expect(otherArtist.page.getByLabel("Your canvas")).toBeVisible();
});

function countdownSeconds(label: string): number {
  const match = label.trim().match(/^(\d+):(\d{2})$/);
  if (!match) throw new Error(`Unexpected countdown label: ${label}`);
  return Number(match[1]) * 60 + Number(match[2]);
}
