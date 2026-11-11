import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";

test("seven players join and enter a six-canvas live drawing grid", async ({ players }) => {
  const participants = await Promise.all([
    players.create("Harper Host"),
    players.create("Arlo Artist"),
    players.create("Jules Artist"),
    players.create("Nova Artist"),
    players.create("Mika Artist"),
    players.create("Remy Artist"),
    players.create("Sage Artist"),
  ]);
  const [host, ...artists] = participants as [Player, ...Player[]];
  const code = await createRoom(host);

  for (const artist of artists) await joinRoom(artist, code);

  for (const participant of participants) {
    const roster = participant.page.getByRole("list", { name: "Players" }).getByRole("listitem");
    await expect(roster).toHaveCount(7);
    for (const expected of participants) {
      await expect(roster.filter({ hasText: expected.name })).toHaveCount(1);
    }
    await expect(roster.getByText("Host", { exact: true })).toHaveCount(1);
    await expect(roster.getByText("Disconnected", { exact: true })).toHaveCount(0);
    await expect(participant.page.getByText(/spectator/i)).toHaveCount(0);
    await expect(participant.page.getByRole("alert")).toHaveCount(0);
    await expect(participant.page.getByText(/^7 rounds ·/)).toContainText("(estimate)");
  }
  await expect(host.page.getByRole("button", { name: "Start match" })).toBeEnabled();

  await host.page.getByRole("button", { name: "Start match" }).click();
  const startOutcome = await host.page.waitForFunction(
    () => {
      const started = [...document.querySelectorAll("h1, h2, h3")].some(
        ({ textContent }) => textContent?.trim() === "Pick the word",
      );
      if (started) return { kind: "success" };
      const message = document.querySelector('[role="alert"]')?.textContent?.trim();
      return message ? { kind: "error", message } : null;
    },
    undefined,
    { timeout: 15_000 },
  );
  const startResult = (await startOutcome.jsonValue()) as
    { kind: "success" } | { kind: "error"; message: string };
  if (startResult.kind === "error") {
    throw new Error(`Starting the seven-player match failed: ${startResult.message}`);
  }
  await expect(host.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(host.page.getByText("Round 1/7", { exact: true })).toBeVisible();
  await expect(host.page.getByText("Judge", { exact: true })).toBeVisible();
  await expect(host.page.getByRole("heading", { name: "Players" })).toHaveCount(0);

  for (const artist of artists) {
    await expect(
      artist.page.getByRole("heading", { name: `${host.name} is picking a word…` }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(artist.page.getByText("Round 1/7", { exact: true })).toBeVisible();
    await expect(artist.page.getByText("Artist", { exact: true })).toBeVisible();
    await expect(artist.page.getByRole("heading", { name: "Players" })).toHaveCount(0);
    await expect(artist.page.getByText(/spectator|idle/i)).toHaveCount(0);
  }

  const suggestion = host.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first();
  const prompt = (await suggestion.textContent())?.trim();
  if (!prompt) throw new Error("The seven-player Judge did not receive a prompt suggestion.");
  await suggestion.click();

  await expect(host.page.getByLabel(/Drawing [1-6], live/)).toHaveCount(6);
  for (let drawing = 1; drawing <= 6; drawing += 1) {
    await expect(host.page.getByLabel(`Drawing ${drawing}, live`)).toBeVisible();
  }
  await expect(host.page.getByLabel(/Drawing (?:7|[A-B]), live/)).toHaveCount(0);
  await expect(host.page.getByLabel("Your canvas")).toHaveCount(0);
  await expect(host.page.getByRole("group", { name: "Tools" })).toHaveCount(0);

  for (const artist of artists) {
    await expect(artist.page.getByText(prompt, { exact: true }).first()).toBeVisible();
    await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
    await expect(artist.page.getByRole("group", { name: "Tools" })).toBeVisible();
    await expect(artist.page.getByLabel(/Drawing [1-6], live/)).toHaveCount(0);
  }
});
