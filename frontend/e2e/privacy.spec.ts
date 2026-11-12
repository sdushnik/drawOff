/**
 * E2E: Artist drawing privacy and anonymous identity boundaries (#45).
 *
 * Proves the core privacy boundary: Artists see only their own work, the Judge
 * sees anonymous live/completed drawings, and identities appear only after
 * ratings are finalized.
 */
import { expect, test, type Player } from "./fixtures";
import { drawCanvasStroke } from "./canvas-helpers";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, frontendServiceCall, serverUrl, storedSession } from "./service-helpers";
import { createSocketGameService } from "../src/services/socketGameService";
import type { PlayerView } from "@drawoff/contracts";

/** Collect every `state:update` payload delivered to a player's independent socket. */
async function collectViews(
  page: import("@playwright/test").Page,
  durationMs: number,
): Promise<PlayerView[]> {
  const session = await storedSession(page);
  const service = createSocketGameService(serverUrl());
  const views: PlayerView[] = [];
  return new Promise((resolve) => {
    const unsubscribe = service.subscribe(
      session,
      (view) => views.push(view),
      () => undefined,
    );
    setTimeout(() => {
      unsubscribe();
      resolve(views);
    }, durationMs);
  });
}

/**
 * Start a match and advance through prompt selection into the DRAWING phase.
 * Returns the room code.
 */
async function startDrawingPhase(judge: Player, artists: Player[]): Promise<string> {
  const code = await createRoom(judge);
  for (const artist of artists) await joinRoom(artist, code);
  await judge.page.getByRole("button", { name: "Start match" }).click();
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  await judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();
  // Wait for all Artists to see their canvas
  for (const artist of artists) {
    await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
  }
  return code;
}

test("Artist network traffic contains only own canvas data; no other Artist payloads", async ({
  players,
}) => {
  const judge = await players.create("Privacy Judge");
  const artistA = await players.create("Alice Artist");
  const artistB = await players.create("Bobby Artist");

  await startDrawingPhase(judge, [artistA, artistB]);

  // Both Artists draw distinct strokes
  await drawCanvasStroke(artistA.page, [0.1, 0.1], [0.3, 0.3]);
  await drawCanvasStroke(artistB.page, [0.6, 0.6], [0.8, 0.8]);

  // Wait for synchronization to settle
  await expect
    .poll(async () => {
      const view = await currentView(judge.page);
      return (
        view.liveCanvases?.length === 2 &&
        view.liveCanvases.every(({ canvas }) => canvas.actions.length > 0)
      );
    })
    .toBe(true);

  // Inspect Artist A's server view: must have own canvas, no live canvases, no gallery
  const viewA = await currentView(artistA.page);
  expect(viewA.liveCanvases).toBeNull();
  expect(viewA.gallery).toBeNull();
  expect(viewA.myCanvas).not.toBeNull();

  // Inspect Artist B's server view: same constraints
  const viewB = await currentView(artistB.page);
  expect(viewB.liveCanvases).toBeNull();
  expect(viewB.gallery).toBeNull();
  expect(viewB.myCanvas).not.toBeNull();

  // Collect ~2s of network payloads for Artist A and verify none contain
  // another Artist's canvas data or live-canvas arrays
  const artistAViews = await collectViews(artistA.page, 2_000);
  for (const view of artistAViews) {
    expect(view.liveCanvases).toBeNull();
    expect(view.gallery).toBeNull();
  }
});

test("Judge receives anonymous labels with no Artist identity before reveal", async ({
  players,
}) => {
  const judge = await players.create("Anon Judge");
  const artistA = await players.create("Chloe Artist");
  const artistB = await players.create("Derek Artist");

  await startDrawingPhase(judge, [artistA, artistB]);

  await drawCanvasStroke(artistA.page, [0.1, 0.1], [0.25, 0.25]);
  await drawCanvasStroke(artistB.page, [0.5, 0.5], [0.7, 0.7]);

  // Wait for Judge to receive both canvases
  await expect
    .poll(async () => (await currentView(judge.page)).liveCanvases?.length ?? 0)
    .toBe(2);

  // Verify anonymous labels and no Artist names in UI
  await expect(judge.page.getByLabel(/Drawing [12], live/)).toHaveCount(2);
  await expect(judge.page.getByText(artistA.name, { exact: true })).toHaveCount(0);
  await expect(judge.page.getByText(artistB.name, { exact: true })).toHaveCount(0);

  // Verify at the data level: liveCanvases have no artistId or name field
  const judgeView = await currentView(judge.page);
  for (const lc of judgeView.liveCanvases ?? []) {
    expect(lc.label).toMatch(/^Drawing \d+$/);
    // LiveCanvas schema is strict: label, sequence, canvas, locked — no artistId
    expect(Object.keys(lc).sort()).toEqual(["canvas", "label", "locked", "sequence"]);
  }

  // Artists submit so we transition to JUDGING
  await artistA.page.getByRole("button", { name: "Submit early" }).click();
  await artistB.page.getByRole("button", { name: "Submit early" }).click();

  // JUDGING phase: Artists see waiting, not the gallery
  await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
  for (const artist of [artistA, artistB]) {
    await expect(
      artist.page.getByText("Drawings are anonymous until the scores are locked in."),
    ).toBeVisible();
    await expect(artist.page.getByLabel("Your submitted drawing")).toBeVisible();
    await expect(artist.page.getByLabel(/^Drawing [12]$/)).toHaveCount(0);
  }

  // Judge gallery: same anonymous labels, still no names
  const judgingView = await currentView(judge.page);
  expect(judgingView.gallery?.map(({ label }) => label)).toEqual(["Drawing 1", "Drawing 2"]);
  for (const g of judgingView.gallery ?? []) {
    expect(Object.keys(g).sort()).toEqual(["canvas", "label"]);
  }
  await expect(judge.page.getByText(artistA.name, { exact: true })).toHaveCount(0);
  await expect(judge.page.getByText(artistB.name, { exact: true })).toHaveCount(0);
});

test("Artist identities become visible only after the Judge submits all ratings", async ({
  players,
}) => {
  const judge = await players.create("Reveal Judge");
  const artistA = await players.create("Eva Artist");
  const artistB = await players.create("Frank Artist");

  await startDrawingPhase(judge, [artistA, artistB]);

  await drawCanvasStroke(artistA.page);
  await drawCanvasStroke(artistB.page, [0.5, 0.5], [0.7, 0.7]);

  // Submit canvases
  await artistA.page.getByRole("button", { name: "Submit early" }).click();
  await artistB.page.getByRole("button", { name: "Submit early" }).click();

  // Judge rates and submits
  await expect(judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" })).toBeVisible();
  await judge.page.getByRole("spinbutton", { name: "Drawing 1 rating" }).fill("75");
  await judge.page.getByRole("spinbutton", { name: "Drawing 2 rating" }).fill("55");

  // Before submission: no names visible
  await expect(judge.page.getByText(artistA.name, { exact: true })).toHaveCount(0);
  await expect(judge.page.getByText(artistB.name, { exact: true })).toHaveCount(0);

  await judge.page.getByRole("button", { name: "Submit all ratings" }).click();

  // After submission: round result phase reveals Artist identities
  await expect(judge.page.getByText(/Top drawing:/)).toBeVisible({ timeout: 15_000 });
  await expect(judge.page.getByText(artistA.name, { exact: true }).first()).toBeVisible();
  await expect(judge.page.getByText(artistB.name, { exact: true }).first()).toBeVisible();

  // Verify the round result payload maps labels to artistIds
  const resultView = await currentView(judge.page);
  expect(resultView.roundResult).not.toBeNull();
  expect(resultView.roundResult!.entries).toHaveLength(2);
  for (const entry of resultView.roundResult!.entries) {
    expect(entry.label).toMatch(/^Drawing \d+$/);
    expect(entry.artistId).toBeTruthy();
    expect(entry.rating).toBeGreaterThanOrEqual(0);
  }
});
