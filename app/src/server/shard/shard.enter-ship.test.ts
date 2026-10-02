import { describe, expect, it } from 'vitest';

import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import { ENTER_SHIP_MAX_SPEED, ENTER_SHIP_RANGE_M } from '@shared/interaction';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-35 step 1: the server re-entry handler through the REAL SimLoop
 * (shard.interact.test.ts conventions: stub repo/bus/log, one tick per
 * sim.step, pad position ONLY from padsForSystem).
 *
 * Contracts under test (the AC):
 * - happy path: the character entity is REMOVED, the ship is unfrozen
 *   (disembarked cleared, no ghost held frame), position + dock state kept,
 *   an 'entered-ship' event fires;
 * - idempotency: a double enter_ship is {code:'already-in-ship'} — no
 *   duplicate state (the stale-character / reconnect race);
 * - ownership: only the owner boards their ship → {code:'not-owner'}
 *   (checked BEFORE the idempotency code, so a foreign requester never
 *   gets 'already-in-ship');
 * - range: > 5 m (ENTER_SHIP_RANGE_M) → {code:'out-of-range'}, exactly
 *   5 m (inclusive) is accepted;
 * - speed: velocity ≥ 1 u/s (ENTER_SHIP_MAX_SPEED) → {code:'ship-moving'},
 *   just under is accepted — an IDLE ship off its pad can be re-claimed,
 *   a moving one cannot.
 */

const SEED = 'ENTER-SHIP-SEED';
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
  systemId: 'sys-enter-ship',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];

function makeShard(): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: SEED,
    system: SYSTEM,
    repo: {
      getShipByOwner: async () => undefined,
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

function makeShipEntity(pos: Vec3, over: Partial<SimEntity> = {}): SimEntity {
  return {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'pilot',
    classId: 'scout',
    ship: { pos, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'surface' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId: PLANET.id,
    ...over,
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

/**
 * Dock p1's ship on the pad and disembark — the standing starting state for
 * every re-entry case (character 2.5 m beside the docked ship).
 */
function onFootAtPad(shard: SystemShard, send: (buffer: string) => void = () => {}): void {
  const entity = makeShipEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
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
}

interface WireMsg {
  type: string;
  payload: { code?: string; message?: string };
}

const errorCodes = (sent: string[]): string[] =>
  sent
    .map((b) => JSON.parse(b) as WireMsg)
    .filter((m) => m.type === 'error')
    .map((m) => m.payload.code ?? '');

describe('TASK-35: server enter_ship', () => {
  it('happy path: character removed, ship unfrozen in place, entered-ship event, dock state kept', () => {
    const shard = makeShard();
    onFootAtPad(shard);
    const ship = shard.entities.get('ship-p1')!;
    const charId = 'char:p1';
    expect(shard.entities.has(charId)).toBe(true);
    expect(ship.disembarked).toBe(true);
    const before = { pos: { ...ship.ship.pos }, padId: ship.padId };

    const entered: unknown[] = [];
    shard.events.on('entered-ship', (e) => entered.push(e));

    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('ok');

    // The character is gone from the sim (it leaves every peer's next
    // 10 Hz snapshot — the entity_update broadcast is the shard's job).
    expect(shard.entities.has(charId)).toBe(false);
    expect(shard.snapshot().some((s) => s.id === charId)).toBe(false);
    // The ship is unfrozen, in the SAME place, still docked on its pad.
    expect(ship.disembarked).toBe(false);
    expect(ship.heldInput).toBeUndefined();
    expect(ship.ship.pos).toEqual(before.pos);
    expect(ship.padId).toBe(before.padId);
    // One event, with the removed character id (observability / tests).
    expect(entered).toEqual([{ playerId: 'p1', shipId: 'ship-p1', removedCharacterId: charId }]);
    // The unfrozen ship resumes the tick: it stays put on the pad (no input
    // → coast + pad hysteresis keeps the dock), no drift over 40 ticks.
    const step = makeStepper(shard);
    for (let i = 0; i < 40; i++) step();
    expect(ship.padId).toBe(before.padId);
    expect(ship.ship.pos.x).toBeCloseTo(before.pos.x, 6);
    expect(ship.ship.pos.z).toBeCloseTo(before.pos.z, 6);
    // The snapshot is back to the disembark baseline: ship present, no
    // orphan character.
    const snap = shard.snapshot();
    expect(snap.some((s) => s.id === 'ship-p1')).toBe(true);
    expect(snap.filter((s) => s.kind === 'character')).toHaveLength(0);
  });

  it('idempotent: a double enter_ship is {code: already-in-ship}, no duplicate state', () => {
    const shard = makeShard();
    const sent: string[] = [];
    onFootAtPad(shard, (b) => sent.push(b));
    const ship = shard.entities.get('ship-p1')!;
    const shipPosBefore = { ...ship.ship.pos };

    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('ok');
    // The second (stale) request — e.g. racing a reconnect — is denied with
    // the structured code and changes nothing.
    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('already-in-ship');
    expect(errorCodes(sent)).toEqual(['already-in-ship']);
    expect(ship.disembarked).toBe(false);
    expect(shard.entities.has('char:p1')).toBe(false);
    expect(ship.ship.pos).toEqual(shipPosBefore);
    // And a player who NEVER disembarked gets the same code (no character,
    // already in the ship).
    const shard2 = makeShard();
    const sent2: string[] = [];
    const entity = makeShipEntity({ x: PAD.pos.x, y: PAD.pos.y, z: PAD.pos.z });
    shard2.addEntity(entity);
    shard2.registerConnection('p1', 'pilot', (b) => sent2.push(b));
    expect(shard2.handleEnterShip('p1', 'ship-p1')).toBe('already-in-ship');
    expect(errorCodes(sent2)).toEqual(['already-in-ship']);
  });

  it("not-owner: player B cannot board A's ship, whether on foot or in their own ship", () => {
    const shard = makeShard();
    const sent: string[] = [];
    onFootAtPad(shard, (b) => sent.push(b));
    // B in their own ship (never disembarked): ownership is checked FIRST —
    // B gets not-owner, not already-in-ship.
    const bShip = makeShipEntity(
      { x: PAD.pos.x + 40, y: PAD.pos.y, z: PAD.pos.z },
      {
        id: 'ship-p2',
        playerId: 'p2',
        callsign: 'other',
      },
    );
    shard.addEntity(bShip);
    shard.registerConnection('p2', 'other', (b) => sent.push(b));
    expect(shard.handleEnterShip('p2', 'ship-p1')).toBe('not-owner');

    // B on foot (own character exists): still not-owner.
    const bChar = shard.entities.get('char:p1')!;
    shard.entities.set('char:p2', {
      ...bChar,
      id: 'char:p2',
      playerId: 'p2',
      callsign: 'other',
      ship: { ...bChar.ship, pos: { ...bChar.ship.pos } },
    });
    expect(shard.handleEnterShip('p2', 'ship-p1')).toBe('not-owner');
    expect(errorCodes(sent).filter((c) => c === 'not-owner')).toHaveLength(2);
    // A's state is untouched by B's attempts.
    expect(shard.entities.get('char:p1')?.disembarked).toBeUndefined();
    expect(shard.entities.has('char:p1')).toBe(true);
    expect(shard.entities.get('ship-p1')?.disembarked).toBe(true);
  });

  it('out-of-range: > 5 m from the ship is {code: out-of-range}; exactly 5 m passes', () => {
    const shard = makeShard();
    const sent: string[] = [];
    onFootAtPad(shard, (b) => sent.push(b));
    const char = shard.entities.get('char:p1')!;

    // 6 m away: denied, nothing changes.
    char.ship.pos = { x: PAD.pos.x + ENTER_SHIP_RANGE_M + 1, y: PAD.pos.y, z: PAD.pos.z };
    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('out-of-range');
    expect(errorCodes(sent)).toEqual(['out-of-range']);
    expect(shard.entities.has('char:p1')).toBe(true);
    expect(shard.entities.get('ship-p1')?.disembarked).toBe(true);

    // Exactly 5 m (inclusive, the AC boundary) is accepted.
    char.ship.pos = { x: PAD.pos.x + ENTER_SHIP_RANGE_M, y: PAD.pos.y, z: PAD.pos.z };
    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('ok');
    expect(shard.entities.has('char:p1')).toBe(false);
  });

  it('speed cap: ≥ 1 u/s is {code: ship-moving}; just under (and 0) is accepted', () => {
    const shard = makeShard();
    const sent: string[] = [];
    onFootAtPad(shard, (b) => sent.push(b));
    const ship = shard.entities.get('ship-p1')!;

    // Thrusting at 1.5 u/s: too fast to board; the character survives.
    ship.ship.vel = { x: 1.5, y: 0, z: 0 };
    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('ship-moving');
    expect(errorCodes(sent)).toEqual(['ship-moving']);
    expect(shard.entities.has('char:p1')).toBe(true);
    expect(ship.disembarked).toBe(true);

    // The boundary: EXACTLY 1 u/s is rejected (the AC allows < 1)…
    ship.ship.vel = { x: ENTER_SHIP_MAX_SPEED, y: 0, z: 0 };
    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('ship-moving');
    // …and just under it is fine (a drifting, settling ship).
    ship.ship.vel = { x: 0.99, y: 0, z: 0 };
    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('ok');
    expect(shard.entities.has('char:p1')).toBe(false);
    expect(ship.disembarked).toBe(false);
  });

  it('an idle ship OFF its pad can be re-claimed (velocity 0, no padId)', () => {
    const shard = makeShard();
    onFootAtPad(shard);
    const ship = shard.entities.get('ship-p1')!;
    const char = shard.entities.get('char:p1')!;
    // Simulate a drift: the ship left its pad (no dock state) but is at rest.
    ship.padId = undefined;
    ship.ship.pos = { x: PAD.pos.x + 12, y: PAD.pos.y, z: PAD.pos.z };
    char.ship.pos = { x: PAD.pos.x + 13, y: PAD.pos.y, z: PAD.pos.z }; // 1 m from the hull
    expect(shard.handleEnterShip('p1', 'ship-p1')).toBe('ok');
    expect(shard.entities.has('char:p1')).toBe(false);
    expect(ship.disembarked).toBe(false);
  });

  it('unknown ship id → {code: not-found}, nothing changes', () => {
    const shard = makeShard();
    const sent: string[] = [];
    onFootAtPad(shard, (b) => sent.push(b));
    expect(shard.handleEnterShip('p1', 'no-such-ship')).toBe('unknown-ship');
    expect(errorCodes(sent)).toEqual(['not-found']);
    expect(shard.entities.has('char:p1')).toBe(true);
  });
});
