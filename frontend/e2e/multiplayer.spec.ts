import { expect, test } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";

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
