import { describe, expect, it } from 'vitest';

import type { Planet, SystemGen } from '@shared/galaxy/types';
import type { EntityState } from '@shared/protocol/schemas';
import type { Vec3 } from '@shared/physics/vec';

import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-44 step 4: the SERVER lock state — handleTargetLock's accept/reject
 * matrix, the `targetedBy` lock icon in the snapshot, the per-tick
 * auto-release rules (fake clock), and the missile target preference
 * (lock > nearest-in-cone > denied 'NO TARGET', spending nothing).
 * Shard conventions follow shard.weapons.test.ts (fake `now`, one tick/50 ms).
 */

const SEED = 'TARGETING-SIM-SEED';
const PLANET: Planet = {
  id: 'planet-1',
  name: 'Varda',
  class: 'terran',
  radiusKm: 3000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ['iron'],
  aiRoster: { count: 0, classes: [] },
};
const SYSTEM: SystemGen = {
  systemId: 'sys-targeting-sim',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};

let fakeNow = 1_000_000;

function makeShard(): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: SEED,
    system: SYSTEM,
    repo: {
      getShipByOwner: async () => undefined,
      getPlayersByIds: async () => [],
    },
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: { debug() {}, warn() {}, info() {} },
    now: () => fakeNow,
  });
}

/** Advance the fake clock `ms`, one sim tick per 50 ms step. */
function advance(shard: SystemShard, ms: number): void {
  const end = fakeNow + ms;
  while (fakeNow < end) {
    fakeNow += 50;
    shard.sim.step(fakeNow);
  }
}

/** A player ship in OPEN SPACE at `pos` (identity quat → nose +Z). */
function shipAt(
  shard: SystemShard,
  playerId: string,
  pos: Vec3,
  classId: string,
  sent?: string[],
): void {
  const entity: SimEntity = {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId,
    classId,
    ship: {
      pos: { ...pos },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
  };
  shard.addEntity(entity);
  shard.registerConnection(playerId, playerId, (b) => sent?.push(b));
}

interface Envelope {
  type: string;
  payload: Record<string, unknown>;
}

const errors = (sent: string[]): Record<string, unknown>[] =>
  sent
    .map((b) => JSON.parse(b) as Envelope)
    .filter((m) => m.type === 'error')
    .map((m) => m.payload);

const stateOf = (shard: SystemShard, id: string): EntityState | undefined =>
  shard.snapshot().find((e) => e.id === id);

describe('handleTargetLock — accept/reject matrix', () => {
  it('valid lock stored: live ship, in range, in cone (boundary 500 m accepted)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 500 }, 'scout'); // EXACT boundary: inclusive
    warmup(shard);

    shard.handleTargetLock('p1', 'ship-p2');
    expect(shard.targets.get('p1')?.targetId).toBe('ship-p2');
    expect(errors(a)).toHaveLength(0);
    shard.stop();
  });

  it('ai-ship targets are lockable; deposits are not', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    const id = shard.spawnDummyTargetForTesting('p1', 200);
    expect(id).toBeDefined();
    warmup(shard);

    shard.handleTargetLock('p1', id!);
    expect(shard.targets.get('p1')?.targetId).toBe(id);

    shard.addEntity({
      id: 'deposit-1',
      kind: 'deposit',
      playerId: null,
      classId: 'iron',
      ship: {
        pos: { x: 0, y: 0, z: 50 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'space',
      },
      hull: 1,
      shields: 0,
      targetId: null,
      docked: false,
    });
    shard.handleTargetLock('p1', 'deposit-1');
    expect(shard.targets.get('p1')?.targetId).toBe(id); // unchanged — deposit rejected
    expect(errors(a).some((e) => e.code === 'invalid-target')).toBe(true);
    shard.stop();
  });

  it('rejected: unknown id, self, on-foot shooter, destroyed target, >500 m, outside cone', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 200 }, 'scout');
    warmup(shard);

    shard.handleTargetLock('p1', 'ghost-ship');
    shard.handleTargetLock('p1', 'ship-p1'); // self
    shard.handleTargetLock('p1', 'ship-p2', { fake: 'stale-conn' }); // stale source
    const p2 = shard.entities.get('ship-p2')!;
    p2.destroyed = true;
    shard.handleTargetLock('p1', 'ship-p2');
    p2.destroyed = false;
    p2.ship.pos = { x: 0, y: 0, z: 501 }; // past 500 m
    shard.handleTargetLock('p1', 'ship-p2');
    p2.ship.pos = { x: 300, y: 0, z: 300 }; // 45° off the nose
    shard.handleTargetLock('p1', 'ship-p2');
    expect(shard.targets.has('p1')).toBe(false);

    // On-foot shooter (disembarked): rejected too.
    shard.entities.get('ship-p1')!.disembarked = true;
    p2.ship.pos = { x: 0, y: 0, z: 200 };
    shard.handleTargetLock('p1', 'ship-p2');
    expect(shard.targets.has('p1')).toBe(false);

    // Unknown player (no conn at all): silent drop, nothing stored.
    shard.handleTargetLock('nobody', 'ship-p2');
    expect(shard.targets.size).toBe(0);
    expect(errors(a).filter((e) => e.code === 'invalid-target').length).toBeGreaterThanOrEqual(5);
    shard.stop();
  });

  it('handleTargetRelease drops the lock; stale-conn release is ignored', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 200 }, 'scout');
    warmup(shard);

    shard.handleTargetLock('p1', 'ship-p2');
    shard.handleTargetRelease('p1', { fake: 'stale' });
    expect(shard.targets.has('p1')).toBe(true);
    shard.handleTargetRelease('p1');
    expect(shard.targets.has('p1')).toBe(false);
    shard.stop();
  });

  it('re-locking the SAME target refreshes the 30 s window', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 200 }, 'scout');
    warmup(shard);

    shard.handleTargetLock('p1', 'ship-p2');
    advance(shard, 20_000);
    shard.handleTargetLock('p1', 'ship-p2'); // refresh
    advance(shard, 20_000); // 40 s since the FIRST lock, 20 s since the refresh
    expect(shard.targets.get('p1')?.targetId).toBe('ship-p2');
    advance(shard, 10_100); // > 30 s since the refresh
    expect(shard.targets.has('p1')).toBe(false);
    shard.stop();
  });
});

describe('targetedBy — the lock icon in snapshots', () => {
  it('A locks B: B carries targetedBy=[p1], A carries none; release clears it', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 200 }, 'scout');
    warmup(shard);

    expect(stateOf(shard, 'ship-p2')?.targetedBy).toBeUndefined();
    shard.handleTargetLock('p1', 'ship-p2');
    expect(stateOf(shard, 'ship-p2')?.targetedBy).toEqual(['p1']);
    expect(stateOf(shard, 'ship-p1')?.targetedBy).toBeUndefined();

    shard.handleTargetRelease('p1');
    expect(stateOf(shard, 'ship-p2')?.targetedBy).toBeUndefined();
    shard.stop();
  });

  it('multiple lockers on one target → sorted player ids', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p3', { x: 0, y: 0, z: 0 }, 'scout');
    shipAt(shard, 'p1', { x: 0, y: 0, z: 50 }, 'scout');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 200 }, 'scout');
    warmup(shard);

    shard.handleTargetLock('p3', 'ship-p2');
    shard.handleTargetLock('p1', 'ship-p2');
    expect(stateOf(shard, 'ship-p2')?.targetedBy).toEqual(['p1', 'p3']);
    shard.stop();
  });
});

describe('auto-release (fake clock)', () => {
  it('TTL: held at exactly 30.000 s, gone past 30 s', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 200 }, 'scout');
    warmup(shard);

    shard.handleTargetLock('p1', 'ship-p2');
    advance(shard, 30_000); // delta exactly 30_000 — NOT > TTL
    expect(shard.targets.has('p1')).toBe(true);
    advance(shard, 50); // 30_050 > 30_000
    expect(shard.targets.has('p1')).toBe(false);
    shard.stop();
  });

  it('range: held at exactly 1500 m, gone past 1500 m', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 200 }, 'scout');
    warmup(shard);

    shard.handleTargetLock('p1', 'ship-p2');
    const p2 = shard.entities.get('ship-p2')!;
    p2.ship.pos = { x: 0, y: 0, z: 1_500 };
    advance(shard, 100);
    expect(shard.targets.has('p1')).toBe(true);
    p2.ship.pos = { x: 0, y: 0, z: 1_501 };
    advance(shard, 100);
    expect(shard.targets.has('p1')).toBe(false);
    shard.stop();
  });

  it('target destroyed → lock gone on the next tick', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 200 }, 'scout');
    warmup(shard);

    shard.handleTargetLock('p1', 'ship-p2');
    shard.entities.get('ship-p2')!.destroyed = true;
    advance(shard, 50);
    expect(shard.targets.has('p1')).toBe(false);
    expect(stateOf(shard, 'ship-p2')?.targetedBy).toBeUndefined();
    shard.stop();
  });
});

describe('missile target preference (lock > nearest-in-cone > denied)', () => {
  it('no lock + empty cone → {code:no-target} error, energy NOT spent', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor', a);
    warmup(shard);

    const before = shard.entities.get('ship-p1')!.energy;
    expect(before).toBeDefined();
    shard.handleFire('p1', { weapon: 'missile' });
    expect(shard.entities.get('ship-p1')!.energy).toBe(before); // spends NOTHING
    expect(errors(a)).toEqual([expect.objectContaining({ code: 'no-target' })]);
    advance(shard, 50);
    expect([...shard.entities.values()].filter((e) => e.kind === 'projectile')).toHaveLength(0);
    shard.stop();
  });

  it('the LOCK beats a nearer nose-cone ship', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 300 }, 'scout');
    shipAt(shard, 'p3', { x: 0, y: 0, z: 100 }, 'scout'); // nearer, dead ahead
    warmup(shard);

    shard.handleTargetLock('p1', 'ship-p2'); // the far one
    shard.handleFire('p1', { weapon: 'missile' });
    advance(shard, 5_050);

    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 25 / 50, 9); // LOCKED
    expect(shard.entities.get('ship-p3')!.shields).toBe(1); // nearer, untouched
    shard.stop();
  });

  it('no lock → the server picks the NEAREST ship in the nose cone', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 300 }, 'scout');
    shipAt(shard, 'p3', { x: 0, y: 0, z: 100 }, 'scout');
    warmup(shard);

    shard.handleFire('p1', { weapon: 'missile' }); // no lock at all
    advance(shard, 2_050); // 100 m closes in < 1 s

    expect(shard.entities.get('ship-p3')!.shields).toBeCloseTo(1 - 25 / 50, 9);
    expect(shard.entities.get('ship-p2')!.shields).toBe(1);
    shard.stop();
  });

  it('a dead lock falls through to the cone (lock re-validated at fire time)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor');
    shipAt(shard, 'p2', { x: 0, y: 0, z: 300 }, 'scout');
    shipAt(shard, 'p3', { x: 0, y: 0, z: 100 }, 'scout');
    warmup(shard);

    shard.handleTargetLock('p1', 'ship-p2');
    // The locked ship leaves the world before the fire is resolved.
    shard.entities.delete('ship-p2');
    shard.handleFire('p1', { weapon: 'missile' });
    advance(shard, 2_050);

    expect(shard.entities.get('ship-p3')!.shields).toBeCloseTo(1 - 25 / 50, 9); // cone fallback
    shard.stop();
  });
});

/** Burn the SimLoop's initial catch-up burst so each advance = exactly 1 tick. */
function warmup(shard: SystemShard): void {
  advance(shard, 250);
}
