import { describe, expect, it } from "vitest";
import { floodFill } from "./floodFill";

function blank(w: number, h: number) {
  return new Uint8ClampedArray(w * h * 4).fill(255);
}
function setPx(d: Uint8ClampedArray, w: number, x: number, y: number, c: number[]) {
  d.set(c, (y * w + x) * 4);
}
function px(d: Uint8ClampedArray, w: number, x: number, y: number) {
  return Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
}

describe("floodFill", () => {
  it("fills an enclosed region and stops at borders", () => {
    const w = 10;
    const h = 10;
    const d = blank(w, h);
    // Black square outline from (2,2) to (6,6).
    for (let i = 2; i <= 6; i++) {
      setPx(d, w, i, 2, [0, 0, 0, 255]);
      setPx(d, w, i, 6, [0, 0, 0, 255]);
      setPx(d, w, 2, i, [0, 0, 0, 255]);
      setPx(d, w, 6, i, [0, 0, 0, 255]);
    }
    const filled = floodFill(d, w, h, 4, 4, [255, 0, 0, 255]);
    expect(filled).toBe(9);
    expect(px(d, w, 4, 4)).toEqual([255, 0, 0, 255]);
    expect(px(d, w, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(px(d, w, 2, 2)).toEqual([0, 0, 0, 255]);
  });

  it("is bounded by the canvas and a no-op when colors already match", () => {
    const d = blank(4, 3);
    expect(floodFill(d, 4, 3, 1, 1, [0, 0, 255, 255])).toBe(12);
    expect(floodFill(d, 4, 3, 1, 1, [0, 0, 255, 255])).toBe(0);
    expect(floodFill(d, 4, 3, 99, 1, [1, 2, 3, 255])).toBe(0);
  });

  it("fills an open-edge region without crossing a differently colored boundary", () => {
    const w = 6;
    const h = 4;
    const d = blank(w, h);
    for (let y = 0; y < h; y += 1) setPx(d, w, 3, y, [0, 0, 0, 255]);

    expect(floodFill(d, w, h, 0, 0, [0, 144, 255, 255])).toBe(12);
    expect(px(d, w, 0, 3)).toEqual([0, 144, 255, 255]);
    expect(px(d, w, 3, 2)).toEqual([0, 0, 0, 255]);
    expect(px(d, w, 5, 3)).toEqual([255, 255, 255, 255]);
  });

  it("bounds worst-case work to the complete canvas raster", () => {
    const w = 600;
    const h = 450;
    const d = blank(w, h);

    expect(floodFill(d, w, h, 0, 0, [18, 165, 148, 255])).toBe(w * h);
    expect(px(d, w, 0, 0)).toEqual([18, 165, 148, 255]);
    expect(px(d, w, w - 1, h - 1)).toEqual([18, 165, 148, 255]);
    expect(floodFill(d, w, h, w, h, [255, 0, 0, 255])).toBe(0);
  });
});
