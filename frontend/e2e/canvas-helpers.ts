import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

export async function renderedCanvasHash(canvas: Locator): Promise<string> {
  await expect(canvas).toBeVisible();
  return canvas.evaluate(async (element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("Expected a canvas element.");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("The browser did not provide a 2D canvas context.");
    const rgba = context.getImageData(0, 0, element.width, element.height).data;
    const digest = await crypto.subtle.digest("SHA-256", rgba);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });
}

export async function canvasInkPixelCount(canvas: Locator): Promise<number> {
  await expect(canvas).toBeVisible();
  return canvas.evaluate(async (element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("Expected a canvas element.");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("The browser did not provide a 2D canvas context.");
    const rgba = context.getImageData(0, 0, element.width, element.height).data;
    let ink = 0;
    for (let index = 0; index < rgba.length; index += 4) {
      if (rgba[index] !== 255 || rgba[index + 1] !== 255 || rgba[index + 2] !== 255) ink++;
    }
    return ink;
  });
}

export async function canvasPixel(
  canvas: Locator,
  point: readonly [number, number],
): Promise<readonly [number, number, number, number]> {
  await expect(canvas).toBeVisible();
  return canvas.evaluate(async (element, [xRatio, yRatio]) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("Expected a canvas element.");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("The browser did not provide a 2D canvas context.");
    const x = Math.min(element.width - 1, Math.max(0, Math.floor(element.width * xRatio)));
    const y = Math.min(element.height - 1, Math.max(0, Math.floor(element.height * yRatio)));
    return [...context.getImageData(x, y, 1, 1).data] as [number, number, number, number];
  }, point);
}

export async function clickCanvas(page: Page, point: readonly [number, number]): Promise<void> {
  const canvas = page.getByLabel("Your canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Artist canvas has no bounding box.");
  await canvas.click({
    position: { x: box.width * point[0], y: box.height * point[1] },
  });
}

export async function drawCanvasStroke(
  page: Page,
  start: readonly [number, number] = [0.05, 0.07],
  end: readonly [number, number] = [0.15, 0.18],
): Promise<void> {
  const canvas = page.getByLabel("Your canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Artist canvas has no bounding box.");
  await page.mouse.move(box.x + box.width * start[0], box.y + box.height * start[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * end[0], box.y + box.height * end[1], { steps: 8 });
  await page.mouse.up();
}
