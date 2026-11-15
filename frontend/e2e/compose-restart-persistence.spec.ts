import {
  canvasInkPixelCount,
  clickCanvas,
  drawCanvasStroke,
  renderedCanvasHash,
} from "./canvas-helpers";
import { restartComposeApp } from "./compose-helpers";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, storedSession } from "./service-helpers";

test("Compose app container restart restores unexpired rooms, drawing canvas, roles, deadlines, and scores", async ({
  players,
}) => {
  const judge = await players.create("Restart Judge");
  const artist = await players.create("Restart Artist");
  const otherArtist = await players.create("Quiet Artist");
  const code = await createRoom(judge);

  await joinRoom(artist, code);
  await joinRoom(otherArtist, code);

  // 1. Verify lobby state is established
  for (const player of [judge, artist, otherArtist]) {
    await expect(
      player.page.getByRole("list", { name: "Players" }).getByRole("listitem"),
    ).toHaveCount(3);
  }

  await judge.page.getByRole("button", { name: "Start match" }).click();
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });

  await judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();

  const artistCanvas = artist.page.getByLabel("Your canvas");
  const otherCanvas = otherArtist.page.getByLabel("Your canvas");
  await expect(artistCanvas).toBeVisible();
  await expect(otherCanvas).toBeVisible();

  // Draw non-trivial artwork with Pen and Bucket Fill
  await artist.page.getByRole("button", { name: "Brush 16px" }).click();
  await drawCanvasStroke(artist.page, [0.25, 0.25], [0.55, 0.25]);
  await drawCanvasStroke(artist.page, [0.55, 0.25], [0.55, 0.6]);
  await drawCanvasStroke(artist.page, [0.55, 0.6], [0.25, 0.6]);
  await drawCanvasStroke(artist.page, [0.25, 0.6], [0.25, 0.25]);
  const boundaryInk = await canvasInkPixelCount(artistCanvas);

  const fill = artist.page.getByRole("button", { name: "Bucket fill" });
  const blue = artist.page.getByRole("button", { name: "Color #0090ff" });
  await fill.click();
  await blue.click();
  await clickCanvas(artist.page, [0.4, 0.42]);

  await expect.poll(() => canvasInkPixelCount(artistCanvas)).toBeGreaterThan(boundaryInk + 10_000);
  const expectedHash = await renderedCanvasHash(artistCanvas);
  const expectedInk = await canvasInkPixelCount(artistCanvas);

  const preView = await currentView(artist.page);
  expect(preView.phase).toBe("DRAWING");
  expect(preView.prompt).toBeTruthy();
  const remainingMsBeforeRestart = preView.deadline! - preView.serverNow;
  expect(remainingMsBeforeRestart).toBeGreaterThan(0);
  expect(remainingMsBeforeRestart).toBeLessThanOrEqual(75_000);

  // Create a separate room and abandon it before restart
  const tempHost = await players.create("Temp Host");
  const abandonedCode = await createRoom(tempHost);
  await tempHost.page.getByRole("button", { name: "Leave" }).click();
  await expect(tempHost.page).toHaveURL(new RegExp(`^${new URL(tempHost.page.url()).origin}/$`));

  // 2. Restart only the application container while keeping the PostgreSQL volume
  await restartComposeApp();

  // Abandoned room is not restored as active post-restart
  await tempHost.page.goto(`/room/${abandonedCode}`);
  await tempHost.page.getByLabel("Your name").fill("Temp Guest");
  await tempHost.page.getByRole("button", { name: "Join room" }).click();
  await expect(tempHost.page.getByRole("alert")).toHaveText(
    "Room was not found or has expired.",
  );

  // Reload / reconnect players after container restart
  await artist.page.reload();
  await judge.page.reload();
  await otherArtist.page.reload();

  // Verify room, phase, prompt, role, and canvas restoration
  await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
  const restoredArtistView = await currentView(artist.page);
  expect(restoredArtistView.phase).toBe("DRAWING");
  expect(restoredArtistView.prompt).toBe(preView.prompt);
  expect(restoredArtistView.role).toBe("artist");
  expect(restoredArtistView.roomCode).toBe(code);

  await expect.poll(() => canvasInkPixelCount(artist.page.getByLabel("Your canvas"))).toBe(expectedInk);
  expect(restoredArtistView.myCanvas?.canvas.actions).toEqual(preView.myCanvas?.canvas.actions);
  const restoredHash = await renderedCanvasHash(artist.page.getByLabel("Your canvas"));
  await artist.page.reload();
  await expect.poll(() => renderedCanvasHash(artist.page.getByLabel("Your canvas"))).toBe(restoredHash);

  // Judge view restored with live canvases showing artist's drawing
  const restoredJudgeView = await currentView(judge.page);
  expect(restoredJudgeView.phase).toBe("DRAWING");
  expect(restoredJudgeView.role).toBe("judge");
  expect(restoredJudgeView.liveCanvases).toHaveLength(2);

  // Privacy: other artist cannot receive another artist's canvas
  const restoredOtherView = await currentView(otherArtist.page);
  expect(restoredOtherView.role).toBe("artist");
  expect(restoredOtherView.myCanvas?.canvas.actions.length).toBe(0);
  expect(restoredOtherView.liveCanvases).toBeNull();
  expect(restoredOtherView.gallery).toBeNull();

  // Deadline integrity: authoritative deadline resumes from persisted time, not reset to full 75s
  const remainingMsAfterRestart = restoredArtistView.deadline! - restoredArtistView.serverNow;
  expect(remainingMsAfterRestart).toBeLessThanOrEqual(remainingMsBeforeRestart);

  // Authorization: invalid/spoofed token rejected post-restart
  const attacker = await players.create("Attacker");
  await attacker.page.goto(`/room/${code}`);
  const victimSession = await storedSession(artist.page);
  await attacker.page.evaluate(
    ({ roomCode, playerId }) => {
      sessionStorage.setItem(
        `drawoff:session:${roomCode}`,
        JSON.stringify({
          roomCode,
          playerId,
          token: "spoofed-post-restart-token-12345",
        }),
      );
    },
    { roomCode: code, playerId: victimSession.playerId },
  );
  await attacker.page.reload();
  await expect(attacker.page.getByText("Your saved session is no longer valid")).toBeVisible();
  await expect(attacker.page.getByRole("button", { name: "Join room" })).toBeVisible();

  // 3. Complete round ratings and verify point persistence without duplication across restart
  await artist.page.getByRole("button", { name: "Submit early" }).click();
  await otherArtist.page.getByRole("button", { name: "Submit early" }).click();

  await expect.poll(async () => (await currentView(judge.page)).phase).toBe("JUDGING");
  const judgingView = await currentView(judge.page);
  const labels = judgingView.gallery!.map(({ label }) => label);
  for (const [index, label] of labels.entries()) {
    await judge.page.getByRole("spinbutton", { name: `${label} rating` }).fill(String(70 + index * 10));
  }
  await judge.page.getByRole("button", { name: "Submit all ratings" }).click();

  await expect.poll(async () => (await currentView(judge.page)).phase).toBe("ROUND_RESULT");
  const preRestartScores = (await currentView(judge.page)).match!.scores;
  expect(Object.keys(preRestartScores).length).toBeGreaterThan(0);

  // Restart again after finalized ratings
  await restartComposeApp();
  await judge.page.reload();
  await expect.poll(async () => (await currentView(judge.page)).phase).toBe("ROUND_RESULT");

  const postRestartScores = (await currentView(judge.page)).match!.scores;
  expect(postRestartScores).toEqual(preRestartScores);
});
