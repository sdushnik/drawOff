import type { Page } from "@playwright/test";
import { expect, test, type Player } from "./fixtures";
import { createRoom, waitForClientAndServer } from "./room-helpers";

const NAME_ERROR = "Name must be 2–20 characters.";
const CODE_ERROR = "Enter a valid room code or invite link.";

test("guests create and join a private room by code without accounts", async ({ players }) => {
  const host = await players.create("  Harper   Host  ");
  const guest = await players.create("  Jules   Guest  ");

  const code = await createRoom(host);
  await expect(host.page).toHaveURL(new RegExp(`/room/${code}$`));
  await expect(host.page.getByRole("heading", { name: "Players" })).toBeVisible();
  const hostRow = host.page.getByRole("listitem").filter({ hasText: "Harper Host" });
  await expect(hostRow).toBeVisible();
  await expect(hostRow.getByText("Host", { exact: true })).toBeAttached();
  await expect(host.page.getByText(/sign in|create account/i)).toHaveCount(0);

  await guest.page.goto("/");
  await waitForClientAndServer(guest.page);
  await guest.page.getByLabel("Your name").fill(guest.name);
  await guest.page.getByLabel("Room code or invite link").fill(code);
  await guest.page.getByRole("button", { name: "Join", exact: true }).click();

  await expect(guest.page).toHaveURL(new RegExp(`/room/${code}$`));
  await expect(guest.page.getByRole("heading", { name: "Players" })).toBeVisible();
  for (const page of [host.page, guest.page]) {
    await expect(page.getByRole("listitem").filter({ hasText: "Harper Host" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Jules Guest" })).toBeVisible();
  }
});

test("entry forms reject invalid names and malformed room codes visibly", async ({ players }) => {
  const guest = await players.create("Validation Guest");
  await guest.page.goto("/");
  await waitForClientAndServer(guest.page);
  const name = guest.page.getByLabel("Your name");
  const code = guest.page.getByLabel("Room code or invite link");
  const create = guest.page.getByRole("button", { name: /Create a room/ });
  const join = guest.page.getByRole("button", { name: "Join", exact: true });

  for (const invalidName of ["", "   ", " x "]) {
    await name.fill(invalidName);
    await create.click();
    await expect(guest.page.getByRole("alert")).toHaveText(NAME_ERROR);
    await expect(guest.page).toHaveURL(/\/$/);
    await expect(guest.page.getByRole("heading", { name: "Players" })).toHaveCount(0);
  }

  await name.fill("<script>");
  await create.click();
  await expect(guest.page.getByRole("alert")).toHaveText("Name can't contain < or >.");
  await expect(guest.page).toHaveURL(/\/$/);

  await name.fill("Valid Guest");
  for (const invalidCode of ["", "ABC", "bad-code!"]) {
    await code.fill(invalidCode);
    await join.click();
    await expect(guest.page.getByRole("alert")).toHaveText(CODE_ERROR);
    await expect(guest.page).toHaveURL(/\/$/);
    await expect(guest.page.getByRole("heading", { name: "Players" })).toHaveCount(0);
  }
});

test("name fields enforce 20 characters and accept the boundary", async ({ players }) => {
  const guest = await players.create("Boundary Guest");
  await guest.page.goto("/");
  await waitForClientAndServer(guest.page);
  const name = guest.page.getByLabel("Your name");
  const boundaryName = "ABCDEFGHIJKLMNOPQRST";

  await name.pressSequentially(`${boundaryName}U`);
  await expect(name).toHaveValue(boundaryName);
  await expect(name).toHaveAttribute("maxlength", "20");
  await guest.page.getByRole("button", { name: /Create a room/ }).click();

  await expect(guest.page).toHaveURL(/\/room\/[A-Z0-9]{5,6}$/);
  await expect(guest.page.getByRole("heading", { name: "Players" })).toBeVisible();
  await expect(guest.page.getByRole("listitem").filter({ hasText: boundaryName })).toBeVisible();
});

test("unknown-room errors remain retryable through the real backend", async ({ players }) => {
  const host = await players.create("Retry Host");
  const guest = await players.create("Retry Guest");
  const code = await createRoom(host);

  await guest.page.goto("/");
  await waitForClientAndServer(guest.page);
  await guest.page.getByLabel("Your name").fill(guest.name);
  await guest.page.getByLabel("Room code or invite link").fill("ZZZZZ");
  await guest.page.getByRole("button", { name: "Join", exact: true }).click();

  await expect(guest.page.getByRole("alert")).toHaveText("Room was not found or has expired.");
  await expect(guest.page).toHaveURL(/\/$/);
  await expect(guest.page.getByRole("heading", { name: "Players" })).toHaveCount(0);

  await guest.page.getByLabel("Room code or invite link").fill(code);
  await guest.page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(guest.page).toHaveURL(new RegExp(`/room/${code}$`));
  await expect(guest.page.getByRole("heading", { name: "Players" })).toBeVisible();
});

test("both entry actions stay disabled while real create and join requests are pending", async ({
  players,
}) => {
  const host = await players.create("Existing Host");
  const creatingGuest = await players.create("Creating Guest");
  const joiningGuest = await players.create("Joining Guest");
  const code = await createRoom(host);

  await creatingGuest.page.goto("/");
  await waitForClientAndServer(creatingGuest.page);
  await creatingGuest.page.getByLabel("Your name").fill(creatingGuest.name);
  await withNetworkLatency(creatingGuest, async () => {
    await creatingGuest.page.getByRole("button", { name: /Create a room/ }).click();
    await expectEntryActionsDisabled(creatingGuest.page);
    await expect(creatingGuest.page).toHaveURL(/\/room\/[A-Z0-9]{5,6}$/, { timeout: 15_000 });
  });

  await joiningGuest.page.goto("/");
  await waitForClientAndServer(joiningGuest.page);
  await joiningGuest.page.getByLabel("Your name").fill(joiningGuest.name);
  await joiningGuest.page.getByLabel("Room code or invite link").fill(code);
  await withNetworkLatency(joiningGuest, async () => {
    await joiningGuest.page.getByRole("button", { name: "Join", exact: true }).click();
    await expectEntryActionsDisabled(joiningGuest.page);
    await expect(joiningGuest.page).toHaveURL(new RegExp(`/room/${code}$`), { timeout: 15_000 });
  });
});

async function expectEntryActionsDisabled(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /Create a room/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Join", exact: true })).toBeDisabled();
}

async function withNetworkLatency(player: Player, action: () => Promise<void>): Promise<void> {
  const session = await player.context.newCDPSession(player.page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 1_500,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  try {
    await action();
  } finally {
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await session.detach();
  }
}
