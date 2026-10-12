import { describe, expect, it } from 'vitest';

import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padSurfaceHeight, padsForSystem, type PadInfo } from '@shared/world/pads';
import { SystemShard } from './shard';
import type { SimEntity } from './types';
import { TerrainContext } from './terrain';

/**
 * TASK-106: VTOL hover through the REAL shard tick — the wire 'hover' action
 * tag flows through inputToShipInput into the shared integrateShip altitude-
 * hold (the server seam: TerrainContext heightAt + planetAtmosphereDensity,
 * no tick-loop change). Same harness as shard.pads.approach.test.ts: stub
 * repo/bus/log, addEntity + registerConnection, one tick per sim.step,
 * inputs via enqueueInput.
 *
 * Script (deterministic — fixed seed, no wall clock, no Math.random in the
 * sim):
 * - a ship teleported 100 m above the terrain, far from the pad;
 * - 400 ticks (20 s) of frames with action 'hover' → the ship must settle at
 *   terrain + 10 m ± 2 m with |vel.y| < 0.5 u/s;
 * - 30 ticks of frames WITHOUT the tag → plain gravity takes over and the
 *   ship descends (hover off is the pre-TASK-106 behavior).
 */

const SEED = 'HOVER-SIM-SEED';
// Gas class: the thickest atmosphere (base density 0.12 × seeded [0.5, 1.0))
// — the drag-limited approach speed keeps the 10 m hold's first pass inside
// the ± 2 m band on every seeded planet in the class range.
const PLANET: Planet = {
  id: 'planet-1',
  name: 'Thrix',
  class: 'gas',
  radiusKm: 3000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ['iron'],
  aiRoster: { count: 2, classes: ['scout', 'scout'] },
};
const SYSTEM: SystemGen = {
  systemId: 'sys-hover-sim',
  name: 'Thrix system',
  star: { class: 'G', name: 'Thrix' },
  planets: [PLANET],
};
/** The system's single seeded pad — the ship starts far away from it. */
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];
const START_OFFSET_M = 300; // well outside the pad's flat-disc blend radius

function makeShard(): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: SEED,
    system: SYSTEM,
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

function makeEntity(pos: Vec3, vel: Vec3): SimEntity {
  return {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'pilot',
    classId: 'scout',
    ship: { pos, vel, quat: quatIdentity(), regime: 'atmosphere' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId: PLANET.id,
  };
}

/** Wire frame factory with an incrementing seq (latest-wins, stale rejected). */
function makeFrames(): (partial?: Partial<InputPayload>) => InputPayload {
  let seq = 0;
  return (partial: Partial<InputPayload> = {}) => ({
    seq: ++seq,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    ...partial,
  });
}

/** One tick per call (shard.pads.test.ts convention; tick count = sim time / 50 ms). */
function makeStepper(shard: SystemShard): () => void {
  let t = 25;
  return () => {
    t += 50;
    shard.sim.step(t);
  };
}

/** Local ground exactly as the shard's physics/regime seams see it (pad disc flat). */
const terrain = new TerrainContext(SEED, PLANET);
function groundYAt(x: number, z: number): number {
  terrain.update(x, z);
  return padSurfaceHeight(x, z, terrain.heightAt(x, z), PAD);
}

describe('TASK-106: VTOL hover — 10 m altitude-hold through the real shard tick', () => {
  it('a 100 m ship fed "hover" settles at terrain + 10 m ± 2 m; removing the tag makes it descend', () => {
    const shard = makeShard();
    const x = PAD.pos.x + START_OFFSET_M;
    const z = PAD.pos.z;
    const entity = makeEntity({ x, y: groundYAt(x, z) + 100, z }, { x: 0, y: 0, z: 0 });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);

    // 20 s of 'hover' input (the altitude hold is the ONLY active demand).
    for (let i = 0; i < 400; i++) {
      shard.enqueueInput('p1', frames({ action: 'hover' }));
      step();
    }
    const alt = entity.ship.pos.y - groundYAt(entity.ship.pos.x, entity.ship.pos.z);
    expect(Math.abs(alt - 10), 'settled altitude').toBeLessThanOrEqual(2);
    expect(Math.abs(entity.ship.vel.y), 'settled vertical speed').toBeLessThan(0.5);
    // The ship stayed on its planet in the atmosphere (the hover branch ran).
    expect(entity.planetId).toBe(PLANET.id);
    expect(['atmosphere', 'surface']).toContain(entity.ship.regime);

    // Hover OFF: plain gravity — the ship descends within 30 ticks (1.5 s).
    const y0 = entity.ship.pos.y;
    for (let i = 0; i < 30; i++) {
      shard.enqueueInput('p1', frames());
      step();
    }
    expect(entity.ship.pos.y, 'descending after the tag was removed').toBeLessThan(y0 - 1);
  });
});
