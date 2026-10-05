/**
 * TASK-59: the mobile rendering floor — the profile row (spec numbers
 * verbatim), the detection heuristic (fake navigator values), the
 * effective-profile resolution (override beats detection), and the
 * schema test: the perf table carries NO gameplay fields.
 */
import { describe, expect, it } from 'vitest';

import {
  detectProfile,
  effectiveDeviceProfile,
  PERF_PROFILES,
  PERF_PROFILE_RENDERING_KEYS,
  perfProfileFor,
  type PerfProfileKey,
} from './perf';

describe('mobile profile row (AC-1, spec numbers verbatim)', () => {
  const m = PERF_PROFILES.mobile;

  it('draw distance 3 km (near ring = the 3x3 core, mid to 3 km, no far ring)', () => {
    expect(m.lodRadii).toEqual({ nearMaxM: 512, midMaxM: 3_000, farMaxM: 3_000 });
  });

  it('starCount 2000', () => {
    expect(m.starCount).toBe(2000);
  });

  it('fxQuality 0.3', () => {
    expect(m.fxQuality).toBe(0.3);
  });

  it('labels max 8', () => {
    expect(m.maxLabels).toBe(8);
  });

  it('no atmosphere dome shader (flat color haze instead)', () => {
    expect(m.atmosphereDome).toBe(false);
  });

  it('missile trails off (a single dot instead of a ribbon)', () => {
    expect(m.missileTrails).toBe(false);
  });

  it('desktop presets keep the full rendering contract', () => {
    for (const key of ['high', 'medium', 'low'] as PerfProfileKey[]) {
      expect(PERF_PROFILES[key].atmosphereDome).toBe(true);
      expect(PERF_PROFILES[key].missileTrails).toBe(true);
    }
  });

  it('the tracer cap never drops below the server shard budget (16)', () => {
    expect(m.fxCaps.missiles).toBe(16);
  });

  it('perfProfileFor resolves the mobile row', () => {
    expect(perfProfileFor('mobile').starCount).toBe(2000);
    expect(perfProfileFor('high').starCount).not.toBe(2000);
  });
});

describe('detectProfile (the navigator heuristic — fake values)', () => {
  it('no touch → desktop (regardless of memory/cores)', () => {
    expect(detectProfile({ maxTouchPoints: 0, deviceMemory: 4, hardwareConcurrency: 4 })).toBe(
      'desktop',
    );
  });

  it('touch + low memory (≤ 8 GB) → mobile', () => {
    expect(detectProfile({ maxTouchPoints: 5, deviceMemory: 8, hardwareConcurrency: 8 })).toBe(
      'mobile',
    );
    expect(detectProfile({ maxTouchPoints: 1, deviceMemory: 4, hardwareConcurrency: 16 })).toBe(
      'mobile',
    );
  });

  it('touch + few cores (≤ 4) → mobile', () => {
    expect(detectProfile({ maxTouchPoints: 5, deviceMemory: 16, hardwareConcurrency: 4 })).toBe(
      'mobile',
    );
  });

  it('touch + 8+ GB AND 5+ cores → desktop (a high-end touch laptop)', () => {
    expect(detectProfile({ maxTouchPoints: 5, deviceMemory: 16, hardwareConcurrency: 16 })).toBe(
      'desktop',
    );
  });

  it('missing deviceMemory fails that branch (cores decide)', () => {
    expect(detectProfile({ maxTouchPoints: 5, hardwareConcurrency: 3 })).toBe('mobile');
    expect(detectProfile({ maxTouchPoints: 5, hardwareConcurrency: 8 })).toBe('desktop');
  });

  it('a fully empty navigator → desktop (nothing proves it is a phone)', () => {
    expect(detectProfile({})).toBe('desktop');
  });
});

describe('effectiveDeviceProfile (override beats detection)', () => {
  const phone = { maxTouchPoints: 5, deviceMemory: 6, hardwareConcurrency: 4 };
  const desktop = { maxTouchPoints: 0, deviceMemory: 32, hardwareConcurrency: 16 };

  it('auto → the detection result', () => {
    expect(effectiveDeviceProfile('auto', phone)).toBe('mobile');
    expect(effectiveDeviceProfile('auto', desktop)).toBe('desktop');
  });

  it('a manual override wins in both directions', () => {
    expect(effectiveDeviceProfile('desktop', phone)).toBe('desktop');
    expect(effectiveDeviceProfile('mobile', desktop)).toBe('mobile');
  });
});

describe('schema: the perf table is a pure rendering profile (AC-5)', () => {
  it('every entry carries ONLY the rendering keys', () => {
    const allowed = new Set<string>(PERF_PROFILE_RENDERING_KEYS);
    for (const [name, profile] of Object.entries(PERF_PROFILES)) {
      const keys = Object.keys(profile);
      const foreign = keys.filter((k) => !allowed.has(k));
      expect(foreign, `profile '${name}' carries non-rendering keys`).toEqual([]);
      expect(keys.length, `profile '${name}' lost a rendering key`).toBe(allowed.size);
    }
  });

  it('no gameplay field can be hiding under a name (damage / range / speed / …)', () => {
    const gameplay =
      /damage|range|speed|hull|shield|armor|health|credits|price|damageRate|fireRate/i;
    for (const [name, profile] of Object.entries(PERF_PROFILES)) {
      for (const key of Object.keys(profile)) {
        expect(gameplay.test(key), `profile '${name}' key '${key}' looks like gameplay`).toBe(
          false,
        );
      }
    }
  });
});
