import { describe, expect, it } from 'vitest';

import { generateSystem } from '@shared/galaxy/system';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { planetHeightAt } from '@shared/world/deposits';
import {
  DRONE_HIT_DAMAGE,
  DRONE_RESPAWN_MS,
  EXPOSURE_MAX,
  hazardsFor,
  type Hazard,
} from '@shared/world/hazards';
import type { InputPayload } from '@shared/protocol/schemas';
import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-48 step 4: the hazard INTEGRATION ACs through the REAL sim stack:
 * a player walks (teleports) into a rad zone (exposure drains 5/s), gets
 * knocked down at 0 (5 s 'SHIELD BURN' — movement frozen, no death in v1),
 * recovers outside; a drone cell aggroes, fires on the 2 s cadence through
 * the damage pipeline (3/hit, source 'drone'), never targets ships, and a
 * killed drone respawns with the cell after 180 s.
 *
 * The clock is fully fake: the shard's `now` is injected and each step
 * advances it exactly 50 ms (one 20 Hz tick per step — asserted), so the
 * cadence / knock-down / respawn assertions are exact.
 */

const SEED = 'HZ-SHARD-SEED';

/**
 * A single-planet system hosting a planet with ALL THREE hazard kinds —
 * scanned once from real seeded galaxies (the kinds are seeded, so the test
 * picks a planet that has storm + radzone + drones instead of assuming).
 */
function findSystem(): { system: SystemGen; planet: Planet; hazards: Hazard[] } {
  for (const starId of ['star-a', 'star-b', 'star-c', 'star-d', 'star-e']) {
    const gal = generateSystem(SEED, starId);
    for (const planet of gal.planets) {
      if (!planet.landable || planet.class === 'ocean' || planet.class === 'gas') continue;
      const system: SystemGen = { ...gal, systemId: `${gal.systemId}-hz`, planets: [planet] };
      const hazards = hazardsFor(SEED, system);
      const kinds = new Set(hazards.map((h) => h.kind));
      if (kinds.has('storm') && kinds.has('radzone') && kinds.has('drones')) {
        return { system, planet, hazards };
      }
    }
  }
  throw new Error('no seeded planet hosts all three hazard kinds');
}

/** One captured server→client envelope, stamped with the fake clock it left. */
interface Envelope {
  v: number;
  type: string;
  payload: Record<string, unknown>;
  atMs: number;
}

interface HzEnv {
  shard: SystemShard;
  /** Every frame the shard sent on the test connection (clock-stamped). */
  sent: Envelope[];
  /** Advance the fake clock 50 ms and run exactly one sim tick. */
  step: () => number;
  /** Burst-advance (up to 5 ticks per sim.step call) to a fake-clock target. */
  advance: (untilMs: number) => void;
  clock: () => number;
  frame: (partial?: Partial<InputPayload>) => InputPayload;
  dock: () => void;
  onFoot: () => void;
  /** Teleport the on-foot character (scripted position). */
  at: (pos: Vec3) => void;
}

interface ShipRowStub {
  id: string;
  ownerId: string;
  classId: string;
  position: { x: number; y: number; z: number; systemId: string };
  velocity: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  state: 'docked' | 'flying' | 'onfoot' | 'destroyed';
  regime: 'space' | 'atmosphere' | 'surface';
  hull: number;
  shields: number;
  onPad: string | null;
  livery: null;
  destroyedAt: null;
}

const SHIP_ROW: ShipRowStub = {
  id: 'ship-p1',
  ownerId: 'p1',
  classId: 'scout',
  position: { x: 0, y: 0, z: 0, systemId: 'sys' },
  velocity: { x: 0, y: 0, z: 0 },
  rotation: quatIdentity(),
  state: 'flying',
  regime: 'surface',
  hull: 100,
  shields: 50,
  onPad: null,
  livery: null,
  destroyedAt: null,
};

function makeEnv(system: SystemGen): HzEnv {
  const pad: PadInfo = padsForSystem(SEED, system)[0];
  let clock = 0;
  const sent: Envelope[] = [];
  let seq = 0;
  const shard = new SystemShard({
    systemId: system.systemId,
    galaxySeed: SEED,
    system,
    repo: {
      getShipByOwner: async (ownerId: string) =>
        ownerId === 'p1' ? (SHIP_ROW as never) : undefined,
      getPlayersByIds: async () => [],
    },
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: { debug() {}, warn() {}, info() {} },
    now: () => clock,
    spawnRogues: false,
  });
  const ship: SimEntity = {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'pilot',
    classId: 'scout',
    ship: {
      pos: { x: pad.pos.x, y: pad.pos.y + 20, z: pad.pos.z },
      vel: { x: 0, y: 0, z: 0 },
      quat: quatIdentity(),
      regime: 'atmosphere',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId: system.planets[0].id,
  };
  shard.addEntity(ship);
  shard.registerConnection('p1', 'pilot', (buffer: string) => {
    sent.push({ ...(JSON.parse(buffer) as Omit<Envelope, 'atMs'>), atMs: clock });
  });
  const frame = (partial: Partial<InputPayload> = {}): InputPayload => ({
    seq: ++seq,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    ...partial,
  });
  let t = 0;
  const step = (): number => {
    t += 50;
    clock = t;
    expect(shard.sim.step(t - 50)).toBe(1); // exactly one tick per step
    return clock;
  };
  const advance = (untilMs: number): void => {
    while (clock < untilMs) {
      const target = Math.min(untilMs, clock + 250); // ≤ 5 ticks per burst
      const ticks = (target - clock) / 50;
      clock = target;
      expect(shard.sim.step(clock - 50)).toBe(ticks);
    }
  };
  const dock = (): void => {
    for (let i = 0; i < 4000 && !ship.padId; i++) step();
    expect(ship.padId, 'ship docks on the pad').toBeTruthy();
  };
  const onFoot = (): void => {
    expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');
    expect(shard.entities.has('char:p1')).toBe(true);
  };
  const at = (pos: Vec3): void => {
    expect(shard.teleportCharacterForTesting('p1', pos)).toBe(true);
  };
  return { shard, sent, step, advance, clock: () => clock, frame, dock, onFoot, at };
}

/** The 'hit' combat frames in the captured stream (with send timestamps). */
function hitFrames(sent: Envelope[]): Array<{ target: string; sourceId: string; atMs: number }> {
  return sent
    .filter((m) => m.type === 'combat_event' && m.payload.kind === 'hit')
    .map((m) => {
      const p = m.payload as { target: string; source: { kind: string; id: string } };
      return { target: p.target, sourceId: p.source.id, atMs: m.atMs };
    });
}

describe('TASK-48: rad zone → exposure drain → knock-down → recovery (integration)', () => {
  it('drains 5/s inside, freezes the player at 0 (SHIELD BURN), regens outside', () => {
    const { system, hazards } = findSystem();
    const pad: PadInfo = padsForSystem(SEED, system)[0];
    const rad = hazards.find((h) => h.kind === 'radzone')!;
    const env = makeEnv(system);
    env.dock();
    env.onFoot();

    // Walk into the rad zone (teleport = scripted on-foot position).
    env.at({ x: rad.pos.x, y: rad.pos.y, z: rad.pos.z });
    for (let i = 0; i < 100; i++) env.step(); // 5 s in the zone
    const mid = env.shard.getHazardStateForTesting('p1');
    // 50 - 5/s * 5 s = 25, exact to the tick (0.25/tick is exact in binary).
    expect(mid.exposure).toBeGreaterThan(20);
    expect(mid.exposure).toBeLessThanOrEqual(25.01);
    expect(mid.recoveringUntilMs).toBe(0);
    // The per-connection 'hazard' frame carries the meter data.
    const hzFrames = env.sent.filter((m) => m.type === 'hazard');
    expect(hzFrames.length).toBeGreaterThan(0);
    expect((hzFrames[hzFrames.length - 1].payload as { inside?: string }).inside).toBe('radzone');

    // To the knock-down: 50 / (5/s) = exactly 10 s (100 more ticks).
    for (let i = 0; i < 100; i++) env.step();
    const down = env.shard.getHazardStateForTesting('p1');
    expect(down.exposure).toBe(0);
    expect(down.recoveringUntilMs).toBeGreaterThan(0);

    // RECOVERING: the player cannot MOVE for the 5 s window (inputs drop).
    const char = env.shard.entities.get('char:p1')!;
    const before: Vec3 = { ...char.ship.pos };
    for (let i = 0; i < 40; i++) {
      env.shard.enqueueInput('p1', env.frame({ thrust: 1 }));
      env.step();
    }
    const after: Vec3 = { ...char.ship.pos };
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.01);

    // RECOVERY: out of the zone, the pool regens 5/s after the 5 s deadline.
    env.at({ x: pad.pos.x, y: pad.pos.y, z: pad.pos.z });
    for (let i = 0; i < 500; i++) env.step(); // 25 s (covers the 5 s window)
    const healed = env.shard.getHazardStateForTesting('p1');
    expect(healed.recoveringUntilMs).toBe(0);
    expect(healed.exposure).toBe(EXPOSURE_MAX); // fully regened
  });
});

describe('TASK-48: drones — aggro, 2 s fire cadence, pipeline source, ship immunity', () => {
  it('aggros the on-foot player, fires every 2 s for 3 (source drone), drains the pool', () => {
    const { system, hazards } = findSystem();
    const cell = hazards.find((h) => h.kind === 'drones')!;
    const env = makeEnv(system);
    env.dock();
    env.onFoot();

    const droneIds = [...env.shard.drones.keys()];
    expect(droneIds.length).toBe(cell.droneCount); // seeded count (2-4)
    // Stand right next to one drone: instant aggro, instant first hit.
    const d0 = env.shard.entities.get(droneIds[0])!;
    env.at({ x: d0.ship.pos.x + 1, y: d0.ship.pos.y - 2, z: d0.ship.pos.z });

    for (let i = 0; i < 160; i++) env.step(); // 8 s under fire

    const myHits = hitFrames(env.sent).filter((h) => h.target === 'char:p1');
    expect(myHits.length).toBeGreaterThanOrEqual(2);
    // Every hit carries the pipeline source 'drone' (the AC's attribution).
    for (const m of env.sent.filter((m) => m.type === 'combat_event' && m.payload.kind === 'hit')) {
      expect((m.payload as { source: { kind: string } }).source.kind).toBe('drone');
    }
    // Each DRONE fires at most once per 2 s window (the 2 s cadence, exact
    // on the fake clock: consecutive hits from one drone ≥ 2000 ms apart).
    const byDrone = new Map<string, number[]>();
    for (const h of myHits) {
      const arr = byDrone.get(h.sourceId) ?? [];
      arr.push(h.atMs);
      byDrone.set(h.sourceId, arr);
    }
    for (const [id, stamps] of byDrone) {
      for (let i = 1; i < stamps.length; i++) {
        expect(stamps[i] - stamps[i - 1], `drone ${id} fire cadence`).toBeGreaterThanOrEqual(1950);
      }
    }
    // The pool drained by EXACTLY 3 per hit (drones cells drain nothing else).
    const state = env.shard.getHazardStateForTesting('p1');
    expect(state.exposure).toBe(Math.max(0, EXPOSURE_MAX - myHits.length * DRONE_HIT_DAMAGE));
    void cell;
  });

  it('drones never target ships (surface-only threat)', () => {
    const { system, hazards } = findSystem();
    const cell = hazards.find((h) => h.kind === 'drones')!;
    const env = makeEnv(system);
    env.dock();
    // The ship sits AT the drone cell center for 8 s (resting on the ground).
    env.shard.teleportForTesting('p1', {
      x: cell.pos.x,
      y: planetHeightAt(SEED, system.planets[0], cell.pos.x, cell.pos.z) + 0.5,
      z: cell.pos.z,
    });
    env.advance(env.clock() + 8000);
    const ship = env.shard.entities.get('ship-p1')!;
    expect(hitFrames(env.sent).filter((h) => h.target === 'ship-p1').length).toBe(0);
    expect(ship.hull).toBe(1); // untouched by the drones
    // No on-foot character exists: the drones just keep patrolling their cell.
    const drone = env.shard.entities.get([...env.shard.drones.keys()][0])!;
    expect(drone.destroyed).toBe(false);
  });

  it('a killed drone despawns and respawns with the cell after 180 s', () => {
    const { system, hazards } = findSystem();
    void hazards;
    const env = makeEnv(system);
    env.dock();
    env.onFoot();
    const droneId = [...env.shard.drones.keys()][0];
    const drone = env.shard.entities.get(droneId)!;

    expect(env.shard.damageDroneForTesting(droneId, 20)).toBe(true);
    expect(drone.destroyed).toBe(true);
    expect(drone.hull).toBe(0);
    const destroyed = env.sent.filter(
      (m) => m.type === 'combat_event' && m.payload.kind === 'destroyed',
    );
    expect(
      destroyed.some((m) => (m.payload as { target: string }).target === droneId),
    ).toBe(true);

    // Fast-forward past the 180 s respawn through the real tick (burst steps).
    env.advance(env.clock() + DRONE_RESPAWN_MS + 100);
    expect(drone.destroyed).toBe(false);
    expect(drone.hull).toBe(1); // full hull back
    expect(drone.id).toBe(droneId); // same wire id — no join event
  });
});
