import { describe, expect, it } from 'vitest';

import { quatIdentity, vecLength, type Vec3 } from '@shared/physics/vec';
import { ATMOSPHERE_BOUNDARY_M } from '@shared/physics/atmosphere';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import {
  horizontalDistanceM,
  padSurfaceHeight,
  padsForSystem,
  type PadInfo,
} from '@shared/world/pads';
import { SystemShard, entityToState } from './shard';
import type { SimEntity } from './types';
import { TerrainContext } from './terrain';

/**
 * TASK-29.2: the VTOL-assisted approach — a scripted approach that STARTS
 * 100 m from the pad and converges to the 'docked' state in under 15 s of
 * sim time, through the REAL SimLoop (same harness as shard.pads.test.ts:
 * stub repo/bus/log, addEntity + registerConnection, one tick per
 * sim.step, inputs via enqueueInput, pad position from padsForSystem only).
 *
 * Phase script (deterministic — fixed seed, no wall clock, no
 * Math.random anywhere in the sim; the switch rule is a pure function of
 * the ship's own state):
 * - GLIDE (up = 0): the ship starts 100 m horizontally from the pad center
 *   at 50 m altitude (well below the 1 km atmosphere boundary) with a
 *   90 u/s velocity aimed straight at the pad. The atmosphere regime has no
 *   main thruster — initial momentum + drag carry the horizontal part while
 *   gravity carries the descent (quadratic drag decays speed logarithmically,
 *   so a few u/s inbound would stall short; 90 u/s dead-sticks the 100 m);
 * - VTOL (up = 1): when the ship is within 25 m of the pad AND below 2 m
 *   altitude, the VTOL key is held for the final phase. The committed
 *   server-side assist (×0.5/tick on horizontal drift, applyVtolAssist)
 *   then kills the residual drift while the ship settles onto the flat pad
 *   disc (padSurfaceHeight — anywhere inside the 20 m disc is EXACTLY at
 *   the pad height). The key switches on only in this final phase: at 100 m
 *   the ×0.5/tick assist would freeze the ship short, and VTOL lift exactly
 *   cancels gravity (VTOL_LIFT = GRAVITY) so it can never bring a ship down
 *   from altitude (the TASK-29.1 pinned finding — the approach descends,
 *   it never climbs in);
 * - SETTLE: resting on the disc (ground clamp, |vel.y| < 2, ≤ 20 m, altitude
 *   within 1 m of the pad) with the 'surface' regime → the pad state machine
 *   fires 'pad-dock' and the wire state reads 'docked' {padId}.
 *
 * Measured outcome: docked at tick 90 (90 × 50 ms = 4.5 s of sim time —
 * well inside the 15 s budget), ~13 m from the pad center.
 */

const SEED = 'PAD-SIM-SEED';
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
  systemId: 'sys-pad-sim',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
/** The system's single seeded pad — the authoritative position (never hardcoded). */
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];

/** Approach constants (the tuned script — see the phase comment above). */
const START_DISTANCE_M = 100; // horizontal start distance from the pad center
const START_ALTITUDE_M = 50; // above the pad — below the atmosphere boundary
const INBOUND_SPEED_M_S = 90; // u/s aimed horizontally at the pad center
const VTOL_SWITCH_DIST_M = 25; // final phase: within this range …
const VTOL_SWITCH_ALT_M = 2; // … and below this altitude, hold the VTOL key
const BUDGET_TICKS = 300; // 15 s at the 50 ms tick

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

/** The 100 m start position + the inbound velocity aimed at the pad center. */
function startState(): { pos: Vec3; vel: Vec3 } {
  const pos: Vec3 = {
    x: PAD.pos.x - START_DISTANCE_M,
    y: PAD.pos.y + START_ALTITUDE_M,
    z: PAD.pos.z,
  };
  return { pos, vel: { x: INBOUND_SPEED_M_S, y: 0, z: 0 } };
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
function localGroundY(x: number, z: number): number {
  terrain.update(x, z);
  return padSurfaceHeight(x, z, terrain.heightAt(x, z), PAD);
}

/** The VTOL key for the current state: GLIDE (off) vs VTOL (final phase, on). */
function vtolKeyHeld(pos: Vec3): boolean {
  return (
    horizontalDistanceM(pos, PAD) <= VTOL_SWITCH_DIST_M &&
    pos.y - localGroundY(pos.x, pos.z) < VTOL_SWITCH_ALT_M
  );
}

interface PadEvent {
  kind: 'pad-dock' | 'pad-undock';
  tick: number;
  padId?: string;
}

function recordPadEvents(shard: SystemShard, log: PadEvent[]): void {
  shard.events.on('pad-dock', (e: { padId: string }) =>
    log.push({ kind: 'pad-dock', tick: shard.sim.tickNumber, padId: e.padId }),
  );
  shard.events.on('pad-undock', () => log.push({ kind: 'pad-undock', tick: shard.sim.tickNumber }));
}

/**
 * Run the full scripted approach in a FRESH shard. Returns the dock tick
 * (sim time = tick × 50 ms), the final entity state and the pad events.
 */
function runApproach(): {
  dockTick: number;
  pos: Vec3;
  vel: Vec3;
  regime: string;
  events: PadEvent[];
} {
  const shard = makeShard();
  const { pos, vel } = startState();
  const entity = makeEntity(pos, vel);
  shard.addEntity(entity);
  shard.registerConnection('p1', 'pilot', () => {});
  const frames = makeFrames();
  const step = makeStepper(shard);
  const events: PadEvent[] = [];
  recordPadEvents(shard, events);

  for (let i = 0; i < BUDGET_TICKS && entity.padId === undefined; i++) {
    shard.enqueueInput('p1', frames(vtolKeyHeld(entity.ship.pos) ? { action: 'vtol' } : {}));
    step();
  }
  if (entity.padId === undefined) {
    throw new Error(
      `approach never docked within ${BUDGET_TICKS} ticks (regime ${entity.ship.regime}, ` +
        `dist ${horizontalDistanceM(entity.ship.pos, PAD).toFixed(1)} m, ` +
        `alt ${(entity.ship.pos.y - PAD.pos.y).toFixed(2)} m, |v| ${vecLength(entity.ship.vel).toFixed(2)})`,
    );
  }
  const dockTick = shard.sim.tickNumber;
  return {
    dockTick,
    pos: { ...entity.ship.pos },
    vel: { ...entity.ship.vel },
    regime: entity.ship.regime,
    events,
  };
}

describe('TASK-29.2: VTOL-assisted approach, 100 m → docked in < 15 s of sim time', () => {
  it('glide (momentum + drag + gravity) then VTOL final phase: pad-dock fires under 15 s', () => {
    const shard = makeShard();
    const { pos, vel } = startState();
    const entity = makeEntity(pos, vel);
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    const events: PadEvent[] = [];
    recordPadEvents(shard, events);

    // The start is the spec's: 100 m out, below the atmosphere boundary.
    expect(horizontalDistanceM(pos, PAD)).toBe(START_DISTANCE_M);
    expect(pos.y).toBeLessThan(PAD.pos.y + ATMOSPHERE_BOUNDARY_M);

    for (let i = 0; i < BUDGET_TICKS && entity.padId === undefined; i++) {
      shard.enqueueInput('p1', frames(vtolKeyHeld(entity.ship.pos) ? { action: 'vtol' } : {}));
      step();
      // One-pad invariant, checked per tick (the TASK-29.1 invariant).
      if (entity.padId !== undefined) expect(entity.padId).toBe(PAD.padId);
    }

    // DOCKED — 'pad-dock' fired with the seeded pad id on the flip tick.
    expect(entity.padId).toBe(PAD.padId);
    const dockTick = shard.sim.tickNumber;
    const docks = events.filter((e) => e.kind === 'pad-dock');
    expect(docks).toHaveLength(1);
    expect(docks[0].padId).toBe(PAD.padId);
    expect(docks[0].tick).toBe(dockTick);
    expect(events.filter((e) => e.kind === 'pad-undock')).toHaveLength(0);

    // The 15 s budget: sim time is the tick count × the 50 ms tick.
    expect(dockTick * 50).toBeLessThan(15_000);

    // Settled ON the pad disc: flat at the pad height, within the 20 m
    // acquisition range, slow enough to be surface-regime.
    expect(horizontalDistanceM(entity.ship.pos, PAD)).toBeLessThanOrEqual(20);
    expect(Math.abs(entity.ship.pos.y - PAD.pos.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(entity.ship.vel.y)).toBeLessThan(2);
    expect(entity.ship.regime).toBe('surface');
    expect(entityToState(entity).regime).toBe('docked');
    expect(entityToState(entity).padId).toBe(PAD.padId);
    expect(entityToState(entity).flightRegime).toBe('surface');

    // And it STAYS docked: a few VTOL-held ticks of rest, no undock.
    for (let i = 0; i < 10; i++) {
      shard.enqueueInput('p1', frames({ action: 'vtol' }));
      step();
    }
    expect(entity.padId).toBe(PAD.padId);
    expect(horizontalDistanceM(entity.ship.pos, PAD)).toBeLessThanOrEqual(20);
    expect(Math.abs(entity.ship.pos.y - PAD.pos.y)).toBeLessThanOrEqual(1);
    expect(vecLength(entity.ship.vel)).toBeLessThan(2);
    expect(events.filter((e) => e.kind === 'pad-undock')).toHaveLength(0);
  });

  it('is deterministic: two fresh runs give the identical dock tick and end state', () => {
    const a = runApproach();
    const b = runApproach();
    expect(b.dockTick).toBe(a.dockTick);
    expect(b.pos).toEqual(a.pos); // exact — no hidden clock or randomness
    expect(b.vel).toEqual(a.vel);
    expect(b.regime).toBe('surface');
    expect(a.dockTick * 50).toBeLessThan(15_000);
  });
});
