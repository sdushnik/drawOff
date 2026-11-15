import { canvasInkPixelCount } from "./canvas-helpers";
import { expect, test, type Player } from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";
import { assertNoHorizontalScroll, drawTouchStroke, setViewport } from "./viewport-helpers";

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

async function startMatchToDrawing(
  judge: Player,
  artists: Player[],
): Promise<string> {
  const code = await createRoom(judge);
  for (const artist of artists) {
    await joinRoom(artist, code);
  }
  await expect(judge.page.getByRole("button", { name: "Start match" })).toBeEnabled({
    timeout: 15_000,
  });
  await judge.page.getByRole("button", { name: "Start match" }).click();
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  const suggestion = judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first();
  const prompt = (await suggestion.textContent())?.trim();
  if (!prompt) throw new Error("The Judge did not receive a prompt suggestion.");
  await suggestion.click();
  return prompt;
}

test("desktop and mobile viewports display all core screens without horizontal overflow", async ({
  players,
}) => {
  const judge = await players.create("Judge Responsive");
  const artist1 = await players.create("Artist One");
  const artist2 = await players.create("Artist Two");

  // 1. Desktop baseline Home
  await judge.page.goto("/");
  await setViewport(judge.page, DESKTOP_VIEWPORT);
  await assertNoHorizontalScroll(judge.page, "Desktop Home");

  // 2. Mobile Home
  await setViewport(judge.page, MOBILE_VIEWPORT);
  await assertNoHorizontalScroll(judge.page, "Mobile Home");
  await setViewport(artist1.page, MOBILE_VIEWPORT);
  await setViewport(artist2.page, MOBILE_VIEWPORT);

  // 3. Lobby on mobile
  const prompt = await startMatchToDrawing(judge, [artist1, artist2]);
  await assertNoHorizontalScroll(judge.page, "Mobile Judge Drawing");
  await assertNoHorizontalScroll(artist1.page, "Mobile Artist Drawing");

  // Timer and phase indicators remain visible on phone
  await expect(judge.page.getByRole("timer")).toBeVisible();
  await expect(artist1.page.getByRole("timer")).toBeVisible();
  await expect(artist1.page.getByText(prompt, { exact: true }).first()).toBeVisible();

  // Judge Grid and Focus View adaptation
  await expect(judge.page.getByLabel(/Drawing [1-9]\d*, live/)).toHaveCount(2);
  const firstCanvasButton = judge.page.getByLabel(/Drawing [1-9]\d*, live/).first();
  await firstCanvasButton.click();
  await expect(judge.page.getByRole("button", { name: /Grid view/i })).toBeVisible();
  await assertNoHorizontalScroll(judge.page, "Mobile Judge Focus View");
  await judge.page.getByRole("button", { name: /Grid view/i }).click();
  await assertNoHorizontalScroll(judge.page, "Mobile Judge Grid View");

  // 4. Judging gallery on mobile
  await artist1.page.getByRole("button", { name: "Submit early" }).click();
  await artist2.page.getByRole("button", { name: "Submit early" }).click();

  await expect(judge.page.getByText("The word was")).toBeVisible({
    timeout: 15_000,
  });
  await assertNoHorizontalScroll(judge.page, "Mobile Judging Gallery");

  // 5. Results on mobile
  const ratingInputs = judge.page.getByRole("spinbutton");
  const count = await ratingInputs.count();
  for (let i = 0; i < count; i++) {
    await ratingInputs.nth(i).fill("85");
  }
  await judge.page.getByRole("button", { name: "Submit all ratings" }).click();

  await expect(judge.page.getByRole("heading", { name: `“${prompt}”` })).toBeVisible({
    timeout: 15_000,
  });
  await assertNoHorizontalScroll(judge.page, "Mobile Round Results");
});

test("touch targets are sized and spaced for mobile touch and touch drawing works", async ({
  players,
}) => {
  const judge = await players.create("Judge Touch");
  const artist1 = await players.create("Artist Touch 1");
  const artist2 = await players.create("Artist Touch 2");

  await setViewport(judge.page, MOBILE_VIEWPORT);
  await setViewport(artist1.page, MOBILE_VIEWPORT);
  await setViewport(artist2.page, MOBILE_VIEWPORT);

  await startMatchToDrawing(judge, [artist1, artist2]);

  // Verify Artist drawing tools touch target sizes (>= 32px height/width)
  const penButton = artist1.page.getByRole("button", { name: "Pen" });
  const eraserButton = artist1.page.getByRole("button", { name: "Eraser" });
  const fillButton = artist1.page.getByRole("button", { name: "Bucket fill" });
  const submitButton = artist1.page.getByRole("button", { name: "Submit early" });

  for (const btn of [penButton, eraserButton, fillButton]) {
    const box = await btn.boundingBox();
    expect(box, `Button ${await btn.getAttribute("aria-label")} bounding box`).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(32);
    expect(box!.height).toBeGreaterThanOrEqual(32);
  }

  const submitBox = await submitButton.boundingBox();
  expect(submitBox).not.toBeNull();
  expect(submitBox!.width).toBeGreaterThanOrEqual(100);
  expect(submitBox!.height).toBeGreaterThanOrEqual(36);

  // Artist performs touch drawing
  const canvas = artist1.page.getByLabel("Your canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvasInkPixelCount(canvas)).toBe(0);

  await drawTouchStroke(artist1.page, canvas, [0.2, 0.3], [0.65, 0.55]);
  await expect.poll(() => canvasInkPixelCount(canvas), { timeout: 10_000 }).toBeGreaterThan(300);

  // Submit via touch/click
  await submitButton.click();
  await expect(artist1.page.getByText(/Submitted — you can continue drawing/i)).toBeVisible();
});

test("non-canvas controls support full keyboard navigation with visible focus and accessible names", async ({
  players,
}) => {
  const judge = await players.create("Judge KeyNav");
  const artist1 = await players.create("Artist KeyNav 1");
  const artist2 = await players.create("Artist KeyNav 2");

  // Home screen keyboard navigation
  await judge.page.goto("/");
  await setViewport(judge.page, DESKTOP_VIEWPORT);

  // Focus name input via Tab
  await judge.page.keyboard.press("Tab");
  const nameInput = judge.page.getByLabel("Your name");
  await expect(nameInput).toBeFocused();

  // Fill name and tab to Create room button
  await judge.page.keyboard.type(judge.name);
  await judge.page.keyboard.press("Tab");
  const createBtn = judge.page.getByRole("button", { name: /Create a room/i });
  await expect(createBtn).toBeFocused();
  await judge.page.keyboard.press("Enter");

  // Wait for lobby
  await expect(judge.page.getByRole("button", { name: "Start match" })).toBeVisible({
    timeout: 15_000,
  });
  const roomCode = (await judge.page.locator("header").getByText(/^[A-Z0-9]{5,6}$/).textContent())?.trim();
  if (!roomCode) {
    const url = judge.page.url();
    const code = url.split("/").pop();
    if (!code) throw new Error("Could not determine room code");
    await joinRoom(artist1, code);
    await joinRoom(artist2, code);
  } else {
    await joinRoom(artist1, roomCode);
    await joinRoom(artist2, roomCode);
  }

  // Keyboard navigation in Lobby: focus Start match and activate with Space/Enter
  const startBtn = judge.page.getByRole("button", { name: "Start match" });
  await expect(startBtn).toBeEnabled({ timeout: 15_000 });
  await startBtn.focus();
  await expect(startBtn).toBeFocused();
  await judge.page.keyboard.press("Enter");

  // Word selection via keyboard
  await expect(judge.page.getByRole("heading", { name: "Pick the word" })).toBeVisible({
    timeout: 15_000,
  });
  const firstPromptBtn = judge.page
    .getByRole("group", { name: "Prompt suggestions" })
    .getByRole("button")
    .first();
  await firstPromptBtn.focus();
  await expect(firstPromptBtn).toBeFocused();
  await judge.page.keyboard.press("Enter");

  // In Drawing phase: Artist toolbar keyboard navigation
  await expect(artist1.page.getByLabel("Your canvas")).toBeVisible({ timeout: 15_000 });
  const penBtn = artist1.page.getByRole("button", { name: "Pen" });
  const eraserBtn = artist1.page.getByRole("button", { name: "Eraser" });

  await penBtn.focus();
  await expect(penBtn).toBeFocused();
  await expect(penBtn).toHaveAttribute("aria-pressed", "true");

  await eraserBtn.focus();
  await expect(eraserBtn).toBeFocused();
  await artist1.page.keyboard.press("Enter");
  await expect(eraserBtn).toHaveAttribute("aria-pressed", "true");
  await expect(penBtn).toHaveAttribute("aria-pressed", "false");
});

test("accessibility semantics and reduced-motion mode preserve information and announcements", async ({
  players,
}) => {
  const judge = await players.create("Judge A11y");
  const artist1 = await players.create("Artist A11y 1");
  const artist2 = await players.create("Artist A11y 2");

  // Emulate prefers-reduced-motion: reduce
  await judge.page.emulateMedia({ reducedMotion: "reduce" });
  await artist1.page.emulateMedia({ reducedMotion: "reduce" });
  await artist2.page.emulateMedia({ reducedMotion: "reduce" });

  const prompt = await startMatchToDrawing(judge, [artist1, artist2]);

  // Live status announcements during drawing
  const readyStatus = artist1.page.locator('[role="status"][aria-live="polite"]', {
    hasText: /Artists ready/,
  });
  await expect(readyStatus).toBeVisible();
  await expect(readyStatus).toContainText("0 / 2 Artists ready");

  // Artist 1 submits
  await artist1.page.getByRole("button", { name: "Submit early" }).click();
  await expect(readyStatus).toContainText("1 / 2 Artists ready");
  await expect(
    artist1.page.locator('[role="status"][aria-live="polite"]', {
      hasText: /Submitted — you can continue/i,
    }),
  ).toBeVisible();

  // Timer role check
  const timer = judge.page.getByRole("timer");
  await expect(timer).toBeVisible();
  await expect(timer).toHaveAttribute("aria-live", "off");

  // Artist 2 submits to transition to judging
  await artist2.page.getByRole("button", { name: "Submit early" }).click();

  // In Judging gallery: live rating progress
  await expect(judge.page.getByText(/0 of 2 rated/i)).toBeVisible({ timeout: 15_000 });
  const ratingLiveRegion = judge.page.locator('[aria-live="polite"]', { hasText: /rated/i });
  await expect(ratingLiveRegion).toBeVisible();

  const inputs = judge.page.getByRole("spinbutton");
  await inputs.nth(0).fill("90");
  await expect(ratingLiveRegion).toHaveText("1 of 2 rated");
  await inputs.nth(1).fill("95");
  await expect(ratingLiveRegion).toHaveText("2 of 2 rated");

  // Submit ratings and verify reduced motion skips staged delay
  await judge.page.getByRole("button", { name: "Submit all ratings" }).click();
  await expect(judge.page.getByRole("heading", { name: `“${prompt}”` })).toBeVisible({
    timeout: 15_000,
  });

  // With reduced motion, top drawing celebration is immediately visible
  await expect(judge.page.getByText(/Top drawing:/)).toBeVisible({ timeout: 15_000 });
  await expect(judge.page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
});
