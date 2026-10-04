/**
 * TASK-54 step 4: the token-pair contrast test. Every text/background
 * design-token pair must meet WCAG AA (4.5:1) for normal text.
 */
import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio, relativeLuminance, TOKEN_PAIRS } from './theme';

describe('WCAG AA contrast of the design tokens', () => {
  it('computes the canonical reference ratios', () => {
    // Black on white is exactly 21:1 by definition.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    // A color against itself is exactly 1:1.
    expect(contrastRatio('#d6deeb', '#d6deeb')).toBeCloseTo(1, 5);
    // Luminance bounds: black = 0, white = 1.
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    // The ratio is symmetric.
    expect(contrastRatio('#123456', '#67e8f9')).toBeCloseTo(contrastRatio('#67e8f9', '#123456'), 5);
  });

  it('every token pair passes AA (4.5:1) for normal text', () => {
    expect(TOKEN_PAIRS.length).toBeGreaterThan(0);
    for (const pair of TOKEN_PAIRS) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(
        ratio,
        `${pair.name} (${pair.fg} on ${pair.bg}) = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});
