import { describe, expect, it } from 'vitest';

import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { planetAnchor } from '@shared/galaxy/planets';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import type { Vec3 } from '@shared/physics/vec';
import { MISSILE } from '@shared/weapons';

import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-43 step 2: the server fire pipeline — fire INTENTS in, combat events
 * out. Shard conventions are shard.mining.test.ts' (stub repo/bus/log, a FAKE
 * `now` closure, one sim tick per 50 ms of fake time). Every contract from
 * the spec rides here: laser range/LOS, the exact 3/s fire rate, energy
 * gating + regen, the loadout gate, missile homing (converge vs evade),
 * splash split, the 16-projectile cap and the 30 fires/s weapon lock.
 */

const SEED = 'WEAPONS-SIM-SEED';
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
  systemId: 'sys-weapons-sim',
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

/**
 * A player ship in OPEN SPACE (the planet anchor sits 10 km away, far
 * outside the atmosphere, so the regime stays 'space' under the tick).
 * `pos` is the ship center; the nose sits 3 m along +Z (identity quat).
 */
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

/** A pre-seeded missile in flight (the 16-cap test fills the budget). */
function seedProjectile(shard: SystemShard, seq: number, pos: Vec3, targetId: string): void {
  shard.entities.set(`proj:${seq}`, {
    id: `proj:${seq}`,
    kind: 'projectile',
    playerId: null,
    classId: 'missile',
    ship: {
      pos: { ...pos },
      vel: { x: 0, y: 0, z: MISSILE.speed! },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    },
    hull: 0,
    shields: 0,
    targetId,
    docked: false,
    ttl: 10_000, // long: only the cap (not the ttl) removes it in this test
    projectile: { targetId, sourceId: 'ship-p1', weaponId: 'missile', spawnTick: seq },
  });
}

interface Envelope {
  type: string;
  payload: unknown;
}

const events = (sent: string[]): Record<string, unknown>[] =>
  sent
    .map((b) => JSON.parse(b) as Envelope)
    .filter((m) => m.type === 'combat_event')
    .map((m) => m.payload as Record<string, unknown>);

const errors = (sent: string[]): Record<string, unknown>[] =>
  sent
    .map((b) => JSON.parse(b) as Envelope)
    .filter((m) => m.type === 'error')
    .map((m) => m.payload as Record<string, unknown>);

/** Burn the SimLoop's initial catch-up burst so each advance = exactly 1 tick. */
function warmup(shard: SystemShard): void {
  advance(shard, 250);
}

describe('laser (instant ray through the TASK-42 resolver)', () => {
  it('hits the targeted ship in range: 8 damage, laser-fired + hit events for everyone', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 100 }, 'scout', b);
    warmup(shard);

    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    expect(shard.entities.get('ship-p1')!.energy).toBeCloseTo(98, 9); // 2 spent at acceptance
    advance(shard, 50); // the tick resolves the queued intent

    // 8 on the scout's 50 shields (normalized 0..1 fractions on the sim).
    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 8 / 50, 9);
    expect(shard.entities.get('ship-p2')!.hull).toBe(1);

    // The OBSERVER (B) saw the fired FX event AND the hit…
    expect(events(b)).toEqual([
      {
        kind: 'laser-fired',
        source: { kind: 'player', id: 'p1' },
        weapon: 'laser',
        from: { x: 0, y: 0, z: 3 },
        to: { x: 0, y: 0, z: 100 },
      },
      {
        kind: 'hit',
        target: 'ship-p2',
        source: { kind: 'player', id: 'p1' },
        weapon: 'laser',
        damage: 8,
        shieldHit: 8,
        hullHit: 0,
      },
    ]);
    // …and so did the shooter (FX is event-driven, TASK-43 AC).
    expect(events(a)).toEqual(events(b));
    shard.stop();
  });

  it('fire rate: a second shot inside the 3/s cooldown is a SILENT drop (no energy, no event)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 100 }, 'scout', b);
    warmup(shard);

    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    expect(shard.entities.get('ship-p1')!.energy).toBeCloseTo(98, 9); // 2 spent
    advance(shard, 50); // 1 shot landed (+0.5 regen)
    // Immediately: still in cooldown (7 ticks = 350 ms at 20 Hz).
    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    expect(shard.entities.get('ship-p1')!.energy).toBeCloseTo(98.5, 9); // denied fire spent 0
    advance(shard, 100); // the dropped fire resolves to NOTHING

    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 8 / 50, 9); // one hit only
    const fired = events(a).filter((e) => e.kind === 'laser-fired');
    expect(fired).toHaveLength(1);

    // After the cooldown elapses the same intent is accepted again.
    advance(shard, 400); // cooldown fully over
    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    advance(shard, 50);
    expect(events(a).filter((e) => e.kind === 'laser-fired')).toHaveLength(2);
    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 16 / 50, 9);
    shard.stop();
  });

  it('energy gate: below the 2-u cost the fire is DENIED with a low-energy prompt (no event, nothing spent)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 100 }, 'scout', b);
    warmup(shard);

    shard.entities.get('ship-p1')!.energy = 1;
    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    expect(shard.entities.get('ship-p1')!.energy).toBeCloseTo(1, 9); // nothing spent
    advance(shard, 50);

    expect(errors(a)).toEqual([{ code: 'low-energy', message: 'LOW ENERGY' }]);
    expect(events(a)).toHaveLength(0); // denied fires show no FX
    expect(events(b)).toHaveLength(0);
    // The denied fire spent nothing — only the idle regen (0.5) moved it.
    expect(shard.entities.get('ship-p1')!.energy).toBeCloseTo(1.5, 9);
    expect(shard.entities.get('ship-p2')!.shields).toBe(1);
    shard.stop();
  });

  it('energy regenerates 10/s (max 100) on the tick, docked or flying', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout');
    warmup(shard);

    shard.entities.get('ship-p1')!.energy = 0;
    advance(shard, 1_000); // 20 ticks × 0.5 u
    expect(shard.entities.get('ship-p1')!.energy).toBeCloseTo(10, 9);
    advance(shard, 10_000); // far past the cap
    expect(shard.entities.get('ship-p1')!.energy).toBe(100);
    shard.stop();
  });

  it('out-of-range target: the ray still flies (accepted) but resolves nothing past 400 m', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 500 }, 'scout', b);
    warmup(shard);

    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    advance(shard, 50);

    expect(shard.entities.get('ship-p2')!.shields).toBe(1); // no hit
    expect(events(a).filter((e) => e.kind === 'hit')).toHaveLength(0);
    // The beam ran to max range (nose at z=3 → end at 400 m).
    const fired = events(a).find((e) => e.kind === 'laser-fired');
    expect(fired).toMatchObject({
      kind: 'laser-fired',
      to: { x: 0, y: 0, z: 403 },
    });
    shard.stop();
  });

  it('no target given: raycasts the FIRST ship within the hit radius along the nose ray', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 2, y: 0, z: 90 }, 'scout', b); // 2 m off the ray
    warmup(shard);

    shard.handleFire('p1', { weapon: 'laser' });
    advance(shard, 50);

    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 8 / 50, 9);
    expect(events(a).filter((e) => e.kind === 'hit' && e.target === 'ship-p2')).toHaveLength(1);
    shard.stop();
  });

  it('loadout gate: a scout firing missiles is a SILENT drop (not in its hardpoints)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 100 }, 'scout', b);
    warmup(shard);

    shard.handleFire('p1', { weapon: 'missile', targetId: 'ship-p2' });
    // The tick materialized energy at the cap during warmup: the silent
    // drop leaves it exactly where it was.
    const before = shard.entities.get('ship-p1')!.energy;
    advance(shard, 100);

    expect(events(a)).toHaveLength(0);
    expect(events(b)).toHaveLength(0);
    expect(shard.entities.get('ship-p1')!.energy).toBe(before); // nothing spent
    const projectiles = [...shard.entities.values()].filter((e) => e.kind === 'projectile');
    expect(projectiles).toHaveLength(0);
    shard.stop();
  });
});

describe('LOS against the seeded analytic terrain', () => {
  const SYSTEM_SEED = 'shard-weapons-los-seed';

  function testSystem(): SystemGen {
    const star = generateStars(SYSTEM_SEED, 4)[0];
    return generateSystem(SYSTEM_SEED, star.id);
  }

  function makeRidgeShard(system: SystemGen): SystemShard {
    return new SystemShard({
      systemId: system.systemId,
      galaxySeed: SYSTEM_SEED,
      system,
      repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
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

  /**
   * A ridge that the LASER SWEEP actually catches: the terrain is ≥ `drop`
   * higher than 100 m on either side (+X) AND at least one of the sweep's
   * own 20 m subsamples (from the nose at px−97) stands ≥ 10 m above the
   * low ray — a narrow spike between samples would be (documentedly) missed.
   * Scanned within ±550 m of the planet ANCHOR: the regime machine only keeps
   * a ship in the atmosphere/surface regimes within the 1 km atmosphere
   * radius, where the terrain occlusion applies at all (ships at px±100 stay
   * ≤ ~850 m out — inside the enter radius, so the tick never re-resolves
   * them to 'space').
   */
  function findRidge(
    shard: SystemShard,
    planetId: string,
    planetIndex: number,
    drop = 12,
  ): { px: number; pz: number; hM: number; hA: number; hB: number } {
    const h = (x: number, z: number) => shard.terrainHeightAt(planetId, x, z);
    const anchor = planetAnchor(planetIndex);
    // Both ships (px±100) must stay inside the 1 km atmosphere radius or
    // the regime machine re-resolves them to 'space' (terrain skipped).
    for (let px = anchor.x - 550; px <= anchor.x + 550; px += 25) {
      for (let pz = anchor.z - 550; pz <= anchor.z + 550; pz += 25) {
        const hA = h(px - 100, pz);
        const hB = h(px + 100, pz);
        const hM = h(px, pz);
        if (hM < hA + drop || hM < hB + drop) continue;
        let occluding = false;
        for (let d = 20; d < 200; d += 20) {
          if (h(px - 97 + d, pz) > hA + 8) {
            occluding = true;
            break;
          }
        }
        if (occluding) return { px, pz, hM, hA, hB };
      }
    }
    throw new Error(`no sweep-occluding ridge found for seed ${SYSTEM_SEED}`);
  }

  /** A surface ship at `pos` facing +X (yaw 90°, so the nose ray runs over the ridge). */
  function surfaceShipFacingX(
    shard: SystemShard,
    playerId: string,
    pos: Vec3,
    planetId: string,
    sent?: string[],
  ): void {
    const entity: SimEntity = {
      id: `ship-${playerId}`,
      kind: 'ship',
      playerId,
      callsign: playerId,
      classId: 'scout',
      ship: {
        pos: { ...pos },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      planetId,
    };
    shard.addEntity(entity);
    shard.registerConnection(playerId, playerId, (b) => sent?.push(b));
  }

  it('a ship behind the ridge is NOT hit; the same engagement clears at high altitude', () => {
    fakeNow = 1_000_000;
    const system = testSystem();
    // The planet MUST have an atmosphere: on an airless planet
    // (atmosphereRadius 0) the regime machine re-resolves every ship to
    // 'space', and space ships skip the terrain/LOS sweep entirely — the
    // occlusion could never fire. The seeded system's first landable
    // atmospheric planet is slot 1 (ocean, 1 km atmosphere radius).
    const planetIndex = system.planets.findIndex((p) => p.hasAtmosphere && p.landable);
    expect(planetIndex).toBeGreaterThan(0);
    const planet = system.planets[planetIndex];
    const shard = makeRidgeShard(system);
    const { px, pz, hM, hA, hB } = findRidge(shard, planet.id, planetIndex);
    expect(hM).toBeGreaterThan((hA + hB) / 2 + 5); // the ridge is really a ridge

    // Low: both 5 m above their own ground, the ridge (≥ +25 m) blocks.
    const a: string[] = [];
    const b: string[] = [];
    surfaceShipFacingX(shard, 'p1', { x: px - 100, y: hA + 5, z: pz }, planet.id, a);
    surfaceShipFacingX(shard, 'p2', { x: px + 100, y: hB + 5, z: pz }, planet.id, b);
    warmup(shard);
    // Guard: both ships must STILL be in the surface regime after the tick
    // (terrain occlusion only applies there) — a regime flip fails loudly
    // instead of silently letting the shot through.
    for (const id of ['ship-p1', 'ship-p2']) {
      expect(shard.entities.get(id)!.ship.regime).toBe('surface');
      expect(shard.entities.get(id)!.planetId).toBe(planet.id);
    }
    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    advance(shard, 50);

    expect(shard.entities.get('ship-p2')!.shields).toBe(1); // occluded: no hit
    expect(shard.entities.get('ship-p2')!.hull).toBe(1);
    const hits = events([...a, ...b]).filter((e) => e.kind === 'hit');
    expect(hits).toHaveLength(0);

    shard.stop();

    // High: the same geometry at +2000 m — the ridge (≤ ~300 m of terrain)
    // cannot reach the ray, and the shot lands.
    fakeNow = 1_000_000;
    const shard2 = makeRidgeShard(testSystem());
    const r2 = findRidge(shard2, planet.id, planetIndex);
    const hi: string[] = [];
    surfaceShipFacingX(shard2, 'p1', { x: r2.px - 100, y: r2.hA + 2000, z: r2.pz }, planet.id, hi);
    surfaceShipFacingX(shard2, 'p2', { x: r2.px + 100, y: r2.hB + 2000, z: r2.pz }, planet.id);
    warmup(shard2);
    shard2.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    advance(shard2, 50);
    expect(shard2.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 8 / 50, 9);
    expect(events(hi).filter((e) => e.kind === 'hit')).toHaveLength(1);
    shard2.stop();
  });
});

describe('missiles (homing projectile entities)', () => {
  it('straight target: the tracer converges and detonates — 25 on the target, missile-fired + missile-impact + hit', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 300 }, 'scout', b);
    warmup(shard);

    shard.handleFire('p1', { weapon: 'missile', targetId: 'ship-p2' });
    expect(shard.entities.get('ship-p1')!.energy).toBeCloseTo(90, 9); // 10 spent at acceptance
    advance(shard, 50);

    // The projectile is a VISIBLE entity (kind 'projectile', 5 s ttl).
    const proj = [...shard.entities.values()].find((e) => e.kind === 'projectile');
    expect(proj).toBeDefined();
    expect(proj!.projectile).toMatchObject({
      targetId: 'ship-p2',
      sourceId: 'ship-p1',
      weaponId: 'missile',
    });
    expect(proj!.ttl).toBe(Math.round(MISSILE.ttl! / 0.05) - 1); // 100 at spawn, one tick elapsed
    expect(events(a).filter((e) => e.kind === 'missile-fired')).toHaveLength(1);

    // 300 m at 120 u/s ≈ 2.5 s: it detonates well inside the 5 s ttl.
    advance(shard, 5_000);
    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 25 / 50, 9);
    expect([...shard.entities.values()].filter((e) => e.kind === 'projectile')).toHaveLength(0);

    const aEvents = events(a);
    expect(aEvents.filter((e) => e.kind === 'missile-impact')).toHaveLength(1);
    expect(aEvents).toContainEqual({
      kind: 'hit',
      target: 'ship-p2',
      source: { kind: 'player', id: 'p1' },
      weapon: 'missile',
      damage: 25,
      shieldHit: 25,
      hullHit: 0,
    });
    // The observer saw the whole exchange too.
    expect(events(b).filter((e) => e.kind === 'missile-impact')).toHaveLength(1);
    expect(events(b).filter((e) => e.kind === 'hit' && e.target === 'ship-p2')).toHaveLength(1);
    shard.stop();
  });

  it('evading target (turns + flies faster than the missile can track): the missile EXPIRES — no hit, nothing spent after the 10', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor', a);
    const center = { x: 0, y: 0, z: 300 };
    const radius = 100;
    const omega = 3; // 3 rad/s > the 1.5 rad/s missile cap
    shipAt(shard, 'p2', { ...center }, 'scout', b);
    warmup(shard);

    shard.handleFire('p1', { weapon: 'missile', targetId: 'ship-p2' });
    advance(shard, 50);
    expect([...shard.entities.values()].filter((e) => e.kind === 'projectile')).toHaveLength(1);

    // The target flees in a circle (the sim's "test teleport" — the tick sees it).
    const target = shard.entities.get('ship-p2')!;
    for (let i = 0; i < 52; i++) {
      const t = (i + 1) * 0.1; // 100 ms steps, 5.2 s total > the 5 s ttl
      target.ship.pos = {
        x: center.x + radius * Math.sin(omega * t),
        y: 0,
        z: center.z - radius * Math.cos(omega * t),
      };
      advance(shard, 100);
    }

    expect([...shard.entities.values()].filter((e) => e.kind === 'projectile')).toHaveLength(0); // expired
    expect(shard.entities.get('ship-p2')!.shields).toBe(1); // never hit
    expect(shard.entities.get('ship-p2')!.hull).toBe(1);
    expect(events(a).filter((e) => e.kind === 'missile-impact')).toHaveLength(0);
    expect(events(b).filter((e) => e.kind === 'hit')).toHaveLength(0);
    shard.stop();
  });

  it('splash: 25 on the target, 12 on EVERY other ship within 5 m (friendly fire incl.), none beyond', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    const c: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 300 }, 'scout', b);
    shipAt(shard, 'p3', { x: 2, y: 0, z: 298 }, 'scout', c); // ~2.8 m from p2 AND from the impact
    warmup(shard);

    // TASK-44 preference: p1 LOCKS p2, so the missile homes on the LOCK even
    // though p3 is the nearer nose-cone ship (lock > nearest).
    shard.handleTargetLock('p1', 'ship-p2');
    expect(shard.targets.get('p1')?.targetId).toBe('ship-p2');

    shard.handleFire('p1', { weapon: 'missile', targetId: 'ship-p2' });
    advance(shard, 5_050);

    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 25 / 50, 9); // direct 25
    expect(shard.entities.get('ship-p3')!.shields).toBeCloseTo(1 - 12 / 50, 9); // splash 12
    expect(shard.entities.get('ship-p1')!.shields).toBe(1); // the shooter, 300 m away
    const impacts = events(a).filter((e) => e.kind === 'missile-impact');
    expect(impacts).toHaveLength(1);
    expect(events(a).filter((e) => e.kind === 'hit')).toHaveLength(2); // p2 + p3
    shard.stop();
  });

  it('projectile cap: a 17th missile expires the OLDEST in flight (16 max, logged)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 300 }, 'scout', b);
    warmup(shard);

    // Fill the budget: 16 stale missiles chasing a GHOST (fly straight, so
    // none detonates mid-test — only the cap removes one). Ids/spawnTicks
    // start at 100 so they cannot collide with the shard's own `proj:<seq>`
    // counter (which starts at 1).
    for (let i = 1; i <= 16; i++) {
      seedProjectile(shard, 100 + i, { x: 1000 * i, y: 0, z: 0 }, 'ghost-target');
    }
    expect([...shard.entities.values()].filter((e) => e.kind === 'projectile')).toHaveLength(16);

    shard.handleFire('p1', { weapon: 'missile', targetId: 'ship-p2' });
    advance(shard, 50);

    expect(shard.entities.has('proj:101')).toBe(false); // oldest expired by the cap
    expect(shard.entities.has('proj:102')).toBe(true);
    expect(shard.entities.has('proj:116')).toBe(true);
    expect(shard.entities.has('proj:1')).toBe(true); // the fresh shot (shard seq 1)
    expect([...shard.entities.values()].filter((e) => e.kind === 'projectile')).toHaveLength(16);
    shard.stop();
  });

  it('no valid target: the missile fire is a DENIED drop (no entity, no event, no energy)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 1500 }, 'scout', b); // > 800 m range
    warmup(shard);

    shard.handleFire('p1', { weapon: 'missile', targetId: 'ship-p2' });
    expect(shard.entities.get('ship-p1')!.energy).toBe(100); // refused BEFORE acceptance
    shard.handleFire('p1', { weapon: 'missile' }); // and one with no target at all
    advance(shard, 100);

    expect([...shard.entities.values()].filter((e) => e.kind === 'projectile')).toHaveLength(0);
    expect(events(a)).toHaveLength(0);
    expect(events(b)).toHaveLength(0);
    expect(shard.entities.get('ship-p1')!.energy).toBe(100); // denied fires spend nothing
    shard.stop();
  });
});

describe('anti-spam: 30 fires/s locks the weapons for 5 s', () => {
  it('the 30th fire in 1 s trips the lock; locked fires answer weapon-locked; the lock lifts after 5 s', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 100 }, 'scout', b);
    warmup(shard);

    // 30 fires at the SAME fake instant (one 1 s window, zero ticks between).
    for (let i = 0; i < 30; i++) {
      shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    }
    expect(errors(a).filter((e) => e.code === 'weapon-locked')).toHaveLength(1); // the 30th
    // Only the FIRST shot was ever accepted: rate-limited drops spent nothing.
    expect(shard.entities.get('ship-p1')!.energy).toBeCloseTo(98, 9);

    advance(shard, 50);
    expect(events(a).filter((e) => e.kind === 'laser-fired')).toHaveLength(1); // one hit total
    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 8 / 50, 9);

    // Still locked at +1 s: the fire is refused (error, no event).
    advance(shard, 1_000);
    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    expect(errors(a).filter((e) => e.code === 'weapon-locked')).toHaveLength(2);
    advance(shard, 50);
    expect(events(a).filter((e) => e.kind === 'laser-fired')).toHaveLength(1);

    // +5 s total: the lock has lifted and firing works again.
    advance(shard, 4_100);
    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    advance(shard, 50);
    expect(errors(a).filter((e) => e.code === 'weapon-locked')).toHaveLength(2); // no new refusals
    expect(events(a).filter((e) => e.kind === 'laser-fired')).toHaveLength(2);
    expect(shard.entities.get('ship-p2')!.shields).toBeCloseTo(1 - 16 / 50, 9);
    shard.stop();
  });
});

describe('denied fires spend nothing (the client never claims a hit)', () => {
  it('firing while destroyed is dropped: the ship ignores combat intents', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 100 }, 'scout');
    warmup(shard);

    shard.entities.get('ship-p1')!.destroyed = true; // kill p1 out of band
    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    advance(shard, 100);

    expect(events(a)).toHaveLength(0);
    expect(shard.entities.get('ship-p2')!.shields).toBe(1);
    shard.stop();
  });
});
