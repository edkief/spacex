import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STAR_COUNT,
  generateStarfield,
  STARFIELD_RADIUS_MAX,
  STARFIELD_RADIUS_MIN,
} from './starfield';

/** Per-channel arraysEqual on flat typed arrays. */
function expectSame(a: Float32Array, b: Float32Array): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
}

describe('generateStarfield', () => {
  it('is bit-identical for the same seed (client/server parity)', () => {
    const a = generateStarfield('DRIFT-SEED-0001');
    const b = generateStarfield('DRIFT-SEED-0001');
    expectSame(a.positions, b.positions);
    expectSame(a.colors, b.colors);
  });

  it('differs for a different seed', () => {
    const a = generateStarfield('DRIFT-SEED-0001');
    const b = generateStarfield('OTHER-SEED');
    let equal = true;
    for (let i = 0; i < a.positions.length; i++) {
      if (a.positions[i] !== b.positions[i] || a.colors[i] !== b.colors[i]) {
        equal = false;
        break;
      }
    }
    expect(equal).toBe(false);
  });

  it('produces exactly `count` stars with full buffers', () => {
    const s = generateStarfield('SEED', 37);
    expect(s.count).toBe(37);
    expect(s.positions.length).toBe(37 * 3);
    expect(s.colors.length).toBe(37 * 3);
    const s2 = generateStarfield('SEED');
    expect(s2.count).toBe(DEFAULT_STAR_COUNT);
  });

  it('places every star on the [RADIUS_MIN, RADIUS_MAX] shell', () => {
    const { positions } = generateStarfield('SEED', 500);
    for (let i = 0; i < 500; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const r = Math.sqrt(x * x + y * y + z * z);
      expect(r).toBeGreaterThanOrEqual(STARFIELD_RADIUS_MIN);
      expect(r).toBeLessThanOrEqual(STARFIELD_RADIUS_MAX);
    }
  });

  it('keeps colors in [0, 1] with real spread (never a flat sky)', () => {
    const { colors } = generateStarfield('SEED', 800);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < colors.length; i++) {
      expect(colors[i]).toBeGreaterThanOrEqual(0);
      expect(colors[i]).toBeLessThanOrEqual(1);
      min = Math.min(min, colors[i]);
      max = Math.max(max, colors[i]);
    }
    // Brightness range is 0.45–1.0 by construction, so 0.3 is a loose bound.
    expect(max - min).toBeGreaterThan(0.3);
  });
});
