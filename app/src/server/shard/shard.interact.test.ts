import { describe, expect, it } from 'vitest';

import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { SystemShard, entityToState } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-33 step 2: the server interact handler through the REAL SimLoop
 * (shard.character.test.ts conventions: stub repo/bus/log, one tick per
 * sim.step, pad position ONLY from padsForSystem).
 *
 * Contracts under test — validation order + the per-kind effects:
 * - wrong regime (no char:<playerId>) → {code:'wrong-regime'}, requester only;
 * - unknown id / non-interactable kind → {code:'not-found'};
 * - > 3 m from the CHARACTER (server-side position) → {code:'out-of-range'},
 *   exactly 3 m (inclusive) is accepted;
 * - deposit → the v1 pickup: quantity −1, despawn at zero, a 'pickup' event,
 *   the wire state carries the quantity until it leaves the next snapshot;
 * - terminal → a 'ui-open' {ui:'dock', payload:{terminalId}} frame to the
 *   requesting connection ONLY;
 * - ship → TASK-35: the branch delegates to handleEnterShip — a valid
 *   in-reach request re-enters the ship (character removed, ship unfrozen).
 */

const SEED = 'INTERACT-SIM-SEED';
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
  systemId: 'sys-interact-sim',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
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

function makeStatic(
  kind: 'deposit' | 'terminal',
  id: string,
  pos: Vec3,
  quantity?: number,
): SimEntity {
  return {
    id,
    kind,
    playerId: null,
    classId: kind,
    ship: { pos, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'surface' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    ...(quantity !== undefined ? { quantity } : {}),
  };
}

/** Dock p1's ship on the pad and disembark (a standing character to interact from). */
function onFootAtPad(
  shard: SystemShard,
  send: (buffer: string) => void = () => {},
): { charPos: Vec3; step: () => void } {
  const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
  shard.addEntity(entity);
  shard.registerConnection('p1', 'pilot', send);
  const frames = makeFrames();
  const step = makeStepper(shard);
  for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) {
    shard.enqueueInput('p1', frames());
    step();
  }
  if (entity.padId !== PAD.padId) throw new Error('ship never docked');
  expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');
  return { charPos: { ...shard.entities.get('char:p1')!.ship.pos }, step };
}

interface WireMsg {
  type: string;
  payload: { code?: string; message?: string; ui?: string; payload?: unknown };
}

const messages = (sent: string[]): WireMsg[] => sent.map((b) => JSON.parse(b) as WireMsg);

describe('TASK-33: server interact validation + effects', () => {
  it('wrong regime (still in the ship) → {code: wrong-regime} to the requester only', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y, z: PAD.pos.z });
    shard.addEntity(entity);
    const sent: string[] = [];
    shard.registerConnection('p1', 'pilot', (b) => sent.push(b));
    const step = makeStepper(shard);
    step();

    // No char:p1 yet — the player is in the docked ship.
    expect(shard.handleInteract('p1', 'dep-x')).toBe('wrong-regime');
    expect(
      messages(sent)
        .filter((m) => m.type === 'error')
        .map((m) => m.payload.code),
    ).toEqual(['wrong-regime']);
    expect(shard.entities.has('char:p1')).toBe(false);
  });

  it('not-found: unknown id AND non-interactable kind (a character entity)', () => {
    const shard = makeShard();
    const sent: string[] = [];
    const { charPos } = onFootAtPad(shard, (b) => sent.push(b));

    // An unknown id…
    expect(shard.handleInteract('p1', 'no-such-entity')).toBe('not-found');
    // …and a real entity that is NOT an interactable kind (the character).
    const near: Vec3 = { x: charPos.x + 1, y: charPos.y, z: charPos.z };
    shard.addEntity(makeStatic('terminal', 'term-1', near));
    expect(shard.handleInteract('p1', 'char:p1')).toBe('not-found');
    expect(
      messages(sent)
        .filter((m) => m.type === 'error')
        .map((m) => m.payload.code),
    ).toEqual(['not-found', 'not-found']);
  });

  it('out-of-range: 4 m from the character → {code: out-of-range}; exactly 3 m passes', () => {
    const shard = makeShard();
    const sent: string[] = [];
    const { charPos } = onFootAtPad(shard, (b) => sent.push(b));

    // 4 m to the side: the deposit exists, the player is on foot — still denied.
    const far = shard.addDepositForTesting({ x: charPos.x + 4, y: charPos.y, z: charPos.z }, 3);
    expect(shard.handleInteract('p1', far, 'pickup')).toBe('out-of-range');
    expect(
      messages(sent)
        .filter((m) => m.type === 'error')
        .map((m) => m.payload.code),
    ).toEqual(['out-of-range']);
    // The denial did not consume the deposit.
    expect(shard.entities.get(far)?.quantity).toBe(3);

    // Exactly 3 m (inclusive, the AC boundary) is accepted.
    const edge = shard.addDepositForTesting({ x: charPos.x + 3, y: charPos.y, z: charPos.z }, 1);
    expect(shard.handleInteract('p1', edge)).toBe('ok');
    expect(shard.entities.has(edge)).toBe(false); // 1 → 0 → despawned
  });

  it('deposit pickup: quantity decrements, despawns at zero, emits pickup, wire carries quantity', () => {
    const shard = makeShard();
    const { charPos } = onFootAtPad(shard);
    const pickups: { playerId: string; targetId: string; remaining: number; depleted: boolean }[] =
      [];
    shard.events.on('pickup', (e) => pickups.push(e));

    const dep = shard.addDepositForTesting({ x: charPos.x + 1, y: charPos.y, z: charPos.z }, 2);

    // First tap: 2 → 1, still in the sim, visible in the snapshot.
    expect(shard.handleInteract('p1', dep, 'pickup')).toBe('ok');
    expect(shard.entities.get(dep)?.quantity).toBe(1);
    const snap = shard.snapshot();
    expect(snap.find((s) => s.id === dep)?.quantity).toBe(1);
    expect(entityToState(shard.entities.get(dep)!).quantity).toBe(1);

    // Second tap: 1 → 0, despawned for everyone, gone from the snapshot.
    expect(shard.handleInteract('p1', dep, 'pickup')).toBe('ok');
    expect(shard.entities.has(dep)).toBe(false);
    expect(shard.snapshot().some((s) => s.id === dep)).toBe(false);

    expect(pickups).toEqual([
      { playerId: 'p1', targetId: dep, remaining: 1, depleted: false },
      { playerId: 'p1', targetId: dep, remaining: 0, depleted: true },
    ]);
  });

  it('terminal: a ui-open {ui: dock, payload: {terminalId}} frame to the requester ONLY', () => {
    const shard = makeShard();
    const { charPos } = onFootAtPad(shard);
    const toP1: string[] = [];
    const toP2: string[] = [];
    shard.registerConnection('p1', 'pilot', (b) => toP1.push(b));
    shard.addEntity({
      ...makeEntity({ x: PAD.pos.x + 30, y: PAD.pos.y, z: PAD.pos.z }),
      id: 'ship-p2',
      playerId: 'p2',
      callsign: 'other',
    });
    shard.registerConnection('p2', 'other', (b) => toP2.push(b));

    const term = 'term-1';
    shard.addEntity(makeStatic('terminal', term, { x: charPos.x, y: charPos.y, z: charPos.z + 1 }));

    expect(shard.handleInteract('p1', term)).toBe('ok');

    const ui = messages(toP1).filter((m) => m.type === 'ui-open');
    expect(ui).toHaveLength(1);
    expect(ui[0].payload.ui).toBe('dock');
    expect(ui[0].payload.payload).toEqual({ terminalId: term });
    expect(messages(toP2).filter((m) => m.type === 'ui-open')).toHaveLength(0); // nobody else
    // The terminal itself is untouched (opening the UI is not consuming it).
    expect(shard.entities.has(term)).toBe(true);
  });

  it('ship kind (TASK-35): a valid in-reach request re-enters the ship via the delegate', () => {
    const shard = makeShard();
    const { charPos } = onFootAtPad(shard);
    // The player's own docked ship is a ship-kind target, ~2.5 m away
    // (inside the 5 m enter radius).
    const ship = shard.entities.get('ship-p1')!;
    const dist = Math.hypot(ship.ship.pos.x - charPos.x, ship.ship.pos.z - charPos.z);
    expect(dist).toBeLessThanOrEqual(5);
    expect(ship.disembarked).toBe(true);
    expect(shard.entities.has('char:p1')).toBe(true);

    const before = { pos: { ...ship.ship.pos }, padId: ship.padId };
    expect(shard.handleInteract('p1', 'ship-p1')).toBe('ok');
    // The delegated enter-ship effect applied: the character is GONE and
    // the ship is unfrozen where it docked (no drift, dock state kept).
    expect(shard.entities.has('char:p1')).toBe(false);
    expect(ship.disembarked).toBe(false);
    expect(ship.ship.pos).toEqual(before.pos);
    expect(ship.padId).toBe(before.padId);
    // A second interact is denied by the regime check first (no char:p1
    // left → not on foot). The idempotent 'already-in-ship' denial lives in
    // handleEnterShip itself (covered in shard.enter-ship.test.ts and
    // enter-ship.ws.test.ts).
    expect(shard.handleInteract('p1', 'ship-p1')).toBe('wrong-regime');
  });
});
