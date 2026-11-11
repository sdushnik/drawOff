import { expect, test } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";

test("the Judge selects one normalized custom prompt for every player", async ({ players }) => {
  const host = await players.create("Harper Host");
  const firstArtist = await players.create("Arlo Artist");
  const secondArtist = await players.create("Jules Artist");
  const code = await createRoom(host);

  await joinRoom(firstArtist, code);
  await joinRoom(secondArtist, code);
  await host.page.getByRole("button", { name: "Start match" }).click();

  await expect(host.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  const suggestions = host.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button");
  await expect(suggestions).toHaveCount(3);
  const suggestionLabels = (await suggestions.allTextContents()).map((label) => label.trim());
  expect(new Set(suggestionLabels).size).toBe(3);
  await expect(host.page.getByRole("form", { name: "Custom prompt" })).toBeVisible();
  await expect(host.page.getByRole("textbox", { name: "…or write your own" })).toBeVisible();

  for (const artist of [firstArtist, secondArtist]) {
    await expect(
      artist.page.getByRole("heading", { name: `${host.name} is picking a word…` }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      artist.page.getByText(/Waiting for the Judge to confirm the prompt/),
    ).toBeVisible();
    await expect(artist.page.getByRole("group", { name: "Prompt suggestions" })).toHaveCount(0);
    await expect(artist.page.getByRole("form", { name: "Custom prompt" })).toHaveCount(0);
  }

  const normalizedPrompt = "very sleepy dragon";
  await host.page
    .getByRole("textbox", { name: "…or write your own" })
    .fill("  very   sleepy   dragon  ");
  await host.page.getByRole("button", { name: "Use it" }).click();

  await expect(host.page.getByText(normalizedPrompt, { exact: true })).toBeVisible();
  await expect(host.page.getByLabel(/Drawing [12], live/)).toHaveCount(2);
  await expect(host.page.getByLabel("Your canvas")).toHaveCount(0);
  for (const artist of [firstArtist, secondArtist]) {
    await expect(artist.page.getByText(normalizedPrompt, { exact: true })).toBeVisible();
    await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
    await expect(artist.page.getByLabel(/Drawing [12], live/)).toHaveCount(0);
  }
});
