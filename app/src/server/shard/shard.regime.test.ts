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
const ATMO_R = 1000; // planetAtmosphereRadius (1 km)
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
 * Script: approach in space on a flat -X run at y = 300 (d < 1000 enters the
 * atmosphere); retro-burn + VTOL to bleed speed to ≤ 4.5 u/s (surface
 * eligibility); cut VTOL and settle onto the terrain (alt < 2 u → surface);
 * then a scripted climb (orientation set to face +Y, thrust 1) through the
 * surface hysteresis band (→ atmosphere) and out of the atmosphere (→ space).
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
      quat: quatFromEuler(0, -Math.PI / 2, 0), // facing -X, toward the planet
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

  type Phase = 'approach' | 'brake' | 'settle' | 'ascent' | 'done';
  let phase: Phase = 'approach';
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
      phase === 'approach' || phase === 'ascent'
        ? frame({ thrust: 1 })
        : phase === 'brake'
          ? frame({ thrust: -1, action: 'vtol' })
          : frame({});
    shard.enqueueInput('p1', payload);
    // One tick per call: t starts at 25 so each step() owes exactly 1 tick.
    shard.sim.step(25 + (i + 1) * 50);

    switch (phase) {
      case 'approach':
        if (entity.ship.regime === 'atmosphere') phase = 'brake';
        break;
      case 'brake':
        // Slow enough to be surface-eligible, then cut VTOL and settle.
        if (vecLength(entity.ship.vel) <= 4.5) {
          phase = 'settle';
          settleTicks = 0;
        }
        break;
      case 'settle':
        if (entity.ship.regime === 'surface') {
          settleTicks += 1;
          if (settleTicks >= 2) {
            // Scripted orientation for the climb (no position change).
            entity.ship.quat = quatFromEuler(0, -Math.PI / 2, 0);
            phase = 'ascent';
          }
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
