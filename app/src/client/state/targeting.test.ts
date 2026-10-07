import { beforeEach, describe, expect, it } from 'vitest';

import type { EntityState } from '@shared/protocol/schemas';
import type { CombatEvent } from '@client/fx';
import type { Vec3 } from '@shared/physics/vec';

import {
  __resetTargeting,
  ingestCombatEvent,
  ingestTargetingEntities,
  onTargetingError,
  targetingSubscribe,
  toggleTargetLock,
  type TargetingView,
} from './targeting';

/**
 * TASK-44 step 3/4: the client targeting store — optimistic lock toggle,
 * the live target box fed by snapshots, and the threat ping selection.
 * Entities are minimal EntityStates (identity quat = nose along +Z).
 */

const mk = (
  id: string,
  kind: EntityState['kind'],
  pos: Vec3,
  extra: Partial<EntityState> = {},
): EntityState =>
  ({
    id,
    kind,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    regime: 'space',
    hull: 1,
    shields: 1,
    targetId: null,
    classId: 'scout',
    ...extra,
  }) as EntityState;

/** Self ship at origin (nose +Z) + a static ai-ship 200 m dead ahead. */
function world(): EntityState[] {
  return [
    mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
    mk('ai:dummy:1', 'ai-ship', { x: 0, y: 0, z: 200 }, { callsign: 'AI-001-1' }),
  ];
}

beforeEach(() => {
  __resetTargeting();
});

/** Pull the current view without exporting a getter: subscribe (pushes
 *  immediately), capture, unsubscribe. */
function current(): TargetingView {
  let v: TargetingView = { box: null, threat: null, banner: null, noTargetAt: 0 };
  const unsub = targetingSubscribe((next) => {
    v = next;
  });
  unsub();
  return v;
}

describe('toggleTargetLock', () => {
  it('nothing ingested → null (no ship to lock from)', () => {
    expect(toggleTargetLock(1_000)).toBeNull();
  });

  it('locks the nearest valid ship in the cone: lock command + optimistic box + banner', () => {
    ingestTargetingEntities(world(), 'one', 1_000);
    expect(toggleTargetLock(1_000)).toEqual({ type: 'lock', targetId: 'ai:dummy:1' });
    // Optimistic: the banner lights NOW; the box fills on the NEXT snapshot.
    expect(current().banner?.text).toBe('TARGET LOCKED: AI-001-1');
    ingestTargetingEntities(world(), 'one', 1_100);
    const v = current();
    expect(v.box?.targetId).toBe('ai:dummy:1');
    expect(v.box?.distance).toBeCloseTo(200, 6);
  });

  it('a docked ship with an OMITTED (identity) rot still locks the dead-ahead target (TASK-78 close-out)', () => {
    // The wire omits rot for an identity quat — the docked home-dock starter
    // reads with self.rot === undefined (NOT an identity object). Falling
    // back to identity forward (+Z) lets it lock, matching the server.
    ingestTargetingEntities(
      [
        mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one', rot: undefined }),
        mk('ai:dummy:1', 'ai-ship', { x: 0, y: 0, z: 200 }, { callsign: 'AI-001-1' }),
      ],
      'one',
      1_000,
    );
    expect(toggleTargetLock(1_000)).toEqual({ type: 'lock', targetId: 'ai:dummy:1' });
    ingestTargetingEntities(
      [
        mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one', rot: undefined }),
        mk('ai:dummy:1', 'ai-ship', { x: 0, y: 0, z: 200 }, { callsign: 'AI-001-1' }),
      ],
      'one',
      1_100,
    );
    expect(current().box?.targetId).toBe('ai:dummy:1');
  });

  it('re-press while locked → release, box clears', () => {
    ingestTargetingEntities(world(), 'one', 1_000);
    toggleTargetLock(1_000);
    expect(toggleTargetLock(2_000)).toEqual({ type: 'release' });
    expect(current().box).toBeNull();
  });

  it('targets outside the 500 m / 30° cone are never picked', () => {
    ingestTargetingEntities(
      [
        mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
        mk('far', 'ai-ship', { x: 0, y: 0, z: 700 }, { callsign: 'FAR' }),
        mk('side', 'ai-ship', { x: 400, y: 0, z: 300 }, { callsign: 'SIDE' }), // ~53° off
      ],
      'one',
      1_000,
    );
    expect(toggleTargetLock(1_000)).toBeNull();
  });

  it('destroyed (hull ≤ 0) ships are not lockable', () => {
    ingestTargetingEntities(
      [
        mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
        mk('dead', 'ai-ship', { x: 0, y: 0, z: 100 }, { callsign: 'DEAD', hull: 0 }),
      ],
      'one',
      1_000,
    );
    expect(toggleTargetLock(1_000)).toBeNull();
  });
});

describe('target box via snapshots', () => {
  it('live distance / hull% / shield% / bearing refresh every ingest', () => {
    ingestTargetingEntities(world(), 'one', 1_000);
    toggleTargetLock(1_000);
    ingestTargetingEntities(
      [
        mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
        mk(
          'ai:dummy:1',
          'ai-ship',
          { x: 150, y: 0, z: 200 },
          {
            callsign: 'AI-001-1',
            hull: 0.61,
            shields: 0.2,
          },
        ),
      ],
      'one',
      2_000,
    );
    const v = current();
    expect(v.box?.distance).toBeCloseTo(Math.hypot(150, 0, 200), 6);
    expect(v.box?.hullPct).toBe(61);
    expect(v.box?.shieldPct).toBe(20);
    expect(v.box?.bearing).toBeGreaterThan(0); // drifted to the RIGHT
  });

  it('target leaving the snapshot (destroyed/despawned) clears the box', () => {
    ingestTargetingEntities(world(), 'one', 1_000);
    toggleTargetLock(1_000);
    ingestTargetingEntities(
      [mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' })],
      'one',
      2_000,
    );
    expect(current().box).toBeNull();
  });

  it('target hull dropping to 0 clears the box', () => {
    ingestTargetingEntities(world(), 'one', 1_000);
    toggleTargetLock(1_000);
    ingestTargetingEntities(
      [
        mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
        mk('ai:dummy:1', 'ai-ship', { x: 0, y: 0, z: 200 }, { callsign: 'AI-001-1', hull: 0 }),
      ],
      'one',
      2_000,
    );
    expect(current().box).toBeNull();
  });

  it('the lock banner self-clears after ~2.5 s', () => {
    ingestTargetingEntities(world(), 'one', 1_000);
    toggleTargetLock(1_000);
    expect(current().banner).not.toBeNull();
    ingestTargetingEntities(world(), 'one', 1_000 + 2_501);
    expect(current().banner).toBeNull();
  });
});

describe('error frames', () => {
  it('invalid-target clears the optimistic lock + box', () => {
    ingestTargetingEntities(world(), 'one', 1_000);
    toggleTargetLock(1_000);
    onTargetingError('invalid-target', 1_100);
    const v = current();
    expect(v.box).toBeNull();
  });

  it('no-target stamps noTargetAt (the NO TARGET prompt)', () => {
    onTargetingError('no-target', 5_000);
    expect(current().noTargetAt).toBe(5_000);
  });
});

describe('threat ping (ingestCombatEvent)', () => {
  const hit = (source: string, damage: number): CombatEvent =>
    ({
      kind: 'hit',
      target: 'ship-p1',
      source: { kind: 'player', id: source },
      weapon: 'laser',
      damage,
      shieldHit: damage,
      hullHit: 0,
    }) as CombatEvent;

  const worldWithAttacker = (): EntityState[] => [
    mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
    mk('ship-p2', 'ship', { x: 100, y: 0, z: 0 }, { callsign: 'two' }), // 90° RIGHT
  ];

  it('a hit from a foreign source lights the arc toward the attacker', () => {
    ingestTargetingEntities(worldWithAttacker(), 'one', 1_000);
    ingestCombatEvent(hit('two', 8), 'p1', 2_000);
    const v = current();
    expect(v.threat?.attackerId).toBe('two');
    expect(v.threat?.bearing).toBeCloseTo(Math.PI / 2, 6); // right side
    expect(v.threat?.expiresAt).toBe(2_000 + 3_000);
  });

  it('self-source hits are ignored (friendly fire ping would be noise)', () => {
    ingestTargetingEntities(worldWithAttacker(), 'one', 1_000);
    ingestCombatEvent(hit('p1', 8), 'p1', 2_000);
    expect(current().threat).toBeNull();
  });

  it('events aimed at OTHER ships are ignored', () => {
    ingestTargetingEntities(worldWithAttacker(), 'one', 1_000);
    ingestCombatEvent(
      { ...(hit('two', 8) as object), target: 'ship-p9' } as CombatEvent,
      'p1',
      2_000,
    );
    expect(current().threat).toBeNull();
  });

  it('strongest attacker of the last 5 s wins the arc (totals)', () => {
    ingestTargetingEntities(worldWithAttacker(), 'one', 1_000);
    ingestCombatEvent(hit('two', 8), 'p1', 2_000); // two: 8
    ingestCombatEvent(
      {
        ...(hit('ghost', 25) as object),
        target: 'ship-p1',
        source: { kind: 'ai', id: 'ghost' },
      } as CombatEvent,
      'p1',
      2_100,
    ); // ghost: 25 -> owns the arc
    expect(current().threat?.attackerId).toBe('ghost');
    // Back-and-forth laser from 'two' climbs past 25 -> the arc flips back.
    for (const at of [2_200, 2_300, 2_400, 2_500]) ingestCombatEvent(hit('two', 8), 'p1', at);
    expect(current().threat?.attackerId).toBe('two'); // 40 > 25
  });

  it('the arc expires: ingests after expiresAt drop it', () => {
    ingestTargetingEntities(worldWithAttacker(), 'one', 1_000);
    ingestCombatEvent(hit('two', 8), 'p1', 2_000);
    ingestTargetingEntities(worldWithAttacker(), 'one', 2_000 + 3_001);
    expect(current().threat).toBeNull();
  });

  it('the arc BEARING follows the attacker while they ride the snapshot', () => {
    ingestTargetingEntities(worldWithAttacker(), 'one', 1_000);
    ingestCombatEvent(hit('two', 8), 'p1', 2_000);
    ingestTargetingEntities(
      [
        mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
        mk('ship-p2', 'ship', { x: 0, y: 0, z: -100 }, { callsign: 'two' }), // now behind
      ],
      'one',
      2_100,
    );
    expect(Math.abs(current().threat?.bearing ?? 0)).toBeCloseTo(Math.PI, 6);
  });

  it('destroyed events (damage 0) enter the window without winning outright', () => {
    ingestTargetingEntities(worldWithAttacker(), 'one', 1_000);
    ingestCombatEvent(
      {
        kind: 'destroyed',
        target: 'ship-p1',
        source: { kind: 'ai', id: 'ghost' },
        weapon: 'missile',
      } as CombatEvent,
      'p1',
      2_000,
    );
    expect(current().threat?.attackerId).toBe('ghost');
    ingestCombatEvent(hit('two', 8), 'p1', 2_100); // 8 > 0 flips to 'two'
    expect(current().threat?.attackerId).toBe('two');
  });
});
