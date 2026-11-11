import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { io } from "socket.io-client";

const publicOrigin = process.env["CONTAINER_SMOKE_ORIGIN"] ?? "http://127.0.0.1:8080";

async function verifyHealth() {
  const response = await fetch(`${publicOrigin}/health`);
  assert.equal(response.status, 200, "The container health endpoint did not return HTTP 200.");
  assert.deepEqual(await response.json(), { status: "ready" });
}

async function verifyWebSocket() {
  const socket = io(publicOrigin, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket connection timed out.")), 5_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(socket.io.engine.transport.name, "websocket");
  } finally {
    socket.disconnect();
  }
}

async function waitForHydration(page) {
  const input = page.getByLabel("Your name");
  await input.waitFor({ state: "visible" });
  const element = await input.elementHandle();
  assert.ok(element, "The name input disappeared before hydration.");
  await page.waitForFunction(
    (candidate) => Object.keys(candidate).some((key) => key.startsWith("__reactProps$")),
    element,
    { timeout: 15_000 },
  );
}

async function main() {
  await verifyHealth();
  await verifyWebSocket();

  if (process.argv.includes("--websocket-only")) {
    console.log(`Health and forced WebSocket checks passed through ${publicOrigin}.`);
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const homeResponse = await host.goto(publicOrigin);
    assert.equal(homeResponse?.status(), 200, "The SPA home route did not load.");
    await waitForHydration(host);
    await host.getByLabel("Your name").fill("Container Host");
    await host.getByRole("button", { name: /Create a room/ }).click();
    await host.waitForURL(/\/room\/[A-Z0-9]{5,6}$/);
    await host.getByRole("heading", { name: "Players" }).waitFor();

    const code = new URL(host.url()).pathname.split("/").at(-1);
    assert.match(code, /^[A-Z0-9]{5,6}$/);
    const guest = await guestContext.newPage();
    const inviteResponse = await guest.goto(`${publicOrigin}/room/${code}`);
    assert.equal(inviteResponse?.status(), 200, "The direct invite route did not return the SPA shell.");
    await waitForHydration(guest);
    await guest.reload();
    await waitForHydration(guest);
    await guest.getByLabel("Your name").fill("Container Guest");
    await guest.getByRole("button", { name: "Join room" }).click();
    await guest.getByRole("heading", { name: "Players" }).waitFor();

    for (const page of [host, guest]) {
      await page.getByRole("listitem").filter({ hasText: "Container Host" }).waitFor();
      await page.getByRole("listitem").filter({ hasText: "Container Guest" }).waitFor();
    }
    console.log(`Single-container browser smoke passed through ${publicOrigin}.`);
  } finally {
    await hostContext.close();
    await guestContext.close();
    await browser.close();
  }
}

await main();
