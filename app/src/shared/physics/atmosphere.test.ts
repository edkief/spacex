/**
 * TASK-28: the shared atmosphere boundary math — the ONE number that drives
 * both the physics drag ramp and the skybox/dome crossfade. Blend factor
 * math, per-planet density scaling, and the continuity contract.
 */
import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE_BOUNDARY_M,
  ATMOSPHERE_REF_DENSITY,
  boundaryFactor,
  densityScale,
  hazeFactor,
  reentryTintFactor,
  REENTRY_TINT_MAX,
  REENTRY_TINT_RAMP,
  REENTRY_TINT_SPEED,
} from './atmosphere';

const P = { atmosphereRadius: ATMOSPHERE_BOUNDARY_M, atmosphereDensity: 0.1 };

describe('boundaryFactor (shared drag-ramp + haze driver)', () => {
  it('is 1 at the surface and 0 at/above the enter radius', () => {
    expect(boundaryFactor(-1000, P)).toBe(1);
    expect(boundaryFactor(0, P)).toBe(1);
    expect(boundaryFactor(ATMOSPHERE_BOUNDARY_M, P)).toBe(0);
    expect(boundaryFactor(10_000, P)).toBe(0);
  });

  it('ramps linearly across the 1 km band (the same band the visuals blend over)', () => {
    for (let alt = 0; alt <= ATMOSPHERE_BOUNDARY_M; alt += 125) {
      expect(boundaryFactor(alt, P)).toBeCloseTo(1 - alt / ATMOSPHERE_BOUNDARY_M, 12);
    }
  });

  it('airless planets have no boundary (0 everywhere)', () => {
    expect(boundaryFactor(0, { atmosphereRadius: 0 })).toBe(0);
    expect(boundaryFactor(500, { atmosphereRadius: 0 })).toBe(0);
  });
});

describe('hazeFactor (skybox → dome blend)', () => {
  it('0 in space, full boundary haze at the surface, linear in between', () => {
    // density 0.1 = reference density → scale 1 → haze === boundaryFactor
    expect(hazeFactor(2000, P)).toBe(0); // in space: pure skybox
    expect(hazeFactor(0, P)).toBe(1); // at the surface: full dome
    expect(hazeFactor(ATMOSPHERE_BOUNDARY_M / 2, P)).toBeCloseTo(0.5, 12);
  });

  it('scales with planet.atmosphereDensity (thin atmospheres are visibly less hazy)', () => {
    const thin = { atmosphereRadius: ATMOSPHERE_BOUNDARY_M, atmosphereDensity: 0.02 };
    const thick = { atmosphereRadius: ATMOSPHERE_BOUNDARY_M, atmosphereDensity: 0.2 };
    const mid = ATMOSPHERE_BOUNDARY_M / 2;
    expect(hazeFactor(mid, thin)).toBeCloseTo(0.5 * 0.2, 12); // 20% of thick
    expect(hazeFactor(mid, thick)).toBeCloseTo(0.5, 12); // clamped at full
    // two planets at mid-boundary differ by > 20% (the render-test contract)
    const diff = Math.abs(hazeFactor(mid, thin) - hazeFactor(mid, thick));
    expect(diff / Math.max(hazeFactor(mid, thin), hazeFactor(mid, thick))).toBeGreaterThan(0.2);
  });

  it('densityScale clamps to [0, 1] and rejects junk', () => {
    expect(densityScale(0)).toBe(0);
    expect(densityScale(-1)).toBe(0);
    expect(densityScale(Number.NaN)).toBe(0);
    expect(densityScale(ATMOSPHERE_REF_DENSITY)).toBe(1);
    expect(densityScale(1)).toBe(1);
    expect(densityScale(0.05)).toBeCloseTo(0.5, 12);
  });
});

describe('reentryTintFactor (cosmetic only — heating is NOT simulated in v1)', () => {
  it('ramps above the 200 u/s descent threshold, scales with the band, caps at MAX', () => {
    expect(reentryTintFactor(REENTRY_TINT_SPEED, 1)).toBe(0);
    expect(reentryTintFactor(REENTRY_TINT_SPEED + REENTRY_TINT_RAMP, 1)).toBeCloseTo(
      REENTRY_TINT_MAX,
      12,
    );
    expect(reentryTintFactor(REENTRY_TINT_SPEED + 1000, 1)).toBeCloseTo(REENTRY_TINT_MAX, 12);
    expect(reentryTintFactor(REENTRY_TINT_SPEED + REENTRY_TINT_RAMP, 0.5)).toBeCloseTo(
      REENTRY_TINT_MAX / 2,
      12,
    );
  });

  it('never tints in space or below the threshold', () => {
    expect(reentryTintFactor(500, 0)).toBe(0);
    expect(reentryTintFactor(500, 0.0001)).toBeGreaterThan(0); // inside the band: yes
    expect(reentryTintFactor(199.9, 1)).toBe(0);
    expect(reentryTintFactor(0, 1)).toBe(0); // not descending
  });
});
