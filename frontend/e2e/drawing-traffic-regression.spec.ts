import { drawCanvasStroke } from "./canvas-helpers";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView } from "./service-helpers";

test("dense drawing traffic converges all clients at the drawing deadline", async ({
  players: playerPool,
}) => {
  const [judge, firstArtist, secondArtist] = (await Promise.all([
    playerPool.create("Traffic Judge"),
    playerPool.create("Traffic Artist One"),
    playerPool.create("Traffic Artist Two"),
  ])) as [Player, Player, Player];
  const players = [judge, firstArtist, secondArtist];
  const reactErrors = new Map<Player, string[]>();

  for (const player of players) {
    const errors: string[] = [];
    reactErrors.set(player, errors);
    player.page.on("pageerror", (error) => {
      if (/react|hydration/i.test(error.message)) errors.push(error.message);
    });
  }

  const code = await createRoom(judge);
  await joinRoom(firstArtist, code);
  await joinRoom(secondArtist, code);
  await judge.page.getByRole("button", { name: "Start match" }).click();
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible();
  await judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();

  for (const artist of [firstArtist, secondArtist]) {
    await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
  }

  const drawingView = await currentView(firstArtist.page);
  const drawingDuration = drawingView.deadline! - drawingView.serverNow;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, drawingDuration - 7_000)));
  await Promise.all(
    [firstArtist, secondArtist].map(async (artist, artistIndex) => {
      for (let stroke = 0; stroke < 20; stroke += 1) {
        const x = ((stroke * 17 + artistIndex * 130) % 700) / 700;
        const y = ((stroke * 11 + artistIndex * 90) % 500) / 500;
        await drawCanvasStroke(
          artist.page,
          [x, y],
          [Math.min(0.98, x + 0.04), Math.min(0.98, y + 0.04)],
        );
        if (stroke % 12 === 0) await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }),
  );

  for (const player of players) {
    await expect
      .poll(async () => (await currentView(player.page)).phase, {
        timeout: 7_000,
        message: `${player.name} did not converge to JUDGING after dense drawing traffic`,
      })
      .toBe("JUDGING");
  }

  const judgeView = await currentView(judge.page);
  expect(judgeView.liveCanvases).toHaveLength(2);
  expect(
    judgeView.liveCanvases?.every(({ locked, canvas }) => locked && canvas.actions.length > 0),
  ).toBe(true);
  expect([...reactErrors.values()].flat()).toEqual([]);
});
