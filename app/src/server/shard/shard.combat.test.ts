import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateSystem } from '@shared/galaxy/system';
import { generateStars } from '@shared/galaxy/stars';
import type { SystemGen } from '@shared/galaxy/types';
import type { Vec3 } from '@shared/physics/vec';
import type { WeaponSpec } from '@shared/weapons';

import { SystemShard } from './shard';
import { lineOfSight, LOS_SAMPLES, resolveHit } from './combat';
import type { SimEntity } from './types';

/**
 * Combat core (TASK-42): the resolveHit pipeline (self/dead/range/LOS
 * validation → TASK-23 damage), the combat event payloads ('hit' /
 * 'destroyed' / 'kill'), the wreck's killer id, and the LOS raycast —
 * synthetic heightfields plus the seeded analytic terrain.
 */

const SEED = 'shard-combat-seed';

const LASER: WeaponSpec = { id: 'laser', damage: 30, range: 2000 };

function testSystem(): SystemGen {
  const star = generateStars(SEED, 4)[0];
  return generateSystem(SEED, star.id);
}

function makeShard(system: SystemGen = testSystem()): SystemShard {
  return new SystemShard({
    systemId: system.systemId,
    galaxySeed: SEED,
    system,
    repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: { debug() {}, warn() {}, info() {} },
  });
}

function addFakeConn(shard: SystemShard, playerId: string, callsign: string): { sends: string[] } {
  const sends: string[] = [];
  shard.registerConnection(playerId, callsign, (buffer) => {
    sends.push(buffer);
  });
  return { sends };
}

/** A sim entity at `pos` in the given regime (optional planet for surface). */
function makeEntity(
  playerId: string,
  pos: Vec3,
  regime: 'space' | 'surface',
  planetId?: string,
): SimEntity {
  return {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId,
    classId: 'scout',
    ship: {
      pos: { ...pos },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime,
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId,
  };
}

function combatEvents(sends: string[]): Array<Record<string, unknown>> {
  return sends
    .filter((s) => JSON.parse(s).type === 'combat_event')
    .map((s) => (JSON.parse(s) as { payload: unknown }).payload as Record<string, unknown>);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('lineOfSight (pure raycast vs a heightfield)', () => {
  it('is clear when the whole ray stays above flat terrain', () => {
    expect(lineOfSight({ x: 0, y: 10, z: 0 }, { x: 200, y: 10, z: 0 }, () => 0)).toBe(true);
  });

  it('is occluded when any sample sits below terrain', () => {
    expect(lineOfSight({ x: 0, y: -1, z: 0 }, { x: 200, y: -1, z: 0 }, () => 0)).toBe(false);
    // A 100 m wall in the middle: the center sample (t=0.5) catches it.
    const wall = (x: number) => (Math.abs(x - 100) < 1 ? 100 : 0);
    expect(lineOfSight({ x: 0, y: 50, z: 0 }, { x: 200, y: 50, z: 0 }, wall)).toBe(false);
  });

  it('subsamples: a narrow spike between samples is NOT caught (documented approximation)', () => {
    // 5 samples over 200 m land at x = 0, 50, 100, 150, 200 — a 4 m spike at
    // x = 25 falls between them (max-slope 45° + ≤ 2 km makes 5 sufficient).
    const spike = (x: number) => (Math.abs(x - 25) < 2 ? 100 : 0);
    expect(lineOfSight({ x: 0, y: 50, z: 0 }, { x: 200, y: 50, z: 0 }, spike)).toBe(true);
    // More samples catch the same spike.
    expect(lineOfSight({ x: 0, y: 50, z: 0 }, { x: 200, y: 50, z: 0 }, spike, 9)).toBe(false);
    expect(LOS_SAMPLES).toBe(5);
  });

  it('a ship resting exactly on the surface is not "below terrain"', () => {
    expect(lineOfSight({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, () => 0)).toBe(true);
  });
});

describe('resolveHit validation (TASK-42 step 1)', () => {
  it('rejects firing at oneself with self-target', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }, 'space'));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p1',
        targetId: 'ship-p1',
        damagePoint: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual({
      ok: false,
      code: 'self-target',
    });
    expect(combatEvents(sends)).toHaveLength(0);
    shard.stop();
  });

  it('rejects unknown sources and targets', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }, 'space'));

    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-ghost',
        targetId: 'ship-p1',
        damagePoint: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual({ ok: false, code: 'unknown-source' });
    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p1',
        targetId: 'ship-ghost',
        damagePoint: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual({ ok: false, code: 'unknown-target' });
    shard.stop();
  });

  it('rejects dead and safe-zone targets: a killed ship respawns DOCKED (not targetable); its wreck stays dead', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }, 'space'));
    shard.addEntity(makeEntity('p2', { x: 10, y: 0, z: 0 }, 'space'));
    addFakeConn(shard, 'p1', 'Alpha');
    addFakeConn(shard, 'p2', 'Beta');

    shard.applyHit('ship-p1', 150, { kind: 'player', id: 'p2' }, LASER.id);
    // TASK-49: the killed PLAYER ship respawns immediately — the live entity
    // is now the docked starter scout (a safe zone); the wreck at the death
    // spot is what is dead.
    expect(shard.entities.get('ship-p1')!.destroyed).toBeFalsy();
    expect(shard.entities.get('ship-p1')!.docked).toBe(true);

    // The respawned docked ship is a safe zone...
    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p2',
        targetId: 'ship-p1',
        damagePoint: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual({ ok: false, code: 'docked' });
    // ...and its wreck too.
    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p2',
        targetId: 'wreck:ship-p1',
        damagePoint: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual({ ok: false, code: 'dead-target' });
    shard.stop();
  });

  it('rejects hits beyond the weapon range (measured source → damage point)', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }, 'space'));
    shard.addEntity(makeEntity('p2', { x: 500, y: 0, z: 0 }, 'space'));

    const short: WeaponSpec = { id: 'laser', damage: 30, range: 200 };
    expect(
      resolveHit(shard, {
        weapon: short,
        sourceId: 'ship-p1',
        targetId: 'ship-p2',
        damagePoint: { x: 500, y: 0, z: 0 },
      }),
    ).toEqual({ ok: false, code: 'out-of-range' });
    // Exactly at the range limit: allowed (<= range).
    expect(
      resolveHit(shard, {
        weapon: short,
        sourceId: 'ship-p1',
        targetId: 'ship-p2',
        damagePoint: { x: 200, y: 0, z: 0 },
      }),
    ).toEqual({ ok: true, shieldHit: 30, hullHit: 0, destroyed: false });
    shard.stop();
  });
});

describe('LOS against the seeded analytic terrain (TASK-42 step 1)', () => {
  /** Find a ridge: a point whose terrain is ≥ `drop` higher than the points
   *  100 m on either side (direction +X). Deterministic for the seed. */
  function findRidge(
    shard: SystemShard,
    planetId: string,
    drop = 25,
  ): {
    px: number;
    pz: number;
    hM: number;
    hA: number;
    hB: number;
  } {
    const h = (x: number, z: number) => shard.terrainHeightAt(planetId, x, z);
    for (let px = 2000; px <= 4200; px += 25) {
      for (let pz = 2000; pz <= 4200; pz += 25) {
        const hM = h(px, pz);
        const hA = h(px - 100, pz);
        const hB = h(px + 100, pz);
        if (hM >= hA + drop && hM >= hB + drop) return { px, pz, hM, hA, hB };
      }
    }
    throw new Error(`no ridge with a ${drop} m drop found for seed ${SEED}`);
  }

  it('a ship behind a mountain is NOT hit (5-point subsampled raycast)', () => {
    vi.useFakeTimers();
    const system = testSystem();
    const planet = system.planets[0];
    const shard = makeShard(system);
    const { px, pz, hM, hA, hB } = findRidge(shard, planet.id);

    // Sanity: the ridge is really higher than the ray through it.
    expect(hM).toBeGreaterThan((hA + hB) / 2 + 5);

    shard.addEntity(makeEntity('p1', { x: px - 100, y: hA + 5, z: pz }, 'surface', planet.id));
    shard.addEntity(makeEntity('p2', { x: px + 100, y: hB + 5, z: pz }, 'surface', planet.id));
    addFakeConn(shard, 'p1', 'Alpha');
    addFakeConn(shard, 'p2', 'Beta');

    // p1 fires at p2's damage point, over the ridge: occluded.
    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p1',
        targetId: 'ship-p2',
        damagePoint: { x: px + 100, y: hB + 5, z: pz },
      }),
    ).toEqual({ ok: false, code: 'no-line-of-sight' });
    // No damage was applied and no event went out.
    expect(shard.entities.get('ship-p2')!.hull).toBe(1);
    expect(shard.entities.get('ship-p2')!.shields).toBe(1);
    shard.stop();
  });

  it('the same engagement clears at high altitude (terrain cannot reach the ray)', () => {
    vi.useFakeTimers();
    const system = testSystem();
    const planet = system.planets[0];
    const shard = makeShard(system);
    const { px, pz, hA, hB } = findRidge(shard, planet.id);

    shard.addEntity(makeEntity('p1', { x: px - 100, y: hA + 2000, z: pz }, 'surface', planet.id));
    shard.addEntity(makeEntity('p2', { x: px + 100, y: hB + 2000, z: pz }, 'surface', planet.id));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');
    addFakeConn(shard, 'p2', 'Beta');

    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p1',
        targetId: 'ship-p2',
        damagePoint: { x: px + 100, y: hB + 2000, z: pz },
      }),
    ).toEqual({ ok: true, shieldHit: 30, hullHit: 0, destroyed: false });
    expect(combatEvents(sends)).toHaveLength(1);
    shard.stop();
  });

  it('space regime skips LOS entirely (a "mountain" in the way is irrelevant)', () => {
    vi.useFakeTimers();
    const system = testSystem();
    const planet = system.planets[0];
    const shard = makeShard(system);
    const { px, pz, hM } = findRidge(shard, planet.id);

    // Both ships in SPACE, sitting inside the terrain's height range along
    // the ray (y well below the ridge top) — in space that is fine.
    shard.addEntity(makeEntity('p1', { x: px - 100, y: hM - 100, z: pz }, 'space'));
    shard.addEntity(makeEntity('p2', { x: px + 100, y: hM - 50, z: pz }, 'space'));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');
    addFakeConn(shard, 'p2', 'Beta');

    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p1',
        targetId: 'ship-p2',
        damagePoint: { x: px + 100, y: hM - 50, z: pz },
      }),
    ).toEqual({ ok: true, shieldHit: 30, hullHit: 0, destroyed: false });
    expect(combatEvents(sends)).toHaveLength(1);
    shard.stop();
  });
});

describe('damage pipeline integration through resolveHit (TASK-42 step 2)', () => {
  it('hit → shields → hull → destroyed, with exact event payloads and kill attribution', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }, 'space'));
    shard.addEntity(makeEntity('p2', { x: 40, y: 0, z: 0 }, 'space'));
    const target = addFakeConn(shard, 'p1', 'Alpha');
    const attacker = addFakeConn(shard, 'p2', 'Beta');

    const fire = () =>
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p2',
        targetId: 'ship-p1',
        damagePoint: { x: 0, y: 0, z: 0 },
      });

    // Scout: 100 hull / 50 shields. 30 → all shields.
    expect(fire()).toEqual({ ok: true, shieldHit: 30, hullHit: 0, destroyed: false });
    // 30 → shields 20→0, hull 10.
    expect(fire()).toEqual({ ok: true, shieldHit: 20, hullHit: 10, destroyed: false });
    // 30 → hull 90→60.
    expect(fire()).toEqual({ ok: true, shieldHit: 0, hullHit: 30, destroyed: false });
    // 30 → hull 60→30.
    expect(fire()).toEqual({ ok: true, shieldHit: 0, hullHit: 30, destroyed: false });
    // 30 → hull 30→0: the killing hit.
    expect(fire()).toEqual({ ok: true, shieldHit: 0, hullHit: 30, destroyed: true });

    const targetEvents = combatEvents(target.sends);
    const attackerEvents = combatEvents(attacker.sends);
    expect(attackerEvents).toEqual(targetEvents); // whole-shard broadcast
    expect(targetEvents).toEqual([
      {
        kind: 'hit',
        target: 'ship-p1',
        source: { kind: 'player', id: 'p2' },
        weapon: 'laser',
        damage: 30,
        shieldHit: 30,
        hullHit: 0,
      },
      {
        kind: 'hit',
        target: 'ship-p1',
        source: { kind: 'player', id: 'p2' },
        weapon: 'laser',
        damage: 30,
        shieldHit: 20,
        hullHit: 10,
      },
      {
        kind: 'hit',
        target: 'ship-p1',
        source: { kind: 'player', id: 'p2' },
        weapon: 'laser',
        damage: 30,
        shieldHit: 0,
        hullHit: 30,
      },
      {
        kind: 'hit',
        target: 'ship-p1',
        source: { kind: 'player', id: 'p2' },
        weapon: 'laser',
        damage: 30,
        shieldHit: 0,
        hullHit: 30,
      },
      {
        kind: 'destroyed',
        target: 'ship-p1',
        source: { kind: 'player', id: 'p2' },
        weapon: 'laser',
      },
      { kind: 'kill', killer: 'p2', victim: 'ship-p1', weapon: 'laser' },
    ]);

    // The wreck carries the killer (TASK-49's skull marker until despawn).
    const wreck = shard.entities.get('wreck:ship-p1');
    expect(wreck!.killerId).toBe('p2');

    // The victim has already respawned DOCKED (TASK-49): the live ship is a
    // safe zone; the wreck at the death spot is what is dead-target.
    expect(fire()).toEqual({ ok: false, code: 'docked' });
    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ship-p2',
        targetId: 'wreck:ship-p1',
        damagePoint: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual({ ok: false, code: 'dead-target' });
    shard.stop();
  });

  it('friendly fire is ON: one pipeline, no team checks (AI sources flow too)', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }, 'space'));
    // An AI ship: no playerId — it attributes to {kind:'ai'}.
    const ai: SimEntity = {
      id: 'ai-patrol-1',
      kind: 'ai-ship',
      playerId: null,
      classId: 'interceptor',
      ship: {
        pos: { x: 30, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'space',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
    };
    shard.addEntity(ai);
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    // Interceptor: 80 hull / 40 shields — 30 is all shields.
    expect(
      resolveHit(shard, {
        weapon: LASER,
        sourceId: 'ai-patrol-1',
        targetId: 'ship-p1',
        damagePoint: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual({ ok: true, shieldHit: 30, hullHit: 0, destroyed: false });
    expect(combatEvents(sends)).toEqual([
      {
        kind: 'hit',
        target: 'ship-p1',
        source: { kind: 'ai', id: 'ai-patrol-1' },
        weapon: 'laser',
        damage: 30,
        shieldHit: 30,
        hullHit: 0,
      },
    ]);
    shard.stop();
  });
});
