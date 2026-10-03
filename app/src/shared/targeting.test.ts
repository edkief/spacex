import { describe, expect, it } from 'vitest';

import {
  coneContains,
  forwardOf,
  LOCK_CONE_RAD,
  LOCK_RANGE_M,
  pickNearestInCone,
  pickStrongestThreat,
  relativeBearing,
  THREAT_WINDOW_MS,
  type ThreatHit,
} from './targeting';
import { quatFromEuler } from './physics/vec';

/**
 * TASK-44 step 4: the PURE targeting math — cone containment at the exact
 * boundaries, nearest-in-cone selection, relative bearing signs, and the
 * strongest-attacker rule for the threat ping. The server validates locks
 * with these and the client selects with the same numbers, so the boundary
 * semantics tested here ARE the wire behaviour.
 */

const ORIGIN = { x: 0, y: 0, z: 0 };
const NORTH = { x: 0, y: 0, z: 1 }; // identity-quat forward

/** A point at (distance, angle) in the XZ plane right of +Z forward. */
function atAngle(distance: number, angleRad: number) {
  return { x: Math.sin(angleRad) * distance, y: 0, z: Math.cos(angleRad) * distance };
}

describe('forwardOf', () => {
  it('identity quat → +Z; yaw +90° about Y → +X', () => {
    expect(forwardOf({ x: 0, y: 0, z: 0, w: 1 })).toEqual({ x: 0, y: 0, z: 1 });
    const f = forwardOf(quatFromEuler(Math.PI / 2, 0, 0));
    expect(f.x).toBeCloseTo(1, 9);
    expect(f.z).toBeCloseTo(0, 9);
  });
});

describe('coneContains (lock cone boundaries)', () => {
  it('dead ahead inside range is valid; behind is not', () => {
    expect(coneContains(ORIGIN, NORTH, { x: 0, y: 0, z: 250 }, LOCK_RANGE_M, LOCK_CONE_RAD)).toBe(
      true,
    );
    expect(coneContains(ORIGIN, NORTH, { x: 0, y: 0, z: -250 }, LOCK_RANGE_M, LOCK_CONE_RAD)).toBe(
      false,
    );
  });

  it('distance boundary EXACT: 500 m in, 500.0001 m out (inclusive)', () => {
    expect(coneContains(ORIGIN, NORTH, { x: 0, y: 0, z: 500 }, LOCK_RANGE_M, LOCK_CONE_RAD)).toBe(
      true,
    );
    expect(
      coneContains(ORIGIN, NORTH, { x: 0, y: 0, z: 500.0001 }, LOCK_RANGE_M, LOCK_CONE_RAD),
    ).toBe(false);
  });

  it('angle boundary: 29.9999° in, 30.0001° out (30° cone half-angle)', () => {
    const eps = (0.0001 * Math.PI) / 180;
    expect(
      coneContains(ORIGIN, NORTH, atAngle(100, LOCK_CONE_RAD - eps), LOCK_RANGE_M, LOCK_CONE_RAD),
    ).toBe(true);
    expect(
      coneContains(ORIGIN, NORTH, atAngle(100, LOCK_CONE_RAD + eps), LOCK_RANGE_M, LOCK_CONE_RAD),
    ).toBe(false);
    // Both sides of the cone (left = negative angle) behave the same.
    expect(
      coneContains(
        ORIGIN,
        NORTH,
        atAngle(100, -(LOCK_CONE_RAD - eps)),
        LOCK_RANGE_M,
        LOCK_CONE_RAD,
      ),
    ).toBe(true);
    expect(
      coneContains(
        ORIGIN,
        NORTH,
        atAngle(100, -(LOCK_CONE_RAD + eps)),
        LOCK_RANGE_M,
        LOCK_CONE_RAD,
      ),
    ).toBe(false);
  });

  it('a zero-distance target (undefined angle) is NOT in the cone', () => {
    expect(coneContains(ORIGIN, NORTH, ORIGIN, LOCK_RANGE_M, LOCK_CONE_RAD)).toBe(false);
  });

  it('off-axis elevation counts in the 3D angle', () => {
    // 45° up: outside the 30° cone even at 100 m.
    expect(coneContains(ORIGIN, NORTH, { x: 0, y: 100, z: 100 }, LOCK_RANGE_M, LOCK_CONE_RAD)).toBe(
      false,
    );
  });
});

describe('pickNearestInCone', () => {
  it('nearest inside the cone wins over a farther one', () => {
    const pick = pickNearestInCone(
      ORIGIN,
      NORTH,
      [
        { id: 'far', pos: { x: 0, y: 0, z: 400 } },
        { id: 'near', pos: { x: 0, y: 0, z: 120 } },
      ],
      LOCK_RANGE_M,
      LOCK_CONE_RAD,
    );
    expect(pick?.id).toBe('near');
  });

  it('out-of-cone and out-of-range candidates never win', () => {
    const pick = pickNearestInCone(
      ORIGIN,
      NORTH,
      [
        { id: 'behind', pos: { x: 0, y: 0, z: -10 } },
        { id: 'wide', pos: atAngle(50, Math.PI / 4) },
        { id: 'out', pos: { x: 0, y: 0, z: 600 } },
        { id: 'valid', pos: { x: 0, y: 0, z: 300 } },
      ],
      LOCK_RANGE_M,
      LOCK_CONE_RAD,
    );
    expect(pick?.id).toBe('valid');
  });

  it('exact-distance tie resolves to the lexicographically smaller id', () => {
    const tie = (order: string[]) => {
      const cands = order.map((id) => ({ id, pos: { x: 0, y: 0, z: 200 } }));
      return pickNearestInCone(ORIGIN, NORTH, cands, LOCK_RANGE_M, LOCK_CONE_RAD)?.id;
    };
    expect(tie(['ship-b', 'ship-a'])).toBe('ship-a');
    expect(tie(['ship-a', 'ship-b'])).toBe('ship-a'); // order-independent
  });

  it('empty candidate list → undefined', () => {
    expect(pickNearestInCone(ORIGIN, NORTH, [], LOCK_RANGE_M, LOCK_CONE_RAD)).toBeUndefined();
  });
});

describe('relativeBearing', () => {
  it('straight ahead → 0', () => {
    expect(relativeBearing(ORIGIN, NORTH, { x: 0, y: 0, z: 100 })).toBeCloseTo(0, 9);
  });

  it('right (+X) → +90°, left (−X) → −90° (positive = right of nose)', () => {
    expect(relativeBearing(ORIGIN, NORTH, { x: 100, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2, 9);
    expect(relativeBearing(ORIGIN, NORTH, { x: -100, y: 0, z: 0 })).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('directly behind → ±180° (finite)', () => {
    expect(Math.abs(relativeBearing(ORIGIN, NORTH, { x: 0, y: 0, z: -100 }))).toBeCloseTo(
      Math.PI,
      9,
    );
  });

  it('bearing rotates with the ship: a nose on +X sees world +Z on its LEFT', () => {
    expect(relativeBearing(ORIGIN, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 100 })).toBeCloseTo(
      -Math.PI / 2,
      9,
    );
  });

  it('vertical forward degenerates against world +Z (finite, no NaN)', () => {
    const b = relativeBearing(ORIGIN, { x: 0, y: 1, z: 0 }, { x: 10, y: 0, z: 10 });
    expect(Number.isFinite(b)).toBe(true);
  });
});

describe('pickStrongestThreat (5 s window)', () => {
  const NOW = 100_000;
  const hit = (sourceId: string, damage: number, atMs: number): ThreatHit => ({
    sourceId,
    damage,
    atMs,
  });

  it('multi-hit totals beat a single bigger hit', () => {
    const best = pickStrongestThreat(
      [hit('a', 20, NOW - 100), hit('a', 20, NOW - 50), hit('b', 25, NOW - 200)],
      NOW,
    );
    expect(best).toBe('a'); // 40 vs 25
  });

  it('exact damage tie goes to the most RECENT hit', () => {
    const best = pickStrongestThreat([hit('a', 10, NOW - 4_000), hit('b', 10, NOW - 100)], NOW);
    expect(best).toBe('b');
  });

  it('window edge: hits at exactly now−5000 count, older drop out', () => {
    expect(pickStrongestThreat([hit('a', 10, NOW - THREAT_WINDOW_MS)], NOW)).toBe('a');
    expect(pickStrongestThreat([hit('a', 10, NOW - THREAT_WINDOW_MS - 1)], NOW)).toBeUndefined();
    // Future-dated hits (never in a real feed) are ignored too.
    expect(pickStrongestThreat([hit('a', 10, NOW + 1)], NOW)).toBeUndefined();
  });

  it('the winner flips as the window slides off the big hitter', () => {
    const hits = [hit('big', 50, NOW - 4_900), hit('small', 10, NOW - 1_000)];
    expect(pickStrongestThreat(hits, NOW)).toBe('big');
    // Once 'big' falls out of the window (NOW + 101), 'small' owns the arc.
    expect(pickStrongestThreat(hits, NOW + 101)).toBe('small');
  });

  it('empty window → undefined', () => {
    expect(pickStrongestThreat([], NOW)).toBeUndefined();
  });
});
