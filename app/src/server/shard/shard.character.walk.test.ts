import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padsForSystem, padSurfaceHeight, type PadInfo } from '@shared/world/pads';
import type { InputPayload } from '@shared/protocol/schemas';
import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import { SystemShard } from './shard';
import { TerrainContext } from './terrain';
import type { SimEntity } from './types';

/**
 * TASK-32 step 4: the integration AC — a scripted 30 s of on-foot movement
 * (walk → run → turn → jump-walk → idle → back+turn) through the REAL
 * SimLoop, seeded-terrain heightAt included (the path leaves the 20 m flat
 * pad disc after ~25 m and walks real chunk terrain, so the fixture pins
 * terrain following end to end). The sampled path must match the committed
 * fixture bit-for-bit (determinism across the whole sim stack: input
 * routing + integrateCharacter + chunked terrain).
 *
 * Fixture generation: `CHAR_WALK_FIXTURE=1 npx vitest run <this file>`
 * rewrites the committed JSON and skips the comparison (the shard setup
 * lives in this test, so a standalone tsx script cannot generate it —
 * tsx does not resolve the @shared/ aliases the shard imports).
 */

const SEED = 'CHAR-SIM-SEED';
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
  systemId: 'sys-char-sim',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
/** The system's single seeded pad — the authoritative position. */
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];
const FIXTURE_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  '__fixtures__',
  'character-walk-30s.json',
);

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

function makeShard(): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: SEED,
    system: SYSTEM,
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
  });
}

const SHIP_ROW: ShipRowStub = {
  id: 'ship-p1',
  ownerId: 'p1',
  classId: 'scout',
  position: { x: PAD.pos.x, y: PAD.pos.y, z: PAD.pos.z, systemId: SYSTEM.systemId },
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

function makeEntity(pos: Vec3): SimEntity {
  return {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'pilot',
    classId: 'scout',
    ship: { pos, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'atmosphere' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId: PLANET.id,
  };
}

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

function makeStepper(shard: SystemShard): () => void {
  let t = 25;
  return () => {
    t += 50;
    shard.sim.step(t);
  };
}

/** VTOL-off drop onto the pad (the v1 model cannot descend under VTOL). */
function approachAndDock(
  shard: SystemShard,
  entity: SimEntity,
  frames: () => InputPayload,
  step: () => void,
): void {
  expect(shard.teleportForTesting('p1', { x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z })).toBe(
    true,
  );
  for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) {
    shard.enqueueInput('p1', frames());
    step();
  }
  if (entity.padId !== PAD.padId) {
    throw new Error(`ship never docked (regime ${entity.ship.regime})`);
  }
}

/**
 * The scripted 30 s (20 ticks/s ⇒ 600 ticks): walk 8 s, run 5 s, turn 2 s,
 * jump-walk 3 s (held jump auto-hops on each landing — v1), idle 4 s, then
 * back + turn 8 s. Total path ≈ 87 m — well past the 20 m pad disc radius,
 * so most of the walk is over real seeded chunk terrain.
 */
function frameForTick(
  tick: number,
  frames: (p?: Partial<InputPayload>) => InputPayload,
): InputPayload {
  if (tick < 160) return frames({ thrust: 1 }); // 0–8 s walk
  if (tick < 260) return frames({ thrust: 1, action: 'run' }); // 8–13 s run
  if (tick < 300) return frames({ yaw: 1 }); // 13–15 s turn right
  if (tick < 360) return frames({ thrust: 1, action: 'jump' }); // 15–18 s jump-walk
  if (tick < 440) return frames(); // 18–22 s idle (friction stop)
  return frames({ thrust: -1, yaw: -1 }); // 22–30 s back + turn
}

/** One sampled pose (the fixture unit): seconds + rounded world position. */
type Sample = [number, number, number, number];

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

describe('TASK-32 step 4: 30 s scripted on-foot walk through the sim', () => {
  it('walk/run/turn/jump over seeded terrain matches the committed fixture; never below the surface', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    approachAndDock(shard, entity, frames, step);
    expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');
    const char = shard.entities.get('char:p1')!;
    const spawn = { ...char.ship.pos };

    // A mirror heightAt (same seed + planet + pad as the shard's): the
    // surface the character may never sink below. The pad's raised disc
    // (raised-cosine blend to the raw terrain at 30 m) is included, exactly
    // as the sim composes it.
    const terrain = new TerrainContext(SEED, PLANET);
    const surfaceAt = (x: number, z: number) => padSurfaceHeight(x, z, terrain.heightAt(x, z), PAD);

    const samples: Sample[] = [];
    let belowTerrain = false;
    for (let i = 0; i < 600; i++) {
      shard.enqueueInput('p1', frameForTick(i, frames));
      step();
      terrain.update(char.ship.pos.x, char.ship.pos.z);
      if (char.ship.pos.y < surfaceAt(char.ship.pos.x, char.ship.pos.z) - 1e-6) {
        belowTerrain = true;
      }
      if ((i + 1) % 20 === 0) {
        samples.push([
          (i + 1) / 20,
          round6(char.ship.pos.x),
          round6(char.ship.pos.y),
          round6(char.ship.pos.z),
        ]);
      }
    }

    // The character never tunneled into the seeded terrain in any of the
    // 600 ticks (the substep + terrain-clamp invariant, end to end).
    expect(belowTerrain).toBe(false);

    // Fixture mode: rewrite the committed JSON and skip the comparison.
    if (process.env.CHAR_WALK_FIXTURE === '1') {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, JSON.stringify({ seed: SEED, samples }, null, 2) + '\n');
      return;
    }

    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
      seed: string;
      samples: Sample[];
    };
    expect(fixture.seed).toBe(SEED);
    expect(samples).toEqual(fixture.samples); // path is bit-identical

    // Sanity: the script actually exercised the regimes — the character
    // left the pad disc (>25 m from spawn) and ended far from where it stood.
    const maxRange = Math.max(...samples.map(([, x, , z]) => Math.hypot(x - spawn.x, z - spawn.z)));
    expect(maxRange).toBeGreaterThan(25);
    const [, ex, ey, ez] = samples[samples.length - 1];
    expect(Math.hypot(ex - spawn.x, ez - spawn.z)).toBeGreaterThan(5);
    // The final idle+back phase ends on the ground, feet on the surface
    // (the path climbs real terrain — altitude relative to the PAD is
    // unconstrained; what must hold is the ground contact).
    expect(char.charOnGround).toBe(true);
    terrain.update(ex, ez);
    expect(Math.abs(ey - surfaceAt(ex, ez))).toBeLessThan(0.5);
  });
});
