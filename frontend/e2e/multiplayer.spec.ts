import { drawCanvasStroke } from "./canvas-helpers";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, frontendServiceCall, storedSession } from "./service-helpers";

test("a required browser timing out cancels the incomplete match without a winner", async ({
  players: playerPool,
}) => {
  const players = await Promise.all([
    playerPool.create("Timeout Host"),
    playerPool.create("Returning Artist"),
    playerPool.create("Missing Artist"),
  ]);
  const [host, returning, missing] = players;

  const code = await createRoom(host!);
  await joinRoom(returning!, code);
  await joinRoom(missing!, code);
  await host!.page.getByRole("button", { name: "Start match" }).click();
  await expect(host!.page.getByRole("heading", { name: "Pick the word" })).toBeVisible();
  await host!.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();
  await expect(missing!.page.getByLabel("Your canvas")).toBeVisible();

  await missing!.context.close();
  await expect(host!.page.getByRole("alertdialog", { name: "Game paused" })).toBeVisible();
  await expect(host!.page.getByRole("heading", { name: "Players" })).toBeVisible({
    timeout: 35_000,
  });
  await expect(
    host!.page.getByRole("status").filter({ hasText: /match was canceled/i }),
  ).toContainText("No winner was declared");
  await expect(host!.page.getByText(/wins!|Co-winners!/)).toHaveCount(0);
  await expect(returning!.page.getByRole("heading", { name: "Players" })).toBeVisible();
});

test("host rematch returns everyone to the lobby, adjusts the roster, and starts a clean match with zero scores", async ({
  players: playerPool,
}) => {
  const players = await Promise.all([
    playerPool.create("Rematch Host"),
    playerPool.create("Departing Player"),
    playerPool.create("Staying Player"),
  ]);
  const [host, departing, staying] = players as [Player, Player, Player];

  const code = await createRoom(host);
  await joinRoom(departing, code);
  await joinRoom(staying, code);
  await host.page.getByRole("button", { name: "Start match" }).click();

  const matchPlayers = [host, departing, staying];
  for (const [round, judge] of matchPlayers.entries()) {
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
        await drawCanvasStroke(artist.page);
        await artist.page.getByRole("button", { name: "Submit early" }).click();
      }),
    );

    await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
    await judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" }).fill("80");
    await judge.page.getByRole("spinbutton", { name: "Drawing 2 rating" }).fill("60");
    await judge.page.getByRole("button", { name: "Submit all ratings" }).click();
    await expect(judge.page.getByText(/Top drawing:/)).toBeVisible();

    const roundResult = await currentView(judge.page);
    expect(roundResult.phase).toBe("ROUND_RESULT");
    expect(roundResult.match?.roundIndex).toBe(round);
  }

  await expect
    .poll(async () => (await currentView(host.page)).phase, { timeout: 20_000 })
    .toBe("FINAL_RESULT");
  await expect(host.page.getByText("3 rounds · 1 cycle")).toBeVisible();

  await expect(host.page.getByRole("button", { name: "Play again" })).toBeVisible();
  for (const guest of [departing, staying]) {
    await expect(guest.page.getByRole("button", { name: "Play again" })).toHaveCount(0);
    await expect(guest.page.getByText("Waiting for the host to start a rematch…")).toBeVisible();
  }
  const unauthorizedRematch = await frontendServiceCall(staying.page, "rematch");
  expect(unauthorizedRematch).toMatchObject({ ok: false, code: "FORBIDDEN" });

  await host.page.getByRole("button", { name: "Play again" }).click();
  for (const player of matchPlayers) {
    await expect(player.page).toHaveURL(new RegExp(`/room/${code}$`));
    await expect(player.page.getByRole("heading", { name: "Players" })).toBeVisible();
    await expect(player.page.getByText("Leaderboard")).toHaveCount(0);
    const view = await currentView(player.page);
    expect(view.phase).toBe("LOBBY");
    expect(view.matchStarted).toBe(false);
    expect(view.match).toBeNull();
    expect(view.finalResult).toBeNull();
    expect(view.roundResult).toBeNull();
  }

  const departingSession = await storedSession(departing.page);
  await departing.page.getByRole("button", { name: "Leave" }).click();
  await expect(departing.page).toHaveURL(new RegExp("/$"));
  for (const player of [host, staying]) {
    await expect(
      player.page
        .getByRole("list", { name: "Players" })
        .getByRole("listitem")
        .filter({ hasText: departing.name }),
    ).toHaveCount(0);
    await expect(player.page.getByText(/1 more to go/)).toBeVisible();
  }
  await expect(host.page.getByRole("button", { name: "Start match" })).toBeDisabled();
  await expect(staying.page.getByRole("button", { name: "Start match" })).toHaveCount(0);

  const newcomer = await playerPool.create("Nova Newcomer");
  await joinRoom(newcomer, code);
  for (const player of [host, staying, newcomer]) {
    await expect(
      player.page
        .getByRole("list", { name: "Players" })
        .getByRole("listitem")
        .filter({ hasText: newcomer.name }),
    ).toBeVisible();
    await expect(player.page.getByText("3 rounds ·", { exact: false })).toBeVisible();
  }
  await expect(host.page.getByRole("button", { name: "Start match" })).toBeEnabled();

  await host.page.getByRole("button", { name: "Start match" }).click();
  for (const player of [host, staying, newcomer]) {
    await expect(player.page.getByText(/Round 1 of 3/)).toBeVisible();
  }

  const rematchHostView = await currentView(host.page);
  expect(rematchHostView.match?.order).toHaveLength(3);
  expect(rematchHostView.match?.order).not.toContain(departingSession.playerId);
  expect(rematchHostView.match?.totalRounds).toBe(3);
  expect(Object.values(rematchHostView.match?.scores ?? {})).toEqual([0, 0, 0]);
  expect(rematchHostView.myCanvas).toBeNull();
  expect(rematchHostView.roundResult).toBeNull();
  expect(rematchHostView.finalResult).toBeNull();
});

