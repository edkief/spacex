/**
 * WCAG contrast math — TASK-54.
 *
 * Pure helpers so the contrast test can assert the design tokens
 * clear WCAG AA without a browser. The formulas follow the WCAG
 * 2.x "relative luminance" definition:
 *
 *   c = channel / 255
 *   c_lin = c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
 *   L = 0.2126 R + 0.7152 G + 0.0722 B
 *   ratio = (L_light + 0.05) / (L_dark + 0.05)
 */

/** Parse a `#rrggbb` / `#rgb` hex string into 0-255 channels. */
export function parseHex(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, "");
  if (raw.length === 3) {
    const r = raw[0]!;
    const g = raw[1]!;
    const b = raw[2]!;
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  if (raw.length !== 6) throw new Error(`not a hex colour: ${hex}`);
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

/** Linearise one 0-255 sRGB channel. */
function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The WCAG relative luminance of a hex colour (0 → black, 1 → white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/**
 * The WCAG contrast ratio between two hex colours.
 *
 * Always ≥ 1 (the ratio is symmetric — the lighter colour is
 * always the numerator).
 */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/** Round a ratio to two decimals (for readable assertions/messages). */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}
