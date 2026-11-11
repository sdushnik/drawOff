import { expect, test, type Player } from "./fixtures";
import { createRoom, waitForClientAndServer } from "./room-helpers";

const NAME_ERROR = "Name must be 2–20 characters.";

test("the lobby copies a canonical invite that gates membership on name submission", async ({
  players,
}) => {
  const host = await players.create("Invite Host");
  const guest = await players.create("Link Guest");
  const code = await createRoom(host);
  const origin = new URL(host.page.url()).origin;
  const canonicalInvite = `${origin}/room/${code}`;

  const copyInvite = host.page.getByRole("button", { name: "Copy invite link" });
  await expect(copyInvite.locator("..").getByText(code, { exact: true })).toBeVisible();
  await host.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await copyInvite.click();
  await expect(host.page.getByRole("button", { name: "Copied!" })).toBeVisible();
  await expect
    .poll(() => host.page.evaluate(() => navigator.clipboard.readText()))
    .toBe(canonicalInvite);

  await guest.page.goto(canonicalInvite);
  await waitForClientAndServer(guest.page);
  await expect(guest.page.getByText(code, { exact: true })).toBeVisible();
  await expect(guest.page.getByRole("button", { name: "Join room" })).toBeVisible();
  await expectRoster(host, [host.name]);

  await guest.page.getByLabel("Your name").fill(guest.name);
  await guest.page.getByRole("button", { name: "Join room" }).click();
  await expect(guest.page.getByRole("heading", { name: "Players" })).toBeVisible();
  await expectRoster(host, [host.name, guest.name]);
});

test("a lowercase direct invite displays and joins the normalized room code", async ({
  players,
}) => {
  const host = await players.create("Case Host");
  const guest = await players.create("Case Guest");
  const code = await createRoom(host);

  await guest.page.goto(`/room/${code.toLowerCase()}`);
  await waitForClientAndServer(guest.page);
  await expect(guest.page.getByText(code, { exact: true })).toBeVisible();
  await guest.page.getByLabel("Your name").fill(guest.name);
  await guest.page.getByRole("button", { name: "Join room" }).click();

  await expect(guest.page).toHaveURL(new RegExp(`/room/${code.toLowerCase()}$`));
  await expectRoster(host, [host.name, guest.name]);
  await expectRoster(guest, [host.name, guest.name]);
});

test("home entry normalizes whitespace, lowercase codes, and full invite URLs", async ({
  players,
}) => {
  const host = await players.create("Paste Host");
  const codeGuest = await players.create("Code Guest");
  const urlGuest = await players.create("URL Guest");
  const code = await createRoom(host);
  const origin = new URL(host.page.url()).origin;

  await joinFromHome(codeGuest, `  ${code.toLowerCase()}  `, code);
  await joinFromHome(urlGuest, `  ${origin}/room/${code.toLowerCase()}?from=party#join  `, code);

  const names = [host.name, codeGuest.name, urlGuest.name];
  await expectRoster(host, names);
  await expectRoster(codeGuest, names);
  await expectRoster(urlGuest, names);
});

test("direct invites reject invalid names without changing the host roster", async ({
  players,
}) => {
  const host = await players.create("Gate Host");
  const guest = await players.create("Valid Guest");
  const code = await createRoom(host);

  await guest.page.goto(`/room/${code}`);
  await waitForClientAndServer(guest.page);
  const name = guest.page.getByLabel("Your name");
  const join = guest.page.getByRole("button", { name: "Join room" });

  for (const invalidName of ["", "   ", " x "]) {
    await name.fill(invalidName);
    await join.click();
    await expect(guest.page.getByRole("alert")).toHaveText(NAME_ERROR);
    await expect(join).toBeVisible();
    await expectRoster(host, [host.name]);
  }

  await name.fill("<guest>");
  await join.click();
  await expect(guest.page.getByRole("alert")).toHaveText("Name can't contain < or >.");
  await expectRoster(host, [host.name]);

  await name.fill(guest.name);
  await join.click();
  await expect(guest.page.getByRole("heading", { name: "Players" })).toBeVisible();
  await expectRoster(host, [host.name, guest.name]);
});

test("an unknown invite shows a retryable backend error without exposing a roster", async ({
  players,
}) => {
  const host = await players.create("Recovery Host");
  const guest = await players.create("Recovery Guest");
  const code = await createRoom(host);

  await guest.page.goto("/room/ZZZZZ");
  await waitForClientAndServer(guest.page);
  await guest.page.getByLabel("Your name").fill(guest.name);
  await guest.page.getByRole("button", { name: "Join room" }).click();

  await expect(guest.page.getByRole("alert")).toHaveText("Room was not found or has expired.");
  await expect(guest.page.getByRole("button", { name: "Join room" })).toBeVisible();
  await expect(guest.page.getByRole("heading", { name: "Players" })).toHaveCount(0);
  await expect(guest.page.getByRole("listitem")).toHaveCount(0);
  await expectRoster(host, [host.name]);

  await guest.page.goto(`/room/${code}`);
  await waitForClientAndServer(guest.page);
  await guest.page.getByLabel("Your name").fill(guest.name);
  await guest.page.getByRole("button", { name: "Join room" }).click();
  await expect(guest.page.getByRole("heading", { name: "Players" })).toBeVisible();
  await expectRoster(host, [host.name, guest.name]);
});

async function joinFromHome(
  player: Player,
  roomEntry: string,
  expectedCode: string,
): Promise<void> {
  await player.page.goto("/");
  await waitForClientAndServer(player.page);
  await player.page.getByLabel("Your name").fill(player.name);
  await player.page.getByLabel("Room code or invite link").fill(roomEntry);
  await player.page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(player.page).toHaveURL(new RegExp(`/room/${expectedCode}$`));
  await expect(player.page.getByRole("heading", { name: "Players" })).toBeVisible();
}

async function expectRoster(player: Player, names: string[]): Promise<void> {
  const roster = player.page.getByRole("list", { name: "Players" });
  await expect(roster.getByRole("listitem")).toHaveCount(names.length);
  for (const name of names) {
    await expect(roster.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  }
}
