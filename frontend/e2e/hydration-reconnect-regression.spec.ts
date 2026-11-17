import { canvasInkPixelCount, drawCanvasStroke, renderedCanvasHash } from "./canvas-helpers";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { currentView, storedSession } from "./service-helpers";

const TRACK_JOIN_FORM = "drawoff:e2e:track-join-form";
const SAW_JOIN_FORM = "drawoff:e2e:saw-join-form";

async function authoritativeActionCount(judge: Player): Promise<number> {
  const view = await currentView(judge.page);
  return view.liveCanvases?.reduce((total, entry) => total + entry.canvas.actions.length, 0) ?? 0;
}

test("saved room hydration and offline Artist drawing survive an authenticated reconnect", async ({
  players,
}) => {
  const host = await players.create("Regression Judge");
  const artist = await players.create("Queued Artist");
  const otherArtist = await players.create("Steady Artist");
  const pageErrors: string[] = [];
  const react418Errors: string[] = [];

  for (const player of [host, artist, otherArtist]) {
    player.page.on("pageerror", (error) => pageErrors.push(`${player.name}: ${error.message}`));
    player.page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /(?:React error #418|Minified React error #418)/i.test(message.text())
      ) {
        react418Errors.push(`${player.name}: ${message.text()}`);
      }
    });
  }

  const code = await createRoom(host);
  await joinRoom(artist, code);
  await joinRoom(otherArtist, code);
  const savedSession = await storedSession(artist.page);

  await artist.context.addInitScript(
    ({ trackKey, sawKey }) => {
      if (sessionStorage.getItem(trackKey) !== "1") return;
      const recordJoinForm = () => {
        const sawNameLabel = [...document.querySelectorAll("label")].some(
          (label) => label.textContent?.trim() === "Your name",
        );
        if (sawNameLabel) sessionStorage.setItem(sawKey, "1");
      };
      new MutationObserver(recordJoinForm).observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", recordJoinForm, { once: true });
    },
    { trackKey: TRACK_JOIN_FORM, sawKey: SAW_JOIN_FORM },
  );
  await artist.page.evaluate(
    ({ trackKey, sawKey }) => {
      sessionStorage.setItem(trackKey, "1");
      sessionStorage.removeItem(sawKey);
    },
    { trackKey: TRACK_JOIN_FORM, sawKey: SAW_JOIN_FORM },
  );

  await artist.page.goto(`/room/${code}`);
  await expect(artist.page.getByRole("heading", { name: "Players" })).toBeVisible();
  await expect(artist.page.getByLabel("Your name")).toHaveCount(0);
  expect(await storedSession(artist.page)).toEqual(savedSession);
  expect(pageErrors).toEqual([]);
  expect(react418Errors).toEqual([]);

  await host.page.getByRole("button", { name: "Start match" }).click();
  await expect(host.page.getByRole("heading", { name: "Pick the word" })).toBeVisible();
  await host.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first()
    .click();
  await expect(artist.page.getByLabel("Your canvas")).toBeVisible();
  await expect(otherArtist.page.getByLabel("Your canvas")).toBeVisible();
  expect(await authoritativeActionCount(host)).toBe(0);

  await artist.context.setOffline(true);
  await expect(host.page.getByRole("alertdialog", { name: "Game paused" })).toBeVisible();
  await drawCanvasStroke(artist.page, [0.12, 0.18], [0.52, 0.58]);
  const offlineInk = await canvasInkPixelCount(artist.page.getByLabel("Your canvas"));
  const offlineCanvasHash = await renderedCanvasHash(artist.page.getByLabel("Your canvas"));
  expect(offlineInk).toBeGreaterThan(50);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(await authoritativeActionCount(host)).toBe(0);

  await artist.context.setOffline(false);
  await expect(host.page.getByRole("alertdialog", { name: "Game paused" })).toHaveCount(0);
  await expect(artist.page.getByRole("alertdialog", { name: "Game paused" })).toHaveCount(0);
  await expect.poll(() => authoritativeActionCount(host)).toBeGreaterThan(0);
  await expect
    .poll(async () => (await currentView(artist.page)).myCanvas?.canvas.actions.length ?? 0)
    .toBeGreaterThan(0);

  expect(await storedSession(artist.page)).toEqual(savedSession);
  await expect(artist.page.getByLabel("Your name")).toHaveCount(0);
  expect(
    await artist.page.evaluate((sawKey) => sessionStorage.getItem(sawKey), SAW_JOIN_FORM),
  ).toBeNull();
  expect(await renderedCanvasHash(artist.page.getByLabel("Your canvas"))).toBe(offlineCanvasHash);
  expect(await canvasInkPixelCount(artist.page.getByLabel("Your canvas"))).toBeGreaterThanOrEqual(
    offlineInk,
  );
  expect(
    pageErrors.filter((message) => /(?:React error #418|Minified React error #418)/i.test(message)),
  ).toEqual([]);
  expect(react418Errors).toEqual([]);
});
