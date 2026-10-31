import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";

const tokensCss = readFileSync(new URL("tokens.css", import.meta.url), "utf8");

function token(name: string): string {
  const hex = new RegExp(`${name}:\\s*#([0-9a-f]{6})`, "i").exec(tokensCss)?.[1];

  if (hex === undefined) throw new Error(`token ${name} is not a hex colour`);

  return hex;
}

function luminance(hex: string): number {
  const [red, green, blue] = [0, 2, 4].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;

    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("given the colour tokens", () => {
  it("makes text on the accent readable (WCAG AA, 4.5:1)", () => {
    expect(contrast(token("--bg"), token("--accent"))).toBeGreaterThanOrEqual(4.5);
  });
});
