import type { Player } from "./fixtures";
import { expect, test } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, frontendServiceCall } from "./service-helpers";

test("participants send ephemeral allowlisted emoji reactions with accessible announcements during round and final results without leaking across rooms", async ({
  players: playerPool,
}) => {
  const [hostA, guestA1, guestA2] = (await Promise.all([
    playerPool.create("Host Alpha"),
    playerPool.create("Guest One"),
    playerPool.create("Guest Two"),
  ])) as [Player, Player, Player];

  const hostB = (await playerPool.create("Host Beta")) as Player;
  const codeB = await createRoom(hostB);
  expect(codeB).toBeDefined();

  const codeA = await createRoom(hostA);
  await joinRoom(guestA1, codeA);
  await joinRoom(guestA2, codeA);

  for (const player of [hostA, guestA1, guestA2]) {
    await expect(player.page.getByRole("group", { name: "Send a reaction" })).toHaveCount(0);
  }

  await hostA.page.getByRole("button", { name: "Start match" }).click();

  await expect(hostA.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(hostA.page.getByRole("group", { name: "Send a reaction" })).toHaveCount(0);

  await hostA.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();

  await expect(guestA1.page.getByLabel("Your canvas")).toBeVisible();
  await expect(guestA1.page.getByRole("group", { name: "Send a reaction" })).toHaveCount(0);

  const wrongPhaseSend = await frontendServiceCall(guestA1.page, "sendReaction", ["🔥"]);
  expect(wrongPhaseSend).toMatchObject({ ok: false, code: "WRONG_PHASE" });

  await Promise.all([
    guestA1.page.getByRole("button", { name: "Submit early" }).click(),
    guestA2.page.getByRole("button", { name: "Submit early" }).click(),
  ]);

  await expect(hostA.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
  await expect(hostA.page.getByRole("group", { name: "Send a reaction" })).toHaveCount(0);

  await hostA.page.getByRole("spinbutton", { name: "Drawing 1 rating" }).fill("80");
  await hostA.page.getByRole("spinbutton", { name: "Drawing 2 rating" }).fill("60");
  await hostA.page.getByRole("button", { name: "Submit all ratings" }).click();

  await expect(hostA.page.getByRole("group", { name: "Send a reaction" })).toBeVisible();
  for (const player of [hostA, guestA1, guestA2]) {
    await expect(player.page.getByRole("group", { name: "Send a reaction" })).toBeVisible();
    for (const name of ["Applause", "Laugh", "Fire", "Love", "Wow", "Art"]) {
      await expect(player.page.getByRole("button", { name: `React with ${name}` })).toBeVisible();
    }
  }

  const fireButton = guestA1.page.getByRole("button", { name: "React with Fire" });
  await fireButton.click();
  await expect(fireButton).toBeDisabled();

  for (const player of [hostA, guestA1, guestA2]) {
    await expect(
      player.page.getByRole("status").filter({ hasText: `${guestA1.name} reacted 🔥` }),
    ).toBeVisible();
    await expect(
      player.page.locator("section[aria-label='Emoji reactions'] span.sticker-sm"),
    ).toContainText(guestA1.name);
  }

  await expect(hostB.page.getByRole("status").filter({ hasText: /reacted/ })).toHaveCount(0);
  await expect(hostB.page.locator("section[aria-label='Emoji reactions']")).toHaveCount(0);

  const invalidEmojiSend = await frontendServiceCall(guestA1.page, "sendReaction", ["💩" as any]);
  expect(invalidEmojiSend).toMatchObject({ ok: false, code: "INVALID_INPUT" });

  for (const player of [hostA, guestA1, guestA2]) {
    await expect(
      player.page.locator("section[aria-label='Emoji reactions'] span.sticker-sm"),
    ).toHaveCount(0, { timeout: 6_000 });
  }

  const matchPlayers = [hostA, guestA1, guestA2];
  for (let round = 1; round < 3; round++) {
    const judge = matchPlayers[round]!;
    const artists = matchPlayers.filter((p) => p !== judge);

    await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
      timeout: 20_000,
    });
    await judge.page
      .getByRole("group", { name: "Prompt suggestions" })
      .getByRole("button")
      .first()
      .click();

    await Promise.all(
      artists.map(async (artist) => {
        await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
        await artist.page.getByRole("button", { name: "Submit early" }).click();
      }),
    );

    await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
    await judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" }).fill("70");
    await judge.page.getByRole("spinbutton", { name: "Drawing 2 rating" }).fill("70");
    await judge.page.getByRole("button", { name: "Submit all ratings" }).click();
    await expect(judge.page.getByText(/Top drawing:/)).toBeVisible();
  }

  await expect
    .poll(async () => (await currentView(hostA.page)).phase, { timeout: 20_000 })
    .toBe("FINAL_RESULT");
  await expect(hostA.page.getByText("3 rounds · 1 cycle")).toBeVisible();

  await expect(hostA.page.getByRole("group", { name: "Send a reaction" })).toBeVisible();
  await hostA.page.getByRole("button", { name: "React with Art" }).click();

  for (const player of [hostA, guestA1, guestA2]) {
    await expect(
      player.page.getByRole("status").filter({ hasText: `${hostA.name} reacted 🎨` }),
    ).toBeVisible();
    await expect(
      player.page.locator("section[aria-label='Emoji reactions'] span.sticker-sm"),
    ).toContainText(hostA.name);
  }

  for (const player of [hostA, guestA1, guestA2]) {
    await expect(
      player.page.locator("section[aria-label='Emoji reactions'] span.sticker-sm"),
    ).toHaveCount(0, { timeout: 6_000 });
  }

  await guestA1.page.reload();
  await expect(guestA1.page.getByRole("heading", { name: /wins!|Co-winners!/ })).toBeVisible();
  await expect(
    guestA1.page.locator("section[aria-label='Emoji reactions'] span.sticker-sm"),
  ).toHaveCount(0);
  await expect(guestA1.page.getByRole("group", { name: "Send a reaction" })).toBeVisible();
});
