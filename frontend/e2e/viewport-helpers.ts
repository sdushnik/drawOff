import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

export async function setViewport(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  const w = Number(size.width);
  const h = Number(size.height);
  if (!w || !h) {
    throw new Error(`Invalid viewport dimensions: ${size.width}x${size.height}`);
  }
  await page.setViewportSize({ width: w, height: h });
}

export async function assertNoHorizontalScroll(page: Page, contextDescription = ""): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `Horizontal overflow detected ${contextDescription}: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`,
  ).toBeLessThanOrEqual(clientWidth + 1);
}

export async function drawTouchStroke(
  page: Page,
  canvas: Locator,
  startRatio: readonly [number, number] = [0.2, 0.3],
  endRatio: readonly [number, number] = [0.65, 0.55],
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas has no bounding box for touch drawing.");

  const startX = Math.round(box.x + box.width * startRatio[0]);
  const startY = Math.round(box.y + box.height * startRatio[1]);
  const midX = Math.round(box.x + box.width * ((startRatio[0] + endRatio[0]) / 2));
  const midY = Math.round(box.y + box.height * ((startRatio[1] + endRatio[1]) / 2));
  const endX = Math.round(box.x + box.width * endRatio[0]);
  const endY = Math.round(box.y + box.height * endRatio[1]);

  await canvas.dispatchEvent("pointerdown", {
    clientX: startX,
    clientY: startY,
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    bubbles: true,
  });
  await canvas.dispatchEvent("pointermove", {
    clientX: midX,
    clientY: midY,
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    bubbles: true,
  });
  await canvas.dispatchEvent("pointermove", {
    clientX: endX,
    clientY: endY,
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    bubbles: true,
  });
  await canvas.dispatchEvent("pointerup", {
    clientX: endX,
    clientY: endY,
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    bubbles: true,
  });
}
