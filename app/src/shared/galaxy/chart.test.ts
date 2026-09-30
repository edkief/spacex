import { describe, expect, it } from 'vitest';
import {
  CHART_SYSTEM_COUNT,
  CHART_VIEWBOX,
  GALACTIC_UNIT_LIGHT_SECONDS,
  formatLightSeconds,
  formatWarpTime,
  galaxyChart,
  systemIdForStar,
  warpTimeSeconds,
  WARP_SPEED_LS_PER_S,
} from './chart.js';
import { generateStars } from './stars.js';

const SEED = 'DRIFT-SEED-0001';

/** A real home system id (star index 3 of the default galaxy). */
const HOME_SYSTEM_ID = systemIdForStar(SEED, generateStars(SEED)[3].id);

describe('travel table (TASK-7)', () => {
  it('computes warp time from the distance in light-seconds', () => {
    // 100 gu * 60 000 ls/gu / 100 000 ls/s = 60 s.
    expect(warpTimeSeconds(100)).toBe(60);
    // 1 gu = 60 000 ls → 0.6 s, ceiled to the 1 s floor.
    expect(warpTimeSeconds(1)).toBe(1);
    expect(warpTimeSeconds(0)).toBe(1);
  });

  it('formats light-second distances compactly', () => {
    expect(formatLightSeconds(500)).toBe('500 ls');
    expect(formatLightSeconds(2_500)).toBe('2.5k ls');
    expect(formatLightSeconds(3_200_000)).toBe('3.2M ls');
    expect(formatLightSeconds(1_400_000_000)).toBe('1.4B ls');
  });

  it('formats warp times compactly', () => {
    expect(formatWarpTime(0)).toBe('0s');
    expect(formatWarpTime(45)).toBe('45s');
    expect(formatWarpTime(60)).toBe('1m 0s');
    expect(formatWarpTime(125)).toBe('2m 5s');
    expect(formatWarpTime(3725)).toBe('1h 2m');
  });
});

describe('galaxyChart (TASK-7)', () => {
  it('returns exactly CHART_SYSTEM_COUNT systems including the home system', () => {
    const chart = galaxyChart(SEED, HOME_SYSTEM_ID);
    expect(chart).toHaveLength(CHART_SYSTEM_COUNT);
    expect(chart.map((s) => s.systemId)).toContain(HOME_SYSTEM_ID);
    expect(new Set(chart.map((s) => s.systemId)).size).toBe(CHART_SYSTEM_COUNT);
  });

  it('is deterministic: same (seed, home) → deep-equal charts', () => {
    expect(galaxyChart(SEED, HOME_SYSTEM_ID)).toEqual(galaxyChart(SEED, HOME_SYSTEM_ID));
  });

  it('differs for a different seed', () => {
    const a = galaxyChart(SEED, HOME_SYSTEM_ID);
    const b = galaxyChart('OTHER-SEED', HOME_SYSTEM_ID);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it('is deterministic for an unknown home id (falls back to star 0)', () => {
    const a = galaxyChart(SEED, 'deadbeefdeadbeef');
    expect(a).toHaveLength(CHART_SYSTEM_COUNT);
    expect(a).toEqual(galaxyChart(SEED, 'deadbeefdeadbeef'));
    const star0 = generateStars(SEED)[0];
    expect(a[0].systemId).toBe(systemIdForStar(SEED, star0.id));
  });

  it('has symmetric edges with consistent travel labels', () => {
    const chart = galaxyChart(SEED, HOME_SYSTEM_ID);
    for (const system of chart) {
      expect(system.neighbors).toHaveLength(CHART_SYSTEM_COUNT - 1);
      for (const n of system.neighbors) {
        const other = chart.find((s) => s.systemId === n.to);
        expect(other, `missing neighbour ${n.to}`).toBeDefined();
        const back = other!.neighbors.find((s) => s.to === system.systemId)!;
        expect(back.distanceGu).toBeCloseTo(n.distanceGu, 10);
        // Labels must agree with the travel table.
        expect(n.distanceLabel).toBe(
          formatLightSeconds(n.distanceGu * GALACTIC_UNIT_LIGHT_SECONDS),
        );
        expect(n.warpTimeSeconds).toBe(warpTimeSeconds(n.distanceGu));
        expect(n.warpTimeLabel).toBe(formatWarpTime(n.warpTimeSeconds));
        expect(n.warpTimeSeconds).toBeGreaterThan(0);
      }
    }
  });

  it('projects every node inside the 800x500 viewbox (with margin)', () => {
    const chart = galaxyChart(SEED, HOME_SYSTEM_ID);
    for (const s of chart) {
      expect(s.pos2D.x).toBeGreaterThanOrEqual(CHART_VIEWBOX.margin - 0.01);
      expect(s.pos2D.x).toBeLessThanOrEqual(CHART_VIEWBOX.width - CHART_VIEWBOX.margin + 0.01);
      expect(s.pos2D.y).toBeGreaterThanOrEqual(CHART_VIEWBOX.margin - 0.01);
      expect(s.pos2D.y).toBeLessThanOrEqual(CHART_VIEWBOX.height - CHART_VIEWBOX.margin + 0.01);
    }
  });

  it('carries star identity (name, class, star id) from the star generator', () => {
    const chart = galaxyChart(SEED, HOME_SYSTEM_ID);
    const stars = new Map(generateStars(SEED).map((s) => [s.id, s]));
    for (const s of chart) {
      const star = stars.get(s.starId);
      expect(star, `unknown star ${s.starId}`).toBeDefined();
      expect(s.name).toBe(star!.name);
      expect(s.starClass).toBe(star!.class);
      expect(s.systemId).toBe(systemIdForStar(SEED, s.starId));
    }
  });

  it('warp speed constant is part of the travel table', () => {
    expect(WARP_SPEED_LS_PER_S).toBeGreaterThan(0);
    // sanity: 1 gu is 60 000 ls, so 1 gu at warp speed is < 1 s → floored to 1 s
    expect(warpTimeSeconds(1)).toBe(
      Math.ceil((1 * GALACTIC_UNIT_LIGHT_SECONDS) / WARP_SPEED_LS_PER_S),
    );
  });
});
