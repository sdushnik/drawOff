import { expect, test, type Page } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";

test("three guests share one live lobby roster through disconnect and reconnect", async ({
  players,
}) => {
  const host = await players.create("  Harper   Host  ");
  const firstGuest = await players.create("Arlo Guest");
  const reconnectingGuest = await players.create("Jules Guest");
  const code = await createRoom(host);

  await joinRoom(firstGuest, code);
  await joinRoom(reconnectingGuest, code);

  const expectedNames = ["Harper Host", firstGuest.name, reconnectingGuest.name];
  for (const player of [host, firstGuest, reconnectingGuest]) {
    await expectLobby(player.page, code, expectedNames);
    await expectRosterStatus(
      player.page,
      `Room ${code} roster: Harper Host, host, connected; ${firstGuest.name}, connected; ${reconnectingGuest.name}, connected`,
    );
    await expect(player.page.getByText(/spectator/i)).toHaveCount(0);
  }

  await reconnectingGuest.context.setOffline(true);
  const disconnectedStatus = `Room ${code} roster: Harper Host, host, connected; ${firstGuest.name}, connected; ${reconnectingGuest.name}, disconnected`;
  for (const player of [host, firstGuest]) {
    await expectRosterStatus(player.page, disconnectedStatus);
    await expectRoster(player.page, expectedNames);
  }

  await reconnectingGuest.context.setOffline(false);
  const connectedStatus = `Room ${code} roster: Harper Host, host, connected; ${firstGuest.name}, connected; ${reconnectingGuest.name}, connected`;
  for (const player of [host, firstGuest, reconnectingGuest]) {
    await expectRosterStatus(player.page, connectedStatus);
    await expectRoster(player.page, expectedNames);
  }
});

test("the lobby copies its canonical invite and shows a visible clipboard fallback", async ({
  players,
}) => {
  const host = await players.create("Share Host");
  const code = await createRoom(host);
  const origin = new URL(host.page.url()).origin;
  const canonicalInvite = `${origin}/room/${code}`;
  const copyInvite = host.page.getByRole("button", { name: "Copy invite link" });

  await host.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await copyInvite.click();
  await expect(host.page.getByRole("button", { name: "Copied!" })).toBeVisible();
  await expect
    .poll(() => host.page.evaluate(() => navigator.clipboard.readText()))
    .toBe(canonicalInvite);
  await expect(host.page.getByRole("button", { name: "Copy invite link" })).toBeVisible({
    timeout: 3_000,
  });

  const pageErrors: string[] = [];
  host.page.on("pageerror", (error) => pageErrors.push(error.message));
  await host.page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        throw new DOMException("Clipboard denied", "NotAllowedError");
      },
    });
  });
  await copyInvite.click();

  await expect(host.page.getByText(canonicalInvite, { exact: true })).toBeVisible();
  await expect(host.page.getByRole("heading", { name: "Players" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

async function expectLobby(page: Page, code: string, names: string[]): Promise<void> {
  await expect(page.getByRole("paragraph").filter({ hasText: code })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy invite link" })).toBeVisible();
  await expectRoster(page, names);

  const roster = page.getByRole("list", { name: "Players" });
  const hostRows = roster.getByText("Host", { exact: true });
  await expect(hostRows).toHaveCount(1);
  await expect(
    roster.getByRole("listitem").filter({ hasText: names[0] }).getByText("Host", { exact: true }),
  ).toBeAttached();
}

async function expectRoster(page: Page, names: string[]): Promise<void> {
  const roster = page.getByRole("list", { name: "Players" });
  await expect(roster.getByRole("listitem")).toHaveCount(names.length);
  for (const name of names) {
    await expect(roster.getByRole("listitem").filter({ hasText: name })).toHaveCount(1);
  }
}

async function expectRosterStatus(page: Page, status: string): Promise<void> {
  await expect(page.getByText(status, { exact: true })).toHaveAttribute("role", "status");
}
