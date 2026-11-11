import type { Page } from "@playwright/test";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { frontendServiceCall, storedSession } from "./service-helpers";

test("host controls synchronize cycles, start gating, and player removal", async ({ players }) => {
  const host = await players.create("Harper Host");
  const firstGuest = await players.create("Arlo Guest");
  const removedGuest = await players.create("Jules Removed");
  const replacement = await players.create("Nova Guest");
  const code = await createRoom(host);

  await expectLobbyLength(host.page, 1, 1);
  await expect(host.page.getByRole("button", { name: "Start match" })).toBeDisabled();
  await expect(host.page.getByText(/2 more to go/)).toBeVisible();

  await joinRoom(firstGuest, code);
  for (const player of [host, firstGuest]) await expectLobbyLength(player.page, 1, 2);
  await expect(host.page.getByRole("button", { name: "Start match" })).toBeDisabled();
  await expect(host.page.getByText(/1 more to go/)).toBeVisible();

  await joinRoom(removedGuest, code);
  await expectThreePlayerLobby(host, [firstGuest, removedGuest]);
  for (const guest of [firstGuest, removedGuest]) {
    await expectLobbyLength(guest.page, 1, 3);
    await expect(
      guest.page.getByText("Waiting for the host to start…", { exact: true }),
    ).toBeVisible();
    await expect(guest.page.getByRole("button", { name: "Start match" })).toHaveCount(0);
    for (const cycles of [1, 2, 3]) {
      await expect(guest.page.getByRole("radio", { name: cycleLabel(cycles) })).toBeDisabled();
    }
    await expect(guest.page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  }

  for (const cycles of [2, 3] as const) {
    await host.page.getByRole("radio", { name: cycleLabel(cycles) }).click();
    for (const player of [host, firstGuest, removedGuest]) {
      await expectLobbyLength(player.page, cycles, 3);
    }
  }

  await host.page.getByRole("button", { name: `Remove ${removedGuest.name}` }).click();
  for (const player of [host, firstGuest]) {
    await expect(
      player.page.getByRole("list", { name: "Players" }).getByRole("listitem"),
    ).toHaveCount(2);
    await expect(player.page.getByText(removedGuest.name, { exact: true })).toHaveCount(0);
    await expectLobbyLength(player.page, 3, 2);
  }
  await expect(removedGuest.page.getByRole("alert")).toHaveText("You're no longer in this room.");
  await expect(removedGuest.page.getByRole("heading", { name: "Players" })).toHaveCount(0);

  await joinRoom(replacement, code);
  const replacementId = (await storedSession(replacement.page)).playerId;
  const before = await lobbySnapshot(host.page);
  expect(await frontendServiceCall(firstGuest.page, "setCycles", [1])).toMatchObject({
    ok: false,
    code: "FORBIDDEN",
  });
  expect(await frontendServiceCall(firstGuest.page, "kickPlayer", [replacementId])).toMatchObject({
    ok: false,
    code: "FORBIDDEN",
  });
  expect(await frontendServiceCall(firstGuest.page, "startMatch")).toMatchObject({
    ok: false,
    code: "FORBIDDEN",
  });
  for (const player of [host, firstGuest, replacement]) {
    await expectLobbyLength(player.page, 3, 3);
    await expect(
      player.page
        .getByRole("list", { name: "Players" })
        .getByRole("listitem")
        .filter({ hasText: replacement.name }),
    ).toHaveCount(1);
  }
  expect(await lobbySnapshot(host.page)).toEqual(before);

  await host.page.getByRole("button", { name: "Start match" }).click();
  await expect(host.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  for (const player of [firstGuest, replacement]) {
    await expect(
      player.page.getByRole("heading", { name: `${host.name} is picking a word…` }),
    ).toBeVisible({ timeout: 15_000 });
  }
  for (const player of [host, firstGuest, replacement]) {
    await expect(player.page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  }
  expect(await frontendServiceCall(host.page, "kickPlayer", [replacementId])).toMatchObject({
    ok: false,
    code: "WRONG_PHASE",
  });
  await expect(
    replacement.page.getByRole("heading", { name: `${host.name} is picking a word…` }),
  ).toBeVisible();
  await expect(replacement.page.getByRole("alert")).toHaveCount(0);
});

async function expectThreePlayerLobby(host: Player, guests: Player[]): Promise<void> {
  await expectLobbyLength(host.page, 1, 3);
  await expect(host.page.getByRole("button", { name: "Start match" })).toBeEnabled();
  await expect(host.page.getByRole("button", { name: `Remove ${guests[0]!.name}` })).toBeVisible();
  await expect(host.page.getByRole("button", { name: `Remove ${guests[1]!.name}` })).toBeVisible();
  await expect(host.page.getByRole("button", { name: `Remove ${host.name}` })).toHaveCount(0);
}

async function expectLobbyLength(page: Page, cycles: 1 | 2 | 3, players: number): Promise<void> {
  await expect(page.getByRole("radio", { name: cycleLabel(cycles) })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByText(new RegExp(`^${players * cycles} rounds ·`))).toContainText(
    "(estimate)",
  );
}

function cycleLabel(cycles: number): string {
  return `${cycles} ${cycles === 1 ? "cycle" : "cycles"}`;
}

async function lobbySnapshot(
  page: Page,
): Promise<{ cycles: string | null; roster: string[]; waiting: boolean }> {
  const roster = page.getByRole("list", { name: "Players" }).getByRole("listitem");
  return {
    cycles: await page.getByRole("radio", { checked: true }).getAttribute("aria-label"),
    roster: await roster.allTextContents(),
    waiting: await page.getByRole("heading", { name: "Players" }).isVisible(),
  };
}
