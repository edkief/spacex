import { describe, expect, it } from 'vitest';

import { type Regime, type RegimePlanet } from '@shared/regime';
import { RegimeTracker } from './regime';

/** One atmospheric planet at the origin (1 km radius, flat, landable). */
const PLANETS: RegimePlanet[] = [{ id: 'p1', x: 0, z: 0, atmosphereRadius: 1000, landable: true }];
/** Inside the atmosphere, 50 u above the surface (never surface-eligible). */
const INSIDE = { x: 900, y: 50, z: 0 }; // d ≈ 901 < 1000
const OUTSIDE = { x: 2000, y: 0, z: 0 }; // d = 2000 ≥ 1050

describe('RegimeTracker (local prediction vs server authority)', () => {
  it('predicts regime transitions locally (no server yet)', () => {
    const tracker = new RegimeTracker();
    tracker.setPlanets(PLANETS);
    expect(tracker.updateLocal(OUTSIDE, 0, 0)).toBe('space');
    expect(tracker.updateLocal(INSIDE, 0, 50)).toBe('atmosphere');
    expect(tracker.regime).toBe('atmosphere');
    expect(tracker.planetId).toBe('p1');
    expect(tracker.updateLocal(OUTSIDE, 0, 100)).toBe('space');
  });

  it('fires onRegimeChange once per active change', () => {
    const seen: Array<Regime | undefined> = [];
    const tracker = new RegimeTracker({ onRegimeChange: (r) => seen.push(r) });
    tracker.setPlanets(PLANETS);
    tracker.updateLocal(OUTSIDE, 0, 0); // confirms the initial 'space' — not a change: no fire
    tracker.updateLocal(OUTSIDE, 0, 50); // unchanged: no fire
    tracker.updateLocal(INSIDE, 0, 100); // → atmosphere: one fire
    tracker.updateLocal(INSIDE, 0, 150);
    expect(seen).toEqual(['atmosphere']);
  });

  it('divergence test: under 500 ms the LOCAL prediction stays active (no snap, no warn)', () => {
    const tracker = new RegimeTracker();
    const warns: string[] = [];
    tracker.setPlanets(PLANETS);
    tracker.updateLocal(INSIDE, 0, 0); // local: atmosphere (no server yet)
    tracker.applyServer('space', undefined); // server disagrees
    // First diverged frame starts the clock; 400 ms later: still predicting.
    expect(tracker.updateLocal(INSIDE, 0, 100)).toBe('atmosphere');
    expect(tracker.updateLocal(INSIDE, 0, 400)).toBe('atmosphere');
    expect(tracker.divergenceMs(400)).toBe(300);
    expect(warns.length).toBe(0);
  });

  it('divergence test: past 500 ms the client snaps to the server regime with a debug warning', () => {
    const tracker = new RegimeTracker();
    const warns: string[] = [];
    const seen: Array<Regime | undefined> = [];
    const opts = {
      warn: (msg: string) => warns.push(msg),
      onRegimeChange: (r: Regime) => seen.push(r),
    };
    const t2 = new RegimeTracker(opts);
    t2.setPlanets(PLANETS);
    t2.updateLocal(INSIDE, 0, 0); // local: atmosphere
    t2.applyServer('space', undefined);
    expect(t2.updateLocal(INSIDE, 0, 100)).toBe('atmosphere'); // t=100: 0 ms
    expect(t2.updateLocal(INSIDE, 0, 599)).toBe('atmosphere'); // 499 ms: under
    expect(warns.length).toBe(0);
    expect(t2.updateLocal(INSIDE, 0, 600)).toBe('space'); // 500 ms: snap
    expect(warns.length).toBe(1);
    // The snap resets the local regime to the server's; no further warns.
    expect(t2.updateLocal(INSIDE, 0, 700)).toBe('space'); // local re-resolves from 'space'
    expect(warns.length).toBe(1);
    expect(tracker.regime).toBeDefined(); // (tracker unused beyond the type)
    void seen;
  });

  it('returns to local prediction when local and server agree again', () => {
    const tracker = new RegimeTracker();
    tracker.setPlanets(PLANETS);
    tracker.updateLocal(OUTSIDE, 0, 0);
    tracker.applyServer('space', undefined); // agreement
    expect(tracker.divergenceMs(100)).toBeNull();
    // Local diverges…
    tracker.updateLocal(INSIDE, 0, 100); // local atmosphere, server still space
    expect(tracker.divergenceMs(200)).toBe(100);
    // …then the server snapshot catches up: agreement resets the clock.
    tracker.applyServer('atmosphere', 'p1');
    expect(tracker.updateLocal(INSIDE, 0, 300)).toBe('atmosphere');
    expect(tracker.divergenceMs(300)).toBeNull();
  });

  it('server surface vs local atmosphere (flat terrain): follows the server with no clock, no snap, no warning', () => {
    // Server terrain is a plateau: the ship is low relative to the ground
    // (surface), but the client's flat terrain sees alt = 50 (atmosphere).
    const warns: string[] = [];
    const tracker = new RegimeTracker({ warn: (m) => warns.push(m) });
    tracker.setPlanets(PLANETS);
    tracker.updateLocal(INSIDE, 0, 0); // local: atmosphere (from space)
    tracker.applyServer('surface', 'p1');
    // 700 ms of disagreement — far past the 500 ms tolerance: no snap, no warn.
    expect(tracker.updateLocal(INSIDE, 0, 100)).toBe('surface');
    expect(tracker.updateLocal(INSIDE, 0, 700)).toBe('surface');
    expect(tracker.regime).toBe('surface');
    expect(tracker.planetId).toBe('p1');
    expect(tracker.divergenceMs(700)).toBeNull();
    expect(warns.length).toBe(0);
  });

  it('server atmosphere vs local surface (flat terrain): follows the server with no clock, no warning', () => {
    // Server terrain is a valley: the ship is airborne relative to the real
    // ground (atmosphere), but flat terrain sees alt = 1 (surface-eligible).
    const LOW = { x: 900, y: 1, z: 0 };
    const warns: string[] = [];
    const tracker = new RegimeTracker({ warn: (m) => warns.push(m) });
    tracker.setPlanets(PLANETS);
    tracker.updateLocal(LOW, 0, 0); // space → atmosphere (never direct to surface)
    tracker.updateLocal(LOW, 0, 50); // local: surface (alt 1 < 2, slow)
    tracker.applyServer('atmosphere', 'p1');
    expect(tracker.updateLocal(LOW, 0, 600)).toBe('atmosphere');
    expect(tracker.updateLocal(LOW, 0, 900)).toBe('atmosphere');
    expect(tracker.regime).toBe('atmosphere');
    expect(tracker.divergenceMs(900)).toBeNull();
    expect(warns.length).toBe(0);
  });

  it('genuine space/atmosphere divergence still snaps to the server at 500 ms with a warning', () => {
    const warns: string[] = [];
    const tracker = new RegimeTracker({ warn: (m) => warns.push(m) });
    tracker.setPlanets(PLANETS);
    tracker.updateLocal(OUTSIDE, 0, 0); // local: space
    tracker.applyServer('atmosphere', 'p1'); // server disagrees (neither is surface)
    expect(tracker.updateLocal(OUTSIDE, 0, 400)).toBe('space'); // 0 ms: clock starts
    expect(tracker.updateLocal(OUTSIDE, 0, 899)).toBe('space'); // 499 ms: under
    expect(warns.length).toBe(0);
    expect(tracker.updateLocal(OUTSIDE, 0, 900)).toBe('atmosphere'); // 500 ms: snap
    expect(tracker.regime).toBe('atmosphere');
    expect(tracker.planetId).toBe('p1');
    expect(tracker.divergenceMs(600)).toBeNull();
    expect(warns.length).toBe(1);
  });

  it('reset (system change) drops server authority and the active regime', () => {
    const tracker = new RegimeTracker();
    tracker.setPlanets(PLANETS);
    tracker.updateLocal(INSIDE, 0, 0);
    tracker.applyServer('atmosphere', 'p1');
    tracker.reset();
    expect(tracker.regime).toBe('space');
    expect(tracker.divergenceMs(0)).toBeNull();
    expect(tracker.updateLocal(INSIDE, 0, 10)).toBe('atmosphere'); // predicting again
  });
});
