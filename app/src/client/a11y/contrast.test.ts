/**
 * Contrast test — TASK-54.
 *
 * Asserts every foreground/background pair the UI actually renders
 * clears WCAG AA. The ratios are computed from the design tokens
 * (`src/client/ui/theme.ts`) with the standard WCAG relative
 * luminance formula — no browser needed.
 */
import { describe, expect, it } from "vitest";

import { contrastRatio, parseHex, relativeLuminance, roundRatio } from "./contrast.js";
import { CONTRAST_PAIRS, THEME } from "../ui/theme.js";

describe("contrast helpers", () => {
  it("parses 6-digit and 3-digit hex colours", () => {
    expect(parseHex("#e6edf3")).toEqual([230, 237, 243]);
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("000000")).toEqual([0, 0, 0]);
  });

  it("rejects a malformed hex colour", () => {
    expect(() => parseHex("#12345")).toThrow(/hex/);
  });

  it("computes the known WCAG luminance anchors", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
  });

  it("computes black-on-white as 21:1 and white-on-black as 21:1", () => {
    expect(roundRatio(contrastRatio("#000000", "#ffffff"))).toBe(21);
    expect(roundRatio(contrastRatio("#ffffff", "#000000"))).toBe(21);
  });

  it("is symmetric in its two arguments", () => {
    expect(contrastRatio(THEME.text, THEME.bg)).toBeCloseTo(
      contrastRatio(THEME.bg, THEME.text),
      10,
    );
  });
});

describe("design-token contrast (WCAG AA)", () => {
  it("covers at least 15 token pairs", () => {
    expect(CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(15);
  });

  for (const pair of CONTRAST_PAIRS) {
    it(`${pair.label} (${pair.fg} on ${pair.bg}) clears ${pair.min}:1`, () => {
      const ratio = contrastRatio(THEME[pair.fg], THEME[pair.bg]);
      expect(
        ratio,
        `${pair.fg} (${THEME[pair.fg]}) on ${pair.bg} (${THEME[pair.bg]}) = ${roundRatio(
          ratio,
        )}:1, needs ${pair.min}:1`,
      ).toBeGreaterThanOrEqual(pair.min);
    });
  }
});
