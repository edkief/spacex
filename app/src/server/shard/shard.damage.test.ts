import { afterEach, describe, expect, it, vi } from 'vitest';

import { homeDockPosition } from '@shared/galaxy/dock';
import { generateSystem } from '@shared/galaxy/system';
import { generateStars } from '@shared/galaxy/stars';
import type { SystemGen } from '@shared/galaxy/types';
import type { DamageSource } from '@shared/physics/damage';
import type { Vec3 } from '@shared/physics/vec';
import type { EntityState, InputPayload } from '@shared/protocol/schemas';
import { padsForSystem } from '@shared/world/pads';
import { createShipSwapBus, type ShipRowLike } from '@server/shards';

import { SystemShard, TICK_DT_MS, WRECK_TTL_MS } from './shard';
import type { SimEntity } from './types';

/**
 * Ship damage model in the sim (TASK-23 step 2): the applyHit hook (shared
 * shield-first math), the static wreck entity with its 600 s ttl, and the
 * combat_event broadcast to the whole shard. TASK-49: a destroyed PLAYER
 * ship now respawns immediately (in place, docked starter scout) — the wreck
 * is what lingers at the death spot; the full death-and-recovery loop is
 * covered in shard.destruction-respawn.test.ts.
 */

const SEED = 'shard-damage-seed';
const PLAYER: DamageSource = { kind: 'player', id: 'p2' };
const AI: DamageSource = { kind: 'ai', id: 'rogue-9' };
/** The firing weapon id riding every combat event (TASK-42). */
const WEAPON = 'laser';

function testSystem(): SystemGen {
  const star = generateStars(SEED, 4)[0];
  return generateSystem(SEED, star.id);
}

function makeShard(system: SystemGen = testSystem()): SystemShard {
  return new SystemShard({
    systemId: system.systemId,
    galaxySeed: SEED,
    system,
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

function addFakeConn(shard: SystemShard, playerId: string, callsign: string): { sends: string[] } {
  const sends: string[] = [];
  shard.registerConnection(playerId, callsign, (buffer) => {
    sends.push(buffer);
  });
  return { sends };
}

function makeEntity(
  playerId: string,
  pos: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): SimEntity {
  return {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId,
    classId: 'scout',
    ship: {
      pos: { ...pos },
      vel: { ...vel },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
  };
}

function input(seq: number, partial: Partial<InputPayload> = {}): InputPayload {
  return {
    seq,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    ...partial,
  };
}

/** Combat events out of a send log, decoded. */
function combatEvents(sends: string[]): unknown[] {
  return sends
    .filter((s) => JSON.parse(s).type === 'combat_event')
    .map((s) => (JSON.parse(s) as { payload: unknown }).payload);
}

/**
 * TASK-49: where a destroyed player ship respawns — the nearest pad of THIS
 * system by true 3D distance (or the seed-derived home dock when the system
 * has no landable pad). Mirrors SystemShard.respawnPlayer so the position
 * assertion stays honest whichever path the seeded system takes.
 */
function respawnPos(system: SystemGen, from: Vec3): Vec3 {
  let best: ReturnType<typeof padsForSystem>[number] | undefined;
  let bestD = Infinity;
  for (const pad of padsForSystem(SEED, system)) {
    const d = Math.hypot(from.x - pad.pos.x, from.y - pad.pos.y, from.z - pad.pos.z);
    if (d < bestD || (d === bestD && (!best || pad.padId < best.padId))) {
      best = pad;
      bestD = d;
    }
  }
  return best ? { ...best.pos } : { ...homeDockPosition(SEED, system.systemId) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemShard.applyHit (TASK-23 step 2)', () => {
  it('a partial hit reduces shields first, then hull, and broadcasts combat_event to the whole shard', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 1, y: 2, z: 3 }));
    const mine = addFakeConn(shard, 'p1', 'Alpha');
    const other = addFakeConn(shard, 'p2', 'Beta');

    // Scout: 100 hull / 50 shields. 70 points → 50 shields, 20 hull.
    const result = shard.applyHit('ship-p1', 70, PLAYER, WEAPON);
    expect(result).toEqual({ shieldHit: 50, hullHit: 20, destroyed: false });
    const e = shard.entities.get('ship-p1')!;
    expect(e.shields).toBeCloseTo(0, 12);
    expect(e.hull).toBeCloseTo(0.8, 12);

    const mineEvents = combatEvents(mine.sends);
    const otherEvents = combatEvents(other.sends);
    expect(mineEvents).toEqual([
      {
        kind: 'hit',
        target: 'ship-p1',
        source: PLAYER,
        weapon: WEAPON,
        damage: 70,
        shieldHit: 50,
        hullHit: 20,
      },
    ]);
    // Broadcast to the WHOLE shard: every in-system conn gets the event.
    expect(otherEvents).toEqual(mineEvents);
    shard.stop();
  });

  it('a killing hit destroys the ship: wreck at the death spot + immediate dock respawn (TASK-49)', () => {
    vi.useFakeTimers();
    const system = testSystem();
    const shard = makeShard(system);
    const start = { x: 10, y: 20, z: 30 };
    const entity = makeEntity('p1', start, { x: 1, y: 0, z: 2 });
    shard.addEntity(entity);
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    // 50 (shields) + 50 (half hull), then the final 50 → hull at zero.
    shard.applyHit('ship-p1', 100, AI, WEAPON);
    shard.applyHit('ship-p1', 50, AI, WEAPON);

    // TASK-49: a destroyed PLAYER ship respawns IMMEDIATELY, in place (same
    // wire id) — a fresh starter scout, docked, full hull/shields, at the
    // nearest dock. (Cargo loss / credits-kept: destruction-respawn test.)
    expect(entity.destroyed).toBeFalsy();
    expect(entity.docked).toBe(true);
    expect(entity.classId).toBe('scout');
    expect(entity.hull).toBe(1);
    expect(entity.shields).toBe(1);
    expect(entity.ship.pos).toEqual(respawnPos(system, start));
    // The wreck is a static entity at the death spot (vel zeroed).
    const wreck = shard.entities.get('wreck:ship-p1');
    expect(wreck).toBeDefined();
    expect(wreck!.kind).toBe('wreck');
    expect(wreck!.ship.pos).toEqual(start);
    expect(wreck!.ship.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(wreck!.ttl).toBe(Math.round(WRECK_TTL_MS / TICK_DT_MS));
    // TASK-42: the wreck records its killer (skull marker, TASK-49).
    expect(wreck!.killerId).toBe(AI.id);
    // The first hit broadcasts 'hit'; ONLY the killing hit broadcasts
    // 'destroyed' (no 'hit' for it). An AI source never emits 'kill'.
    expect(combatEvents(sends)).toEqual([
      {
        kind: 'hit',
        target: 'ship-p1',
        source: AI,
        weapon: WEAPON,
        damage: 100,
        shieldHit: 50,
        hullHit: 50,
      },
      { kind: 'destroyed', target: 'ship-p1', source: AI, weapon: WEAPON },
    ]);
    shard.stop();
  });

  it('a player killing hit additionally broadcasts kill (kill = destroyed with a player source)', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 1, y: 1, z: 1 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    shard.applyHit('ship-p1', 150, PLAYER, WEAPON); // killing hit by a player
    expect(combatEvents(sends)).toEqual([
      { kind: 'destroyed', target: 'ship-p1', source: PLAYER, weapon: WEAPON },
      { kind: 'kill', killer: PLAYER.id, victim: 'ship-p1', weapon: WEAPON },
    ]);
    expect(shard.entities.get('wreck:ship-p1')!.killerId).toBe(PLAYER.id);
    shard.stop();
  });

  it('the wreck and the respawned scout both ride the 10 Hz snapshot wire contract', () => {
    vi.useFakeTimers();
    const system = testSystem();
    const shard = makeShard(system);
    const death = { x: 5, y: 5, z: 5 };
    shard.addEntity(makeEntity('p1', death));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    shard.applyHit('ship-p1', 150, AI, WEAPON); // killing hit → dock respawn
    shard.start();
    vi.advanceTimersByTime(2 * TICK_DT_MS); // one snapshot

    const snapshot = sends.filter((s) => JSON.parse(s).type === 'entity_update').pop()!;
    const entities = (JSON.parse(snapshot) as { payload: { entities: EntityState[] } }).payload
      .entities;
    const byId = new Map(entities.map((e) => [e.id, e]));
    // The SAME ship id is now the fresh starter scout, docked at the nearest
    // dock (the client re-renders the wire-stable id — TASK-49).
    expect(byId.get('ship-p1')).toMatchObject({
      id: 'ship-p1',
      kind: 'ship',
      classId: 'scout',
      hull: 1,
      shields: 1,
      pos: respawnPos(system, death),
    });
    // The wreck lingers at the DEATH spot (not the dock), with its killer.
    expect(byId.get('wreck:ship-p1')).toMatchObject({
      id: 'wreck:ship-p1',
      kind: 'wreck',
      hull: 0,
      shields: 0,
      pos: death,
      vel: { x: 0, y: 0, z: 0 },
      classId: 'scout',
      killerId: AI.id,
    });
    shard.stop();
  });

  it('no double-destroy: the killing hit respawns a FRESH scout (a direct second hit damages it); the wreck refuses hits', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    shard.applyHit('ship-p1', 150, AI, WEAPON); // killing hit → dock respawn
    // TASK-49 design: the low-level applyHit has NO docked gate — the gate is
    // resolveHit, where every fire path funnels — so a direct second hit now
    // damages the FRESH starter scout (full shields absorb it) instead of
    // no-op'ing on a frozen dead ship.
    expect(shard.applyHit('ship-p1', 50, PLAYER, WEAPON)).toEqual({
      shieldHit: 50,
      hullHit: 0,
      destroyed: false,
    });
    expect(shard.applyHit('wreck:ship-p1', 50, PLAYER, WEAPON)).toBeUndefined(); // wrecks too
    expect(shard.applyHit('ship-nobody', 50, PLAYER, WEAPON)).toBeUndefined();

    const events = combatEvents(sends);
    // Exactly one 'destroyed' (never re-broadcast) + the new 'hit'.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'destroyed', target: 'ship-p1' });
    expect(events[1]).toMatchObject({ kind: 'hit', target: 'ship-p1', shieldHit: 50 });
    expect(shard.entities.has('wreck:ship-p1')).toBe(true);
    expect(entityCount(shard, 'wreck')).toBe(1);
    shard.stop();
  });

  function entityCount(shard: SystemShard, kind: SimEntity['kind']): number {
    return [...shard.entities.values()].filter((e) => e.kind === kind).length;
  }

  it('a killing hit respawns the ship at the dock: the scout is live again, the wreck stays frozen', () => {
    vi.useFakeTimers();
    const system = testSystem();
    const shard = makeShard(system);
    const death = { x: 100, y: 100, z: 100 };
    const entity = makeEntity('p1', death, { x: 1, y: 0, z: 2 });
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Alpha');
    shard.start();

    // One tick of full thrust: the ship moves along +Z.
    shard.enqueueInput('p1', input(1, { thrust: 1 }));
    vi.advanceTimersByTime(TICK_DT_MS);
    expect(entity.ship.pos.z).toBeGreaterThan(death.z);

    // Kill it in flight: the wreck spawns at the ship's FINAL position
    // (it drifted a little under thrust since the `death` start)…
    const final = { ...entity.ship.pos };
    shard.applyHit('ship-p1', 150, AI, WEAPON);
    // …and TASK-49 respawns the SAME entity in place — a fresh starter
    // scout, docked at the nearest dock, full hull/shields.
    expect(entity.destroyed).toBeFalsy();
    expect(entity.docked).toBe(true);
    expect(entity.classId).toBe('scout');
    expect(entity.hull).toBe(1);
    expect(entity.shields).toBe(1);
    expect(entity.ship.pos).toEqual(respawnPos(system, final));

    // Inputs are ACCEPTED again (no longer destroyed): the first frame is
    // the take-off…
    expect(shard.enqueueInput('p1', input(2, { thrust: 1 }))).toBe(true);
    vi.advanceTimersByTime(2 * TICK_DT_MS);
    expect(entity.docked).toBe(false);
    // …and the WRECK is what stays frozen at the death spot.
    const wreck = shard.entities.get('wreck:ship-p1')!;
    expect(wreck.ship.pos).toEqual(final);
    vi.advanceTimersByTime(20 * TICK_DT_MS);
    expect(wreck.ship.pos).toEqual(final);
    shard.stop();
  });

  it('the wreck expires after its 600 s ttl; the respawned scout waits at the dock', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    addFakeConn(shard, 'p1', 'Alpha');
    shard.start();

    shard.applyHit('ship-p1', 150, AI, WEAPON);
    expect(shard.entities.has('wreck:ship-p1')).toBe(true);
    // TASK-49: the respawn already happened — what lingers is the wreck.
    expect(shard.entities.get('ship-p1')!.destroyed).toBeFalsy();

    const ttlTicks = Math.round(WRECK_TTL_MS / TICK_DT_MS); // 12 000 @ 20 Hz
    vi.advanceTimersByTime((ttlTicks - 1) * TICK_DT_MS);
    expect(shard.entities.has('wreck:ship-p1')).toBe(true); // one tick early: still there
    vi.advanceTimersByTime(TICK_DT_MS); // the final tick
    expect(shard.entities.has('wreck:ship-p1')).toBe(false); // expired
    // The RESPAWNED scout (not a frozen dead ship) waits at the dock.
    expect(shard.entities.has('ship-p1')).toBe(true);
    expect(shard.entities.get('ship-p1')!.docked).toBe(true);
    shard.stop();
  });

  it('AI sources flow through the events unharmed', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');
    shard.applyHit('ship-p1', 5, { kind: 'ai', id: 'patrol-3' }, WEAPON);
    expect(combatEvents(sends)).toEqual([
      {
        kind: 'hit',
        target: 'ship-p1',
        source: { kind: 'ai', id: 'patrol-3' },
        weapon: WEAPON,
        damage: 5,
        shieldHit: 5,
        hullHit: 0,
      },
    ]);
    shard.stop();
  });
});

describe('SystemShard dock bus swap (TASK-23 step 3, in-shard)', () => {
  it('a bus swap (dock purchase/repair) updates the in-shard entity in place: hull, dock, position', async () => {
    const system = testSystem();
    const bus = createShipSwapBus();
    const shard = new SystemShard({
      systemId: system.systemId,
      galaxySeed: SEED,
      system,
      repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
      shipSwapBus: bus,
      log: { debug() {}, warn() {}, info() {} },
    });
    const entity = makeEntity('p1', { x: 9, y: 9, z: 9 });
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Alpha');
    // TASK-49: a destroyed PLAYER ship already respawned in place (docked
    // starter scout) — the bus swap now re-points the SAME entity at the new
    // ship record (a dock purchase / repair while docked).
    shard.applyHit('ship-p1', 150, AI, WEAPON);
    expect(entity.destroyed).toBeFalsy();
    expect(entity.docked).toBe(true);
    expect(shard.enqueueInput('p1', input(1, { thrust: 1 }))).toBe(true);

    const repaired: ShipRowLike = {
      id: 'ship-p1',
      classId: 'scout',
      livery: {},
      hull: 100,
      shields: 50,
      position: { systemId: system.systemId, x: 1, y: 0, z: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      state: 'docked',
    };
    bus.emitSwap({ playerId: 'p1', ship: repaired, oldShipId: 'ship-p1' });
    // The bus handler is async-safe; the shard's handler body is synchronous,
    // but let one microtask drain so the promise chain settles.
    await Promise.resolve();

    expect(entity.destroyed).toBe(false);
    expect(entity.hull).toBe(1);
    expect(entity.shields).toBe(1);
    expect(entity.docked).toBe(true);
    expect(entity.ship.pos).toEqual({ x: 1, y: 0, z: 1 });
    // And it flies again.
    expect(shard.enqueueInput('p1', input(2, { thrust: 1 }))).toBe(true);

    shard.stop();
  });
});
