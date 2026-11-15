import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, frontendServiceCall } from "./service-helpers";

async function startJudging(
  judge: Player,
  artists: Player[],
): Promise<{ prompt: string; labels: string[] }> {
  const code = await createRoom(judge);
  for (const artist of artists) await joinRoom(artist, code);
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
  await expect(judge.page.getByLabel(/Drawing [1-9]\d*, live/)).toHaveCount(artists.length);
  const labels = (await currentView(judge.page)).liveCanvases?.map(({ label }) => label) ?? [];
  expect(labels).toHaveLength(artists.length);

  await Promise.all(
    artists.map(async (artist) => {
      await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
      await artist.page.getByRole("button", { name: "Submit early" }).click();
    }),
  );
  await expect(judge.page.getByRole("spinbutton", { name: `${labels[0]} rating` })).toBeVisible();
  return { prompt, labels };
}

function timerSeconds(label: string): number {
  const match = label.trim().match(/^(\d+):(\d{2})$/);
  if (!match) throw new Error(`Unexpected timer label: ${label}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

test("the anonymous gallery validates every rating and finalizes once", async ({ players }) => {
  const judge = await players.create("Gallery Judge");
  const artists = [await players.create("First Artist"), await players.create("Second Artist")];
  const { prompt, labels } = await startJudging(judge, artists);
  const judging = await currentView(judge.page);

  expect(judging.gallery?.map(({ label }) => label)).toEqual(labels);
  expect(judging.liveCanvases?.map(({ label }) => label)).toEqual(labels);
  expect(judging.deadline! - judging.serverNow).toBeGreaterThan(43_000);
  expect(judging.deadline! - judging.serverNow).toBeLessThanOrEqual(45_000);
  await expect(judge.page.getByText(prompt, { exact: true })).toBeVisible();
  for (const label of labels) {
    await expect(judge.page.getByRole("img", { name: label })).toBeVisible();
    await expect(judge.page.getByRole("slider", { name: `${label} rating slider` })).toBeVisible();
    await expect(judge.page.getByRole("spinbutton", { name: `${label} rating` })).toBeVisible();
  }
  for (const artist of artists) {
    await expect(
      artist.page.getByText("Drawings are anonymous until the scores are locked in."),
    ).toBeVisible();
    await expect(artist.page.getByRole("spinbutton")).toHaveCount(0);
  }

  const firstRating = judge.page.getByRole("spinbutton", { name: `${labels[0]} rating` });
  const submit = judge.page.getByRole("button", { name: "Rate 2 more" });
  await expect(submit).toBeDisabled();
  for (const invalid of ["not a number", "1.5", "-1", "101"]) {
    await firstRating.fill(invalid);
    await expect(firstRating).toHaveAttribute("aria-invalid", "true");
    await expect(judge.page.getByText("Whole number from 0 to 100.")).toBeVisible();
    await expect(judge.page.getByText("0 of 2 rated")).toBeVisible();
    await expect(submit).toBeDisabled();
  }
  await firstRating.fill("");
  await expect(judge.page.getByText("0 of 2 rated")).toBeVisible();

  expect(
    await frontendServiceCall(judge.page, "submitRatings", [
      { [labels[0]!]: "invalid", [labels[1]!]: 50 },
    ]),
  ).toMatchObject({ ok: false, code: "INVALID_INPUT" });

  await firstRating.fill("0");
  await expect(judge.page.getByText("1 of 2 rated")).toBeVisible();
  await expect(judge.page.getByRole("button", { name: "Rate 1 more" })).toBeDisabled();
  await judge.page.getByRole("spinbutton", { name: `${labels[1]} rating` }).fill("100");
  await expect(judge.page.getByText("2 of 2 rated")).toBeVisible();
  const finalSubmit = judge.page.getByRole("button", { name: "Submit all ratings" });
  await expect(finalSubmit).toBeEnabled();

  const timer = judge.page.getByRole("timer");
  await expect
    .poll(async () => timerSeconds((await timer.textContent()) ?? ""), { timeout: 35_000 })
    .toBeLessThanOrEqual(15);
  await expect(timer).toHaveClass(/bg-primary/);

  await finalSubmit.dblclick();
  await expect(judge.page.getByText(/Top drawing:/)).toBeVisible({ timeout: 15_000 });
  const finalized = await currentView(judge.page);
  expect(finalized.roundResult?.entries).toHaveLength(2);
  expect(
    await frontendServiceCall(judge.page, "submitRatings", [
      { [labels[0]!]: 0, [labels[1]!]: 100 },
    ]),
  ).toEqual({ ok: true });
});

test("an incomplete judging timeout warns, then replays the unscored round", async ({
  players,
}) => {
  const judge = await players.create("Timeout Judge");
  const artists = [await players.create("Waiting Artist"), await players.create("Blank Artist")];
  await startJudging(judge, artists);
  const before = await currentView(judge.page);
  const originalJudge = before.match!.judgeId;

  await expect(judge.page.getByRole("alert")).toContainText("Overtime", { timeout: 50_000 });
  const overtime = await currentView(judge.page);
  expect(overtime.phase).toBe("JUDGING");
  expect(overtime.judgingOvertime).toBe(true);
  expect(overtime.deadline! - overtime.serverNow).toBeGreaterThan(13_000);
  expect(overtime.deadline! - overtime.serverNow).toBeLessThanOrEqual(15_000);
  await judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" }).fill("75");
  await expect(judge.page.getByText("1 of 2 rated")).toBeVisible();

  await expect
    .poll(async () => (await currentView(judge.page)).phase, { timeout: 20_000 })
    .toBe("ROLE_REVEAL");
  const replay = await currentView(judge.page);
  expect(replay.match!.roundIndex).toBe(0);
  expect(replay.match!.judgeId).toBe(originalJudge);
  expect(Object.values(replay.match!.scores)).toEqual([0, 0, 0]);
  expect(replay.notice).toMatch(/unscored round is being replayed/i);
  await expect(judge.page.getByRole("status")).toContainText("unscored round is being replayed");
});
