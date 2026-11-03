/**
 * Bounded scanline flood fill on raw RGBA pixel data. Pure (no DOM) so it is
 * deterministic and testable; the renderer feeds it ImageData.
 * Returns the number of pixels filled.
 */
export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  fill: [number, number, number, number],
  tolerance = 48,
): number {
  const sx = Math.floor(startX);
  const sy = Math.floor(startY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return 0;

  const idx = (sy * width + sx) * 4;
  const target = [data[idx]!, data[idx + 1]!, data[idx + 2]!, data[idx + 3]!] as const;
  const same =
    Math.abs(target[0] - fill[0]) <= 2 &&
    Math.abs(target[1] - fill[1]) <= 2 &&
    Math.abs(target[2] - fill[2]) <= 2 &&
    Math.abs(target[3] - fill[3]) <= 2;
  if (same) return 0;

  const visited = new Uint8Array(width * height);
  const matches = (p: number) => {
    if (visited[p]) return false;
    const i = p * 4;
    return (
      Math.abs(data[i]! - target[0]) <= tolerance &&
      Math.abs(data[i + 1]! - target[1]) <= tolerance &&
      Math.abs(data[i + 2]! - target[2]) <= tolerance &&
      Math.abs(data[i + 3]! - target[3]) <= tolerance
    );
  };
  const paint = (p: number) => {
    visited[p] = 1;
    const i = p * 4;
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  };

  let filled = 0;
  const stack: number[] = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let p = y * width + x;
    while (x > 0 && matches(p - 1)) {
      x--;
      p--;
    }
    let spanUp = false;
    let spanDown = false;
    while (x < width && matches(p)) {
      paint(p);
      filled++;
      if (y > 0) {
        const up = matches(p - width);
        if (up && !spanUp) stack.push(x, y - 1);
        spanUp = up;
      }
      if (y < height - 1) {
        const down = matches(p + width);
        if (down && !spanDown) stack.push(x, y + 1);
        spanDown = down;
      }
      x++;
      p++;
    }
  }
  return filled;
}

export function hexToRgba(hex: string): [number, number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
