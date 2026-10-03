import { describe, expect, it } from 'vitest';

import { characterSpawnPos, CHAR_SHIP_SIDE_OFFSET_M } from '@shared/physics/character';
import { quatIdentity, vecLength, type Vec3 } from '@shared/physics/vec';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { SystemShard, entityToState } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-31 step 1: server disembark through the REAL SimLoop (shard.pads.test
 * conventions: stub repo/bus/log, addEntity + registerConnection, one tick
 * per sim.step, pad position ONLY from padsForSystem).
 *
 * Contracts under test:
 * - a PAD-docked ship + exit → a static character entity (id char:<playerId>)
 *   at ship.pos + 2.5 m side offset ON THE PAD PLANE, ship stays docked;
 * - the wire state carries kind 'character' {playerId, onFoot, flightRegime
 *   'surface'} and the ship keeps its 'docked' {padId} state;
 * - a disembarked ship is FROZEN: inputs dropped, even a smuggled held frame
 *   cannot move it or undock it;
 * - denial: not-docked → {code:'not-docked'} to the requesting connection;
 *   foreign ship id → {code:'unknown-ship'}; double exit → no-op;
 * - disconnect while disembarked leaves the character in the sim (the
 *   TASK-24 pattern) and a re-adopt restores the on-foot state.
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
/** The system's single seeded pad — the authoritative position (never hardcoded). */
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];

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

describe('TASK-31 step 1: server disembark', () => {
  it('docked ship: character spawns 2.5 m to the ship side on the pad plane, ship stays docked', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    approachAndDock(shard, entity, frames, step);

    // The expected spawn from the SHARED math (same fn the server uses).
    const expected = characterSpawnPos(entity.ship.pos, entity.ship.quat, PAD.pos.y);

    expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');

    const char = shard.entities.get('char:p1');
    expect(char).toBeDefined();
    expect(char?.kind).toBe('character');
    expect(char?.playerId).toBe('p1');
    expect(char?.callsign).toBe('pilot');
    // Exactly the shared-math position: 2.5 m to the ship's side, on the pad plane.
    expect(char!.ship.pos).toEqual(expected);
    expect(
      Math.hypot(char!.ship.pos.x - entity.ship.pos.x, char!.ship.pos.z - entity.ship.pos.z),
    ).toBeCloseTo(CHAR_SHIP_SIDE_OFFSET_M, 6);
    expect(char!.ship.pos.y).toBe(PAD.pos.y);
    expect(char!.ship.regime).toBe('surface');
    expect(vecLength(char!.ship.vel)).toBe(0);

    // Wire state: the character carries playerId + onFoot; regime 'sublight'
    // (not 'docked' — the DOCKED indicator tracks the ship, not the person).
    const charState = entityToState(char!);
    expect(charState.kind).toBe('character');
    expect(charState.playerId).toBe('p1');
    expect(charState.onFoot).toBe(true);
    expect(charState.regime).toBe('sublight');
    expect(charState.flightRegime).toBe('surface');
    expect(charState.callsign).toBe('pilot');

    // The ship is marked frozen and STILL docked in the wire state.
    expect(entity.disembarked).toBe(true);
    const shipState = entityToState(entity);
    expect(shipState.regime).toBe('docked');
    expect(shipState.padId).toBe(PAD.padId);

    // The 10 Hz snapshot carries BOTH entities (what every peer receives)
    // (TASK-37: the snapshot can ALSO stream nearby seeded deposits,
    // TASK-40 station terminals, TASK-45 rogue ai-ships, TASK-48 hazard
    // drones — wire playerId rides on characters only, so filter by kind).
    const snap = shard
      .snapshot()
      .filter(
        (s) =>
          s.kind !== 'deposit' &&
          s.kind !== 'terminal' &&
          s.kind !== 'ai-ship' &&
          s.kind !== 'drone',
      );
    expect(snap.map((s) => s.kind).sort()).toEqual(['character', 'ship']);

    // Resting ticks (no input after the exit): the ship stays EXACTLY put
    // and docked, and the character stays put too (zero input → no walk).
    const shipPosBefore = { ...entity.ship.pos };
    for (let i = 0; i < 10; i++) step();
    expect(entity.ship.pos).toEqual(shipPosBefore);
    expect(entity.padId).toBe(PAD.padId);
    expect(entityToState(entity).regime).toBe('docked');
    expect(char!.ship.pos).toEqual(expected);
  });

  it('a disembarked ship is not locally controllable: frames route to the character, smuggled held frame ignored', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    approachAndDock(shard, entity, frames, step);
    expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');

    // TASK-32: the SAME 'input' frame is now ACCEPTED — it drives the
    // character (thrust 1 = walk forward), not the frozen ship.
    const spawnPos = { ...shard.entities.get('char:p1')!.ship.pos };
    expect(shard.enqueueInput('p1', frames({ thrust: 1 }))).toBe(true);
    for (let i = 0; i < 20; i++) {
      shard.enqueueInput('p1', frames({ thrust: 1 }));
      step();
    }
    // The ship is EXACTLY where it docked (frozen, still docked)…
    expect(entity.ship.pos).toEqual({ x: PAD.pos.x, y: PAD.pos.y, z: PAD.pos.z });
    expect(entity.padId).toBe(PAD.padId);
    expect(entityToState(entity).regime).toBe('docked');
    // …while the character walked forward (3 u/s × ~1 s of applied frames).
    const charPos = shard.entities.get('char:p1')!.ship.pos;
    expect(Math.hypot(charPos.x - spawnPos.x, charPos.z - spawnPos.z)).toBeGreaterThan(2);
    expect(charPos.z).toBeGreaterThan(spawnPos.z);
    expect(shard.entities.get('char:p1')!.charOnGround).toBe(true);

    // Adversarial path: a held frame smuggled onto the FROZEN SHIP cannot
    // move it or clear its dock (the tick skips it entirely).
    entity.heldInput = frames({ thrust: 1, yaw: 1, pitch: 1 });
    const before = { pos: { ...entity.ship.pos }, quat: { ...entity.ship.quat } };
    for (let i = 0; i < 5; i++) step();
    expect(entity.ship.pos).toEqual(before.pos);
    expect(entity.ship.quat).toEqual(before.quat);
    expect(entity.padId).toBe(PAD.padId);
    expect(entityToState(entity).regime).toBe('docked');
  });

  it('denial: not docked → {code: not-docked}; foreign ship → {code: unknown-ship}', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: 0, y: 500, z: 0 }); // in space, never docked
    shard.addEntity(entity);
    const sentToP1: string[] = [];
    const sentToP2: string[] = [];
    shard.registerConnection('p1', 'pilot', (b) => sentToP1.push(b));
    shard.addEntity({
      ...makeEntity({ x: 10, y: 500, z: 0 }),
      id: 'ship-p2',
      playerId: 'p2',
      callsign: 'other',
    });
    shard.registerConnection('p2', 'other', (b) => sentToP2.push(b));
    const step = makeStepper(shard);
    step(); // settle the entities once

    const errors = (sent: string[]): { code: string }[] =>
      sent
        .map((b) => JSON.parse(b) as { type: string; payload: { code: string } })
        .filter((m) => m.type === 'error')
        .map((m) => m.payload);

    // p1's ship is flying: not-docked denial lands on p1's connection ONLY.
    expect(shard.handleExitShip('p1', 'ship-p1')).toBe('not-docked');
    expect(errors(sentToP1).map((e) => e.code)).toEqual(['not-docked']);
    expect(errors(sentToP2)).toHaveLength(0); // p2 sees nothing
    expect(shard.entities.has('char:p1')).toBe(false);

    // p2 tries to exit p1's ship: unknown-ship (not owned by p2).
    expect(shard.handleExitShip('p2', 'ship-p1')).toBe('unknown-ship');
    expect(errors(sentToP2).map((e) => e.code)).toEqual(['unknown-ship']);
    expect(errors(sentToP1).map((e) => e.code)).toEqual(['not-docked']); // p1 unchanged

    // p2 CAN exit their OWN docked ship (control: happy path stays reachable).
    const e2 = shard.entities.get('ship-p2')!;
    shard.teleportForTesting('p2', { x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    const frames = makeFrames();
    for (let i = 0; i < 4000 && e2.padId !== PAD.padId; i++) {
      shard.enqueueInput('p2', frames());
      step();
    }
    expect(e2.padId).toBe(PAD.padId);
    expect(shard.handleExitShip('p2', 'ship-p2')).toBe('ok');
    expect(shard.entities.get('char:p2')?.kind).toBe('character');
  });

  it('double disembark is a no-op: no second character, no duplicate id', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    approachAndDock(shard, entity, frames, step);
    expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');
    expect(shard.handleExitShip('p1', 'ship-p1')).toBe('already-on-foot');
    const chars = [...shard.entities.keys()].filter((id) => id.startsWith('char:'));
    expect(chars).toEqual(['char:p1']);
    const before = { ...shard.entities.get('char:p1')!.ship.pos };
    step();
    expect(shard.entities.get('char:p1')!.ship.pos).toEqual(before);
  });

  it('disconnect while disembarked leaves the character in the sim; re-adopt restores on-foot', async () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    const connId = shard.registerConnection('p1', 'pilot', () => {});
    const frames = makeFrames();
    const step = makeStepper(shard);
    approachAndDock(shard, entity, frames, step);
    expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');

    // The owner drops: the CHARACTER persists in the sim (TASK-24 pattern)
    // and still rides the snapshot for the remaining peers.
    shard.unregisterConnection(connId);
    expect(shard.entities.get('char:p1')).toBeDefined();
    expect(shard.snapshot().some((s) => s.kind === 'character')).toBe(true);
    step();
    expect(shard.entities.get('char:p1')).toBeDefined();

    // The owner re-joins: re-adopt finds the surviving character and comes
    // back ON FOOT (the ship stays frozen where it docked).
    entity.disembarked = false; // simulate a fresh adopt before the check
    const adopted = await shard.adoptEntity('p1', 'pilot');
    expect(adopted?.disembarked).toBe(true);
    expect(entity.padId).toBe(PAD.padId);
  });
});
