import { describe, expect, it } from 'vitest';

import { integrateShip, type ShipState } from '@shared/physics/flight';
import { vecLength } from '@shared/physics/vec';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-85: the cruise rule on the SERVER tick. The wire action 'boost'
 * must raise the player ship's top speed ONLY while the ship is outside
 * the CRUISE_CLEARANCE_M band around every planet — the same shared
 * `cruiseAllowedAt` the client predictor uses, resolved per tick in
 * `resolveRegimeCtx`.
 */

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
  systemId: 'sys-cruise-test',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
/** First planet anchor (planetAnchor(0)). */
const ANCHOR_X = 10_000;

function makeShard(pos: { x: number; y: number; z: number }): {
  shard: SystemShard;
  entity: SimEntity;
} {
  const shard = new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: 'CRUISE-TEST-SEED',
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
  const entity: SimEntity = {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'pilot',
    classId: 'scout',
    ship: {
      pos,
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 }, // facing +Z
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
  };
  shard.addEntity(entity);
  shard.registerConnection('p1', 'pilot', () => {});
  return { shard, entity };
}

/** Hold thrust + boost (the wire action) for 5 s of 20 Hz ticks. */
function holdBoost(shard: SystemShard, entity: SimEntity, seconds: number): number {
  let seq = 0;
  const frame: InputPayload = {
    seq: 0,
    thrust: 1,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    action: 'boost',
  };
  let top = 0;
  for (let i = 0; i < seconds * 20; i++) {
    shard.enqueueInput('p1', { ...frame, seq: ++seq });
    shard.sim.step(25 + (i + 1) * 50);
    top = Math.max(top, vecLength(entity.ship.vel));
  }
  return top;
}

describe('TASK-85: server cruise boost', () => {
  it('deep space: a player ship sending boost exceeds 120 m/s within 5 s of thrust', () => {
    // 10 km from the nearest anchor — far outside the 1 000 + 1 500 m band.
    const { shard, entity } = makeShard({ x: 0, y: 50, z: 0 });
    const top = holdBoost(shard, entity, 5);
    expect(top, 'top speed over the 5 s boost').toBeGreaterThan(120);
    // and the ship is still in space (it flew +Z, away from the anchors)
    expect(entity.ship.regime).toBe('space');
  });

  it('near a planet (2 km out, inside the clearance band): boost does nothing', () => {
    // 2 000 m from the anchor < 1 000 + 1 500 → cruiseAllowedAt is false,
    // so the same input frame tops out at the scout's normal 120.
    const { shard, entity } = makeShard({ x: ANCHOR_X - 2000, y: 300, z: 0 });
    const top = holdBoost(shard, entity, 5);
    expect(top, 'top speed over the 5 s "boost"').toBeLessThanOrEqual(121);
    expect(entity.ship.regime).toBe('space');
  });

  it('AI ships never cruise: integrated without options, a boost demand stays capped at 120', () => {
    // The AI path (stepAiShips) integrates WITHOUT FlightOptions —
    // cruiseAllowed defaults to false — so even a boost-bearing demand
    // frame never raises the cap (rogues keep their ZERO_SHIP_INPUT-style
    // boost-0 inputs; this proves the default path is non-boosting).
    let s: ShipState = {
      pos: { x: 0, y: 50, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    for (let i = 0; i < 200; i++) {
      s = integrateShip(
        s,
        { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 1 },
        0.05,
        'space',
        undefined,
        'scout',
      );
      expect(vecLength(s.vel), `t=${((i + 1) * 0.05).toFixed(2)}s`).toBeLessThanOrEqual(
        120 + 1e-9,
      );
    }
  });
});
