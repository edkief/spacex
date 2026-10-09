// TASK-54: the reduced-motion setting — the client store, the FX gate
// (the registry counter exposes the skip count: with the flag on, FX
// counts are played == 0 / skipped > 0), and the shared defaults.
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTING_KEYS } from '@shared/settings';
import {
  __resetSettings,
  applySettings,
  deviceProfileChangeSubscribe,
  effectiveProfile,
  effectiveProfileKey,
  isReducedMotion,
  setDeviceProfile,
  setDetectedProfile,
  setSetting,
  setTouchControls,
  settingsState,
  settingsSubscribe,
} from './reduced-motion';
import {
  __resetFxCounts,
  fxCounts,
  playCombatFx,
  type CombatEvent,
  type FxWorld,
} from '@client/fx';
import type { Vec3 } from '@shared/physics/vec';

/** A recording FX world (counts every effect call). */
function recordingWorld(): FxWorld & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    addLaserFlash: () => calls.push('laser'),
    addImpactFlash: () => calls.push('impact'),
    addExplosion: () => calls.push('explosion'),
    screenShake: (px) => calls.push(`shake:${px}`),
  };
}

const NO_POS = () => null;
const P0: Vec3 = { x: 0, y: 0, z: 0 };
const ALWAYS = () => P0;

afterEach(() => {
  __resetSettings();
  __resetFxCounts();
});

describe('settings store (TASK-54 reduced motion)', () => {
  it('defaults to OFF per the shared defaults', () => {
    expect(DEFAULT_SETTINGS[SETTING_KEYS.reducedMotion]).toBe(false);
    expect(isReducedMotion()).toBe(false);
  });

  it('flips immediately and notifies subscribers (no restart)', () => {
    const seen: boolean[] = [];
    const unsub = settingsSubscribe((s) => seen.push(s['reduced-motion']));
    setSetting(SETTING_KEYS.reducedMotion, true);
    expect(isReducedMotion()).toBe(true);
    expect(seen).toEqual([true]);
    setSetting(SETTING_KEYS.reducedMotion, false);
    expect(seen).toEqual([true, false]);
    setSetting(SETTING_KEYS.reducedMotion, false); // no-op: no duplicate emit
    expect(seen).toEqual([true, false]);
    unsub();
    setSetting(SETTING_KEYS.reducedMotion, true);
    expect(seen).toEqual([true, false]); // unsubscribed
  });

  it('never hands out a mutable reference', () => {
    const a = settingsState();
    a['reduced-motion'] = true;
    expect(isReducedMotion()).toBe(false);
  });
});

describe('the reduced-motion FX gate (the registry counter)', () => {
  const LASER: CombatEvent = {
    kind: 'laser-fired',
    source: { kind: 'player', id: 'p' },
    weapon: 'laser',
    from: P0,
    to: P0,
  };
  const IMPACT: CombatEvent = {
    kind: 'missile-impact',
    weapon: 'missile',
    projectile: 'proj-1',
    point: P0,
  };

  it('plays every effect by default', () => {
    const world = recordingWorld();
    playCombatFx(world, LASER, NO_POS);
    playCombatFx(world, IMPACT, NO_POS);
    playCombatFx(
      world,
      {
        kind: 'hit',
        target: 't',
        source: { kind: 'player', id: 'p' },
        weapon: 'laser',
        damage: 1,
        shieldHit: 1,
        hullHit: 0,
      },
      ALWAYS,
    );
    playCombatFx(
      world,
      { kind: 'destroyed', target: 't', source: { kind: 'player', id: 'p' }, weapon: 'missile' },
      ALWAYS,
    );
    // laser(1) + missile-impact(2: flash + shake) + hit(1) + destroyed(2: boom + shake)
    expect(fxCounts).toEqual({ played: 6, skipped: 0 });
    expect(world.calls).toContain('explosion');
    expect(world.calls).toContain('shake:6');
  });

  it('skips ALL FX when reduced motion is on (FX count = 0, skip counter exposed)', () => {
    setSetting(SETTING_KEYS.reducedMotion, true);
    const world = recordingWorld();
    playCombatFx(world, LASER, NO_POS);
    playCombatFx(world, IMPACT, NO_POS);
    playCombatFx(
      world,
      {
        kind: 'hit',
        target: 't',
        source: { kind: 'player', id: 'p' },
        weapon: 'laser',
        damage: 1,
        shieldHit: 1,
        hullHit: 0,
      },
      ALWAYS,
    );
    playCombatFx(
      world,
      { kind: 'destroyed', target: 't', source: { kind: 'player', id: 'p' }, weapon: 'missile' },
      ALWAYS,
    );
    expect(world.calls).toEqual([]); // shake, slow-mo (in explosion), particles: zero
    expect(fxCounts.played).toBe(0);
    expect(fxCounts.skipped).toBe(6);
  });

  it('resumes playing when the toggle flips back off', () => {
    setSetting(SETTING_KEYS.reducedMotion, true);
    const world = recordingWorld();
    playCombatFx(world, LASER, NO_POS);
    setSetting(SETTING_KEYS.reducedMotion, false);
    playCombatFx(world, LASER, NO_POS);
    expect(fxCounts).toEqual({ played: 1, skipped: 1 });
    expect(world.calls).toEqual(['laser']);
  });
});

describe('device profile (TASK-59): detection, override, user-change bus', () => {
  it('defaults: auto + desktop detection → desktop key', () => {
    expect(settingsState().deviceProfile).toBe('auto');
    expect(effectiveProfile()).toBe('desktop');
    expect(effectiveProfileKey()).toBe('high');
  });

  it('auto resolves to the detected profile; mobile replaces the preset key', () => {
    setDetectedProfile('mobile');
    expect(effectiveProfile()).toBe('mobile');
    expect(effectiveProfileKey()).toBe('mobile');
  });

  it('a manual override beats the detection (both directions)', () => {
    setDetectedProfile('mobile');
    setDeviceProfile('desktop');
    expect(effectiveProfile()).toBe('desktop');
    expect(effectiveProfileKey()).toBe('high'); // the quality preset wins again
    setDeviceProfile('mobile');
    expect(effectiveProfileKey()).toBe('mobile');
  });

  it('setDeviceProfile fires the user-change bus once (no-op when unchanged)', () => {
    const changes: string[] = [];
    const off = deviceProfileChangeSubscribe((c) => changes.push(c));
    setDeviceProfile('mobile');
    setDeviceProfile('mobile'); // unchanged → no second notify
    setDeviceProfile('auto');
    off();
    expect(changes).toEqual(['mobile', 'auto']);
    expect(settingsState().deviceProfile).toBe('auto');
  });

  it('a restored row (applySettings) does NOT fire the user-change bus', () => {
    const changes: string[] = [];
    const off = deviceProfileChangeSubscribe((c) => changes.push(c));
    applySettings({
      quality: 'low',
      deviceProfile: 'mobile',
      sensitivity: 1,
      'reduced-motion': false,
      touchControls: 'auto',
    });
    off();
    expect(changes).toEqual([]); // no re-entry warp from the boot restore
    expect(settingsState().deviceProfile).toBe('mobile');
    expect(effectiveProfileKey()).toBe('mobile');
  });

  it('setTouchControls updates the store (TASK-94) and re-resolves on change', () => {
    expect(settingsState().touchControls).toBe('auto');
    setTouchControls('on');
    expect(settingsState().touchControls).toBe('on');
    const seen: string[] = [];
    const off = settingsSubscribe((s) => seen.push(s.touchControls));
    setTouchControls('off');
    setTouchControls('off'); // unchanged → no second notify
    off();
    expect(seen).toEqual(['off']);
    expect(settingsState().touchControls).toBe('off');
  });
});
