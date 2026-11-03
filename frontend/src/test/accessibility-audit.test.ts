import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appCss = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

type Oklch = readonly [number, number, number];

const declarations = new Map(
  [...appCss.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((match) => [match[1]!, match[2]!.trim()]),
);

function token(name: string): Oklch {
  const value = declarations.get(name);
  if (!value) throw new Error(`Missing color token --${name}`);
  const reference = value.match(/^var\(--([a-z0-9-]+)\)$/i);
  if (reference) return token(reference[1]!);
  const color = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/i);
  if (!color) throw new Error(`Unsupported color token --${name}: ${value}`);
  return [Number(color[1]), Number(color[2]), Number(color[3])];
}

function luminance([lightness, chroma, hue]: Oklch) {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string) {
  const a = luminance(token(foreground));
  const b = luminance(token(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("global accessibility design tokens", () => {
  it.each([
    ["foreground", "background"],
    ["primary-foreground", "primary"],
    ["secondary-foreground", "secondary"],
    ["accent-foreground", "accent"],
    ["muted-foreground", "background"],
    ["destructive-foreground", "destructive"],
  ])("keeps normal text contrast at 4.5:1 for %s on %s", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it("gives every native interactive control a visible keyboard focus fallback", () => {
    expect(appCss).toContain(
      ':where(a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])):focus-visible',
    );
    expect(appCss).toMatch(/outline:\s*3px solid var\(--ink\)/);
  });

  it("removes nonessential animation and motion when reduced motion is requested", () => {
    const reducedMotion = appCss.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1];
    expect(reducedMotion).toContain("animation: none !important");
    expect(reducedMotion).toContain("transition-duration: 0.01ms !important");
    expect(reducedMotion).toContain("scroll-behavior: auto !important");
  });
});
