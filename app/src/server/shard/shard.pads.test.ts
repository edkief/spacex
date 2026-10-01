import { describe, expect, it } from 'vitest';

import { quatIdentity, vecLength, type Vec3 } from '@shared/physics/vec';
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
 * TASK-29.1: pad + docking tests through the REAL SimLoop (following
 * shard.regime.test.ts exactly: makeShard with stub repo/shipSwapBus/log,
 * shard.addEntity + registerConnection, one tick per sim.step, inputs via
 * enqueueInput, events via shard.events).
 *
 * The pad's EXACT position always comes from padsForSystem(seed, system) —
 * never hardcoded (the pad sits at planetAnchor(0) + the chunk (0,0) local
 * offset, ~10 km from the origin; without the anchor offset it would be far
 * outside the atmosphere and the surface regime unreachable).
 *
 * Approaches are VTOL-OFF drops: the v1 atmosphere model has no main
 * thruster and VTOL LIFT EXACTLY CANCELS GRAVITY (VTOL_LIFT = GRAVITY), so
 * `up = 1` hovers in place wherever the ship is — VTOL can decelerate a
 * fall to a hover, but it can never bring a ship DOWN (it has no net
 * downward force). The only path to the surface regime is the ground clamp
 * zeroing the vertical velocity on touchdown (the 'coast' precedent in
 * shard.regime.test.ts). The VTOL assist math itself (gate + ×0.5 damping)
 * is unit-tested in src/shared/world/pads.test.ts.
 *
 * Scenarios: (a) DOCK — drop from low inside the atmosphere onto the flat
 * pad; the ground clamp settles it into the surface regime → 'pad-dock'
 * event + entityToState 'docked' {padId}; (b) TAKEOFF — from docked, inject
 * vertical speed > 2 u/s as scripted state (the v1 atmosphere model cannot
 * climb on VTOL alone — VTOL exactly cancels gravity; precedent: the
 * 'ascent' phase in shard.regime.test.ts) → 'pad-undock' within one tick;
 * (c) HYSTERESIS — a docked/tracked ship moved to 21–25 m keeps its pad
 * (no undock), beyond 25 m releases; (d) INVARIANT — across all phases,
 * entity.padId is ever at most one id and 'pad-dock' never re-fires while
 * already docked.
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
/** The system's single seeded pad — the authoritative position for every scenario. */
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];

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

/** A ship resting at `pos`, inside its planet's atmosphere (the pad is close to the anchor). */
function makeEntity(pos: Vec3): SimEntity {
  return {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'pilot',
    classId: 'scout',
    ship: {
      pos,
      vel: { x: 0, y: 0, z: 0 },
      quat: quatIdentity(),
      regime: 'atmosphere',
    },
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

/**
 * One tick per call: sim time advances exactly 50 ms per call, so (after the
 * first call, which owes two ticks from t = 0) each call runs exactly one
 * tick. Tick numbers are always read from shard.sim.tickNumber, never counted
 * locally, so "within one tick" assertions stay exact.
 */
function makeStepper(shard: SystemShard): () => void {
  let t = 25;
  return () => {
    t += 50;
    shard.sim.step(t);
  };
}

/**
 * The terrain (with the pad's flat-disc override) exactly as the shard's
 * regime/physics seams see it — same seed + planet ⇒ identical chunks.
 */
const terrain = new TerrainContext(SEED, PLANET);
function localGroundY(x: number, z: number): number {
  terrain.update(x, z);
  return padSurfaceHeight(x, z, terrain.heightAt(x, z), PAD);
}

/** One pad-dock / pad-undock event as observed by the test (tick = sim tickNumber). */
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
 * Bring the ship onto the pad: drop from `altitude` above the pad center
 * with no input. The ground clamp zeroes the vertical velocity on
 * touchdown → the shared regime machine resolves 'surface' → the pad state
 * machine fires 'pad-dock' (see the VTOL note in the file header: the v1
 * model cannot descend under VTOL, so the approach is a plain drop).
 * Returns the sim tick at which docked was reached.
 */
function approachAndDock(
  shard: SystemShard,
  entity: SimEntity,
  frames: () => InputPayload,
  step: () => void,
  altitude: number,
): number {
  expect(
    shard.teleportForTesting('p1', { x: PAD.pos.x, y: PAD.pos.y + altitude, z: PAD.pos.z }),
  ).toBe(true);
  for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) {
    shard.enqueueInput('p1', frames());
    step();
  }
  if (entity.padId !== PAD.padId) {
    throw new Error(
      `ship never docked (regime ${entity.ship.regime}, pos ${JSON.stringify(entity.ship.pos)})`,
    );
  }
  return shard.sim.tickNumber;
}

describe('TASK-29.1 (a): dock transition through the real SimLoop', () => {
  it('VTOL-off drop onto the pad: pad-dock event with the pad id, wire state docked {padId}', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 60, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    const events: PadEvent[] = [];
    recordPadEvents(shard, events);

    const dockTick = approachAndDock(shard, entity, frames, step, 60);

    // The ship settled ONTO the pad disc (flat at the pad height).
    expect(horizontalDistanceM(entity.ship.pos, PAD)).toBeLessThanOrEqual(20);
    expect(Math.abs(entity.ship.pos.y - PAD.pos.y)).toBeLessThanOrEqual(1);
    expect(entity.ship.regime).toBe('surface');
    expect(vecLength(entity.ship.vel)).toBeLessThan(2);

    // Exactly one 'pad-dock' event, carrying the seeded pad id, on the tick the state flipped.
    const docks = events.filter((e) => e.kind === 'pad-dock');
    expect(docks).toHaveLength(1);
    expect(docks[0].padId).toBe(PAD.padId);
    expect(docks[0].tick).toBe(dockTick);
    expect(events.filter((e) => e.kind === 'pad-undock')).toHaveLength(0);

    // The wire state: regime 'docked' + padId.
    const state = entityToState(entity);
    expect(state.regime).toBe('docked');
    expect(state.padId).toBe(PAD.padId);
    expect(state.flightRegime).toBe('surface');
  });
});

describe('TASK-29.1 (b): takeoff transition through the real SimLoop', () => {
  it('vertical speed > 2 u/s clears docked within one tick (wire back to non-docked)', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 60, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    const events: PadEvent[] = [];
    recordPadEvents(shard, events);
    approachAndDock(shard, entity, frames, step, 60);
    expect(entity.padId).toBe(PAD.padId);

    // TAKEOFF: the v1 atmosphere model cannot climb on VTOL alone (VTOL
    // exactly cancels gravity), so the climb is a scripted state — vel.y = 5
    // u/s (> DOCK_VERTICAL_SPEED_MAX_M_S = 2) injected every tick, the
    // precedent of the 'ascent' phase in shard.regime.test.ts.
    const takeoffTick = shard.sim.tickNumber;
    for (let i = 0; i < 3 && entity.padId !== undefined; i++) {
      entity.ship.vel = { x: 0, y: 5, z: 0 };
      shard.enqueueInput('p1', frames());
      step();
    }
    const undocks = events.filter((e) => e.kind === 'pad-undock');
    expect(undocks).toHaveLength(1);
    // Cleared within ONE tick of the first > 2 u/s vertical speed.
    expect(undocks[0].tick).toBeGreaterThanOrEqual(takeoffTick);
    expect(undocks[0].tick).toBeLessThanOrEqual(takeoffTick + 1);
    expect(entity.padId).toBeUndefined();

    // Wire state back to non-docked.
    const state = entityToState(entity);
    expect(state.regime).toBe('sublight');
    expect(state.padId).toBeUndefined();
  });
});

describe('TASK-29.1 (c): hysteresis band in the sim', () => {
  it('a docked ship moved to 21–25 m keeps its pad; beyond 25 m it releases', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 60, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    const events: PadEvent[] = [];
    recordPadEvents(shard, events);
    approachAndDock(shard, entity, frames, step, 60);
    expect(entity.padId).toBe(PAD.padId);

    // Move the docked ship to 23 m out, resting on the local (blended)
    // ground: low and slow, inside the 20–25 m anti-flap band.
    const bandX = PAD.pos.x + 23;
    expect(
      shard.teleportForTesting('p1', { x: bandX, y: localGroundY(bandX, PAD.pos.z), z: PAD.pos.z }),
    ).toBe(true);
    for (let i = 0; i < 4; i++) {
      shard.enqueueInput('p1', frames());
      step();
    }
    expect(horizontalDistanceM(entity.ship.pos, PAD)).toBeGreaterThan(20);
    expect(horizontalDistanceM(entity.ship.pos, PAD)).toBeLessThanOrEqual(25);
    // Kept: still pad-docked, NO undock event in the band.
    expect(entity.padId).toBe(PAD.padId);
    expect(events.filter((e) => e.kind === 'pad-undock')).toHaveLength(0);
    expect(entityToState(entity).regime).toBe('docked');

    // Beyond the 25 m release radius: the pad is released within one tick.
    const farX = PAD.pos.x + 26;
    const releaseTick = shard.sim.tickNumber;
    expect(
      shard.teleportForTesting('p1', { x: farX, y: localGroundY(farX, PAD.pos.z), z: PAD.pos.z }),
    ).toBe(true);
    for (let i = 0; i < 2; i++) {
      shard.enqueueInput('p1', frames());
      step();
    }
    const undocks = events.filter((e) => e.kind === 'pad-undock');
    expect(undocks).toHaveLength(1);
    expect(undocks[0].tick).toBeGreaterThanOrEqual(releaseTick);
    expect(undocks[0].tick).toBeLessThanOrEqual(releaseTick + 1);
    expect(entity.padId).toBeUndefined();
    expect(entityToState(entity).regime).toBe('sublight');
  });
});

describe('TASK-29.1 (d): one-pad-per-ship invariant across all phases', () => {
  it('padId is ever at most one id and pad-dock never re-fires while docked', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 60, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    const events: PadEvent[] = [];
    recordPadEvents(shard, events);
    const padIdsSeen = new Set<string>();

    /** One input frame + one tick, asserting the no-re-fire invariant per tick. */
    const stepOnce = (input?: Partial<InputPayload>) => {
      shard.enqueueInput('p1', frames(input));
      const wasDocked = entity.padId !== undefined;
      const docksBefore = events.filter((e) => e.kind === 'pad-dock').length;
      step();
      if (entity.padId !== undefined) padIdsSeen.add(entity.padId);
      const docksAfter = events.filter((e) => e.kind === 'pad-dock').length;
      if (docksAfter > docksBefore) {
        expect(wasDocked, `pad-dock re-fired while docked at tick ${shard.sim.tickNumber}`).toBe(
          false,
        );
      }
    };

    // Phase 1: dock (VTOL-off drop — the v1 model cannot descend under VTOL).
    for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) stepOnce();
    expect(entity.padId).toBe(PAD.padId);

    // Phase 2: hysteresis band (23 m, low and slow) — pad kept, no events.
    const bandX = PAD.pos.x + 23;
    expect(
      shard.teleportForTesting('p1', { x: bandX, y: localGroundY(bandX, PAD.pos.z), z: PAD.pos.z }),
    ).toBe(true);
    for (let i = 0; i < 4; i++) stepOnce();
    expect(entity.padId).toBe(PAD.padId);
    expect(events.filter((e) => e.kind === 'pad-undock')).toHaveLength(0);

    // Phase 3: release (26 m) — undock.
    const farX = PAD.pos.x + 26;
    expect(
      shard.teleportForTesting('p1', { x: farX, y: localGroundY(farX, PAD.pos.z), z: PAD.pos.z }),
    ).toBe(true);
    for (let i = 0; i < 4 && entity.padId !== undefined; i++) stepOnce();
    expect(entity.padId).toBeUndefined();

    // Phase 4: re-approach from 40 m — a second, legitimate dock. (VTOL-off
    // drop: the ship arrives in the 'surface' regime from phase 3, and VTOL
    // would hover it at 40 m forever — lift exactly cancels gravity.)
    expect(shard.teleportForTesting('p1', { x: PAD.pos.x, y: PAD.pos.y + 40, z: PAD.pos.z })).toBe(
      true,
    );
    for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) stepOnce();
    expect(entity.padId).toBe(PAD.padId);

    // Invariants across ALL phases:
    const docks = events.filter((e) => e.kind === 'pad-dock');
    const undocks = events.filter((e) => e.kind === 'pad-undock');
    expect(docks).toHaveLength(2); // dock → release → dock again
    expect(undocks).toHaveLength(1);
    for (const e of docks) expect(e.padId).toBe(PAD.padId); // one id, always the seeded one
    expect(padIdsSeen).toEqual(new Set([PAD.padId])); // entity.padId never any other id
  });
});
