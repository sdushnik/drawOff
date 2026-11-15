import type { Page } from "@playwright/test";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, frontendServiceCall, storedSession } from "./service-helpers";

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

test("host departure in lobby deterministically promotes the next guest, transfers controls and authorization, and prevents rejoining former host from usurping", async ({
  players,
}) => {
  const host = await players.create("Original Host");
  const firstGuest = await players.create("Next In Line");
  const secondGuest = await players.create("Steady Guest");
  const code = await createRoom(host);

  await joinRoom(firstGuest, code);
  await joinRoom(secondGuest, code);

  // Initial state: Original Host is the host
  await expectThreePlayerLobby(host, [firstGuest, secondGuest]);
  for (const guest of [firstGuest, secondGuest]) {
    await expect(guest.page.getByText("Waiting for the host to start…", { exact: true })).toBeVisible();
    await expect(guest.page.getByRole("button", { name: "Start match" })).toHaveCount(0);
    await expect(guest.page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  }

  // Save the original host's session before leaving
  const originalHostSession = await storedSession(host.page);

  // Original host clicks Leave button in the lobby
  await host.page.getByRole("button", { name: "Leave" }).click();
  await expect(host.page).toHaveURL(new RegExp(`^${new URL(host.page.url()).origin}/$`));

  // Next connected guest (Next In Line) is deterministically promoted to Host
  // Both remaining players see Next In Line as the host
  for (const player of [firstGuest, secondGuest]) {
    await expect(
      player.page.getByRole("list", { name: "Players" }).getByRole("listitem"),
    ).toHaveCount(2);
    const promotedRow = player.page
      .getByRole("list", { name: "Players" })
      .getByRole("listitem")
      .filter({ hasText: firstGuest.name });
    await expect(promotedRow).toBeVisible();
    await expect(promotedRow.getByText("Host", { exact: true })).toBeAttached();
  }

  // Promoted host acquires host controls
  await expect(firstGuest.page.getByRole("button", { name: `Remove ${secondGuest.name}` })).toBeVisible();
  await expect(firstGuest.page.getByRole("button", { name: "Start match" })).toBeDisabled();
  await expect(firstGuest.page.getByText(/1 more to go/)).toBeVisible();

  // Promoted host can change cycles
  await firstGuest.page.getByRole("radio", { name: cycleLabel(2) }).click();
  for (const player of [firstGuest, secondGuest]) {
    await expectLobbyLength(player.page, 2, 2);
  }

  // Second guest remains an ordinary guest
  await expect(secondGuest.page.getByText("Waiting for the host to start…", { exact: true })).toBeVisible();
  await expect(secondGuest.page.getByRole("button", { name: "Start match" })).toHaveCount(0);
  await expect(secondGuest.page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  for (const cycles of [1, 2, 3]) {
    await expect(secondGuest.page.getByRole("radio", { name: cycleLabel(cycles) })).toBeDisabled();
  }

  // Departed host's old session is rejected from performing host actions
  const unauthorizedChange = await frontendServiceCall(
    firstGuest.page,
    "setCycles",
    [3],
    originalHostSession,
  );
  expect(unauthorizedChange.ok).toBe(false);

  const unauthorizedStart = await frontendServiceCall(
    firstGuest.page,
    "startMatch",
    [],
    originalHostSession,
  );
  expect(unauthorizedStart.ok).toBe(false);

  // Former host rejoins the room
  await joinRoom(host, code);

  // Next In Line remains the host; rejoining host does NOT usurp ownership
  for (const player of [host, firstGuest, secondGuest]) {
    await expect(
      player.page.getByRole("list", { name: "Players" }).getByRole("listitem"),
    ).toHaveCount(3);
    const promotedRow = player.page
      .getByRole("list", { name: "Players" })
      .getByRole("listitem")
      .filter({ hasText: firstGuest.name });
    await expect(promotedRow.getByText("Host", { exact: true })).toBeAttached();

    const formerHostRow = player.page
      .getByRole("list", { name: "Players" })
      .getByRole("listitem")
      .filter({ hasText: host.name });
    await expect(formerHostRow).toBeVisible();
    await expect(formerHostRow.getByText("Host", { exact: true })).toHaveCount(0);
  }

  // Rejoining former host has guest UI (no host controls)
  await expect(host.page.getByText("Waiting for the host to start…", { exact: true })).toBeVisible();
  await expect(host.page.getByRole("button", { name: "Start match" })).toHaveCount(0);
  await expect(host.page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  for (const cycles of [1, 2, 3]) {
    await expect(host.page.getByRole("radio", { name: cycleLabel(cycles) })).toBeDisabled();
  }

  // Promoted host can now start match with 3 players
  await expect(firstGuest.page.getByRole("button", { name: "Start match" })).toBeEnabled();
  await expect(firstGuest.page.getByRole("button", { name: `Remove ${host.name}` })).toBeVisible();
  await expect(firstGuest.page.getByRole("button", { name: `Remove ${secondGuest.name}` })).toBeVisible();
});

test("mid-match host departure reassigns ownership without corrupting schedule and transfers lobby authority upon return", async ({
  players,
}) => {
  const host = await players.create("Host Alpha");
  const guestB = await players.create("Player Bravo");
  const guestC = await players.create("Player Charlie");
  const code = await createRoom(host);

  await joinRoom(guestB, code);
  await joinRoom(guestC, code);

  await host.page.getByRole("button", { name: "Start match" }).click();
  await expect(host.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({ timeout: 15_000 });

  // 1. Required active Judge (host) temporary disconnect triggers pause while transferring host ownership safely
  await host.context.setOffline(true);
  for (const guest of [guestB, guestC]) {
    const pauseDialog = guest.page.getByRole("alertdialog", { name: "Game paused" });
    await expect(pauseDialog).toBeVisible();
    await expect(pauseDialog).toContainText(host.name);
  }

  // Reconnect host before deadline: restores active Judge and dismisses pause
  await host.context.setOffline(false);
  await expect(host.page.getByRole("heading", { name: "Pick the word" })).toBeVisible();
  for (const guest of [guestB, guestC]) {
    await expect(guest.page.getByRole("alertdialog", { name: "Game paused" })).toHaveCount(0);
  }

  // Host picks prompt suggestions -> enters DRAWING
  await host.page.getByRole("group", { name: "Prompt suggestions" }).getByRole("button").first().click();
  for (const guest of [guestB, guestC]) {
    await expect(guest.page.getByLabel("Your canvas")).toBeVisible();
  }

  // Artists submit early
  await guestB.page.getByRole("button", { name: "Submit early" }).click();
  await guestC.page.getByRole("button", { name: "Submit early" }).click();

  // Enters JUDGING
  await expect.poll(async () => (await currentView(host.page)).phase).toBe("JUDGING");

  // Host leaves permanently
  await host.context.close();

  // Active required judge did not return before timeout -> match canceled safely returning participants to lobby
  await expect(guestB.page.getByRole("heading", { name: "Players" })).toBeVisible({ timeout: 35_000 });
  await expect(guestC.page.getByRole("heading", { name: "Players" })).toBeVisible();

  // Player Bravo is deterministically promoted to host in the returned lobby
  for (const player of [guestB, guestC]) {
    const bravoRow = player.page
      .getByRole("list", { name: "Players" })
      .getByRole("listitem")
      .filter({ hasText: guestB.name });
    await expect(bravoRow.getByText("Host", { exact: true })).toBeAttached();
  }

  // Promoted host has host controls; Guest C does not
  await expect(guestB.page.getByRole("button", { name: `Remove ${guestC.name}` })).toBeVisible();
  await expect(guestC.page.getByText("Waiting for the host to start…")).toBeVisible();
  await expect(guestC.page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
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
