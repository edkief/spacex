/**
 * TASK-55: the quality preset's fxQuality multiplier on the FX spawn rate —
 * each gated effect only fires when the roll beats the multiplier (1.0 =
 * always, 0.3 ≈ 30 %), read LIVE off the settings store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fxCounts, fxSpawnRate, playCombatFx, __resetFxCounts, type FxWorld } from '@client/fx';
import { __resetSettings, setDeviceProfile, setQuality } from '@client/a11y/reduced-motion';

const world: FxWorld = {
  addLaserFlash: () => {},
  addImpactFlash: () => {},
  addExplosion: () => {},
  screenShake: () => {},
};
const resolvePos = () => ({ x: 0, y: 0, z: 0 });
const laserFired = {
  kind: 'laser-fired',
  source: { kind: 'player', id: 'p1' },
  weapon: 'scout-laser',
  from: { x: 0, y: 0, z: 0 },
  to: { x: 1, y: 0, z: 0 },
} as const;

afterEach(() => {
  __resetSettings();
  __resetFxCounts();
  vi.restoreAllMocks();
});

describe('fxQuality spawn-rate multiplier (TASK-55)', () => {
  it('high (1.0): every event plays — the roll always beats 1.0', () => {
    expect(fxSpawnRate()).toBe(1.0);
    playCombatFx(world, laserFired, resolvePos);
    expect(fxCounts.played).toBe(1);
    expect(fxCounts.skipped).toBe(0);
  });

  it('low (0.3): a roll above the multiplier skips (the spawn is dropped)', () => {
    setQuality('low');
    expect(fxSpawnRate()).toBe(0.3);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    playCombatFx(world, laserFired, resolvePos);
    expect(fxCounts.played).toBe(0);
    expect(fxCounts.skipped).toBe(1);
  });

  it('low (0.3): a roll below the multiplier still plays', () => {
    setQuality('low');
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    playCombatFx(world, laserFired, resolvePos);
    expect(fxCounts.played).toBe(1);
    expect(fxCounts.skipped).toBe(0);
  });

  it('medium (0.6): the boundary — the multiplier value itself skips (>= is dropped)', () => {
    setQuality('medium');
    vi.spyOn(Math, 'random').mockReturnValue(0.6);
    playCombatFx(world, laserFired, resolvePos);
    expect(fxCounts.skipped).toBe(1);
  });
});

describe('mobile profile FX rate (TASK-59)', () => {
  it('the mobile floor (0.3) replaces the preset even at high quality', () => {
    setQuality('high');
    setDeviceProfile('mobile');
    expect(fxSpawnRate()).toBe(0.3);
  });

  it('back to auto/desktop the preset rate returns', () => {
    setQuality('high');
    setDeviceProfile('mobile');
    expect(fxSpawnRate()).toBe(0.3);
    setDeviceProfile('desktop');
    expect(fxSpawnRate()).toBe(1.0);
  });
});
