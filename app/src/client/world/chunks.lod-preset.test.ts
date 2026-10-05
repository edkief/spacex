/**
 * TASK-55: the quality preset re-tunes the streaming pipeline LIVE (the
 * SettingsBridge) — setLodRadii re-points the ring classifier (no re-init:
 * new generations use the new radii) and existing FULL chunks keep their
 * built LOD (never downgraded to the impostor quad — no pop).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { lodRadiiFor, type QualityPreset } from '@shared/settings';
import {
  chunkOfMeters,
  keepBuiltLod,
  lodRingForDistance,
  lodRadii,
  setLodRadii,
} from '@client/world/chunks';

const DEFAULT_RADII = lodRadiiFor('high');

afterEach(() => setLodRadii(DEFAULT_RADII));

describe('live LOD radii (setLodRadii)', () => {
  it('starts at the high-preset defaults (the pipeline original)', () => {
    expect(lodRadii()).toEqual({ nearMaxM: 512, midMaxM: 2048, farMaxM: 8000 });
    expect(lodRingForDistance(1000)).toBe('mid');
    expect(lodRingForDistance(6000)).toBe('far');
    expect(lodRingForDistance(9000)).toBe('none');
  });

  it('a preset change re-classifies distances on the NEXT read (no re-init)', () => {
    // 5 000 m from the player: 'far' under high (≤ 8 km), 'none' under low
    // (the 4 km draw distance) — the horizon shrinks live.
    expect(lodRingForDistance(5000)).toBe('far');
    setLodRadii(lodRadiiFor('low'));
    expect(lodRingForDistance(5000)).toBe('none');
    // 1 200 m: 'mid' under high (≤ 2048 m), 'far' under low (mid ends at 1024).
    expect(lodRingForDistance(1200)).toBe('far');
    // The far boundary IS the draw distance (4 km on low).
    expect(lodRingForDistance(3999)).toBe('far');
    expect(lodRingForDistance(4001)).toBe('none');
    // Switching back re-classifies again — the radii are a live ref.
    setLodRadii(lodRadiiFor('high'));
    expect(lodRingForDistance(5000)).toBe('far');
    expect(lodRingForDistance(1200)).toBe('mid');
    expect(lodRadii()).toEqual(DEFAULT_RADII);
  });

  it('every preset classifies its own boundaries correctly', () => {
    for (const preset of ['high', 'medium', 'low'] as QualityPreset[]) {
      const r = lodRadiiFor(preset);
      setLodRadii(r);
      expect(lodRingForDistance(r.nearMaxM)).toBe('near');
      expect(lodRingForDistance(r.nearMaxM + 1)).not.toBe('near');
      expect(lodRingForDistance(r.midMaxM)).toBe('mid');
      expect(lodRingForDistance(r.farMaxM)).toBe('far');
      expect(lodRingForDistance(r.farMaxM + 1)).toBe('none');
    }
  });
});

describe('keepBuiltLod (existing chunks keep their LOD until regenerated)', () => {
  it('a FULL build re-classified into the far ring keeps at least mid (no impostor pop)', () => {
    const full = { geometries: { near: {}, mid: {}, far: {} } };
    expect(keepBuiltLod(full, 'far')).toBe('mid');
    expect(keepBuiltLod(full, 'near')).toBe('near');
    expect(keepBuiltLod(full, 'mid')).toBe('mid');
  });

  it('an impostor-only entry (no mid geometry) is unaffected — stays far', () => {
    const impostor = { geometries: { near: null, mid: null, far: {} } };
    expect(keepBuiltLod(impostor, 'far')).toBe('far');
  });

  it('chunkOfMeters is untouched by the live radii (the grid is fixed)', () => {
    expect(chunkOfMeters(100)).toBe(0);
    expect(chunkOfMeters(320)).toBe(1);
  });
});
