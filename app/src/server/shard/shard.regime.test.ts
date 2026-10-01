import { describe, expect, it } from 'vitest';

import { quatFromEuler, vecLength } from '@shared/physics/vec';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-25 integration: a scripted flight through ALL transitions
 * (space → atmosphere → surface → atmosphere → space) driven through the
 * REAL SimLoop — inputs enqueue into the shard's per-connection queue and
 * the regime is resolved inside the actual 20 Hz tick (shared regimeFor,
 * shared integrateShip, chunk-cached terrain). The regime sequence must be
 * EXACT (one transition per boundary crossing — hysteresis) both on clean
 * positions and under ±1 u of position noise.
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
  aiRoster: { count: 2, classes: ['scout', 'scout'] },
};
const SYSTEM: SystemGen = {
  systemId: 'sys-regime-test',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
/** First planet anchor (planetAnchor(0) in shared/galaxy/planets). */
const ANCHOR_X = 10_000;
/** The exact expected regime sequence (no duplicates, one per crossing). */
const EXPECTED: string[] = ['space', 'atmosphere', 'surface', 'atmosphere', 'space'];

function makeShard(): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: 'REGIME-TEST-SEED',
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

/**
 * Run the scripted flight. Returns the observed regime sequence (initial
 * regime + one entry per 'regime-change' event).
 *
 * Script (driven through the REAL SimLoop via enqueueInput + sim.step):
 * - cruise: full thrust in space on a flat -X run at y = 300 toward the
 *   planet (inertial model);
 * - retro: full retro until the ship is SLOW (≤ 4 u/s, still inbound). The
 *   TASK-22 atmosphere regime has no main thruster — only drag, gravity and
 *   hover VTOL — so the ship must ENTER the atmosphere surface-eligible;
 * - coast: dead-sticks into the atmosphere at ~4 u/s, then falls (no VTOL
 *   input) onto the terrain. The ground clamp zeroes the vertical velocity,
 *   so the ship ends low + slow → the shared machine resolves 'surface';
 * - settle: two on-surface ticks, then a scripted vertical kick (vel.y = 4000):
 *   the v1 atmosphere model cannot climb under its own power (VTOL exactly
 *   cancels gravity, and drag caps any ballistic climb at ~400 u for this
 *   density), so the ascent is an external impulse applied as scripted state
 *   — but the regime transitions it triggers are still resolved by the real
 *   state machine in the real tick;
 * - ascent: coasts up through the surface band (→ atmosphere) and past the
 *   1.05 exit radius (→ space) no matter where the terrain put the ship,
 *   drag decaying the kick along the way.
 */
function runScriptedFlight(noise: boolean): string[] {
  const shard = makeShard();
  const entity: SimEntity = {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'pilot',
    classId: 'scout',
    ship: {
      pos: { x: ANCHOR_X + 3000, y: 300, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: quatFromEuler(-Math.PI / 2, 0, 0), // yaw -90°: facing -X, toward the planet
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
  };
  shard.addEntity(entity);
  shard.registerConnection('p1', 'pilot', () => {});

  const sequence: string[] = [entity.ship.regime];
  shard.events.on('regime-change', (e: { to: string }) => sequence.push(e.to));

  type Phase = 'cruise' | 'retro' | 'coast' | 'settle' | 'ascent' | 'done';
  let phase: Phase = 'cruise';
  let settleTicks = 0;
  let seq = 0;
  const frame = (partial: Partial<InputPayload>): InputPayload => ({
    seq: ++seq,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    ...partial,
  });

  for (let i = 0; i < 6000 && phase !== 'done'; i++) {
    // The noisy run perturbs the position ±1 u on every axis before the tick
    // resolves the regime (hysteresis must hold).
    if (noise) {
      entity.ship.pos.x += i % 3 === 0 ? 1 : -1;
      entity.ship.pos.y += i % 3 === 1 ? 1 : -1;
      entity.ship.pos.z += i % 3 === 2 ? 1 : -1;
    }
    const payload =
      phase === 'cruise'
        ? frame({ thrust: 1 })
        : phase === 'retro'
          ? frame({ thrust: -1 })
          : frame({}); // coast / settle / ascent: no input
    shard.enqueueInput('p1', payload);
    // One tick per call: t starts at 25 so each step() owes exactly 1 tick.
    shard.sim.step(25 + (i + 1) * 50);

    switch (phase) {
      case 'cruise':
        // Well clear of the exit radius (d ≈ 1480 at this point): start the
        // retro so the ship is slow before it gets anywhere near the planet.
        if (entity.ship.pos.x <= ANCHOR_X + 1450) phase = 'retro';
        break;
      case 'retro':
        // Surface-eligible speed, still inbound (holding the retro past rest
        // would accelerate the ship back out of the system).
        if (vecLength(entity.ship.vel) <= 4) phase = 'coast';
        break;
      case 'coast':
        // d < 1000 enters the atmosphere; with no VTOL input the ship then
        // falls onto the terrain. The ground clamp zeroes the vertical
        // velocity, so the ship ends low + slow → 'surface' on the next tick.
        if (entity.ship.regime === 'surface') {
          phase = 'settle';
          settleTicks = 0;
        }
        break;
      case 'settle':
        if (entity.ship.regime === 'surface') settleTicks += 1;
        else settleTicks = 0;
        if (settleTicks >= 2) {
          // Scripted climb impulse (see the function doc): vertical, pure +Y.
          // 4000 u/s clears the ~400 u max-ballistic-climb ceiling of this
          // atmosphere at every possible landing spot (worst case: flat
          // terrain at the entry boundary → ~325 u to the exit radius).
          entity.ship.vel = { x: 0, y: 4000, z: 0 };
          phase = 'ascent';
        }
        break;
      case 'ascent':
        if (entity.ship.regime === 'space') phase = 'done';
        break;
    }
  }
  return sequence;
}

describe('TASK-25 integration: scripted full-regime flight through the real SimLoop', () => {
  it('clean positions: exact sequence space → atmosphere → surface → atmosphere → space', () => {
    const sequence = runScriptedFlight(false);
    expect(sequence).toEqual(EXPECTED);
  });

  it('noisy positions (±1 u every tick): same exact sequence, hysteresis holds', () => {
    const sequence = runScriptedFlight(true);
    expect(sequence).toEqual(EXPECTED);
  });

  it('the entity ends in space with no owning planet (and the ship survived)', () => {
    const shard = makeShard();
    const entity: SimEntity = {
      id: 'ship-p1',
      kind: 'ship',
      playerId: 'p1',
      callsign: 'pilot',
      classId: 'scout',
      ship: {
        pos: { x: ANCHOR_X + 1200, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'atmosphere',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
    };
    shard.addEntity(entity);
    // Outside the exit radius (d = 1200 ≥ 1050): the tick resolves to space
    // and clears the planet ownership.
    shard.sim.step(25);
    expect(entity.ship.regime).toBe('space');
    expect(entity.planetId).toBeUndefined();
    expect(entity.hull).toBe(1);
  });

  it('entity_update carries the authoritative flight regime', () => {
    const shard = makeShard();
    const sends: string[] = [];
    const entity: SimEntity = {
      id: 'ship-p1',
      kind: 'ship',
      playerId: 'p1',
      callsign: 'pilot',
      classId: 'scout',
      ship: {
        pos: { x: ANCHOR_X + 3000, y: 0, z: 0 },
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
    const conn = shard.registerConnection('p1', 'pilot', (buffer) => sends.push(buffer));
    expect(conn).toBeTruthy();
    // Snapshot cadence is every 2nd tick with ≥1 connection.
    shard.sim.step(25);
    shard.sim.step(75);
    expect(sends.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(sends[sends.length - 1]);
    expect(snapshot.type).toBe('entity_update');
    const me = snapshot.payload.entities.find((e: { id: string }) => e.id === 'ship-p1');
    expect(me).toBeTruthy();
    expect(me.flightRegime).toBe('space');
  });
});
