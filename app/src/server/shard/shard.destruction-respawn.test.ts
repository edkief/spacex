import { describe, expect, it } from 'vitest';

import { padsForSystem } from '@shared/world/pads';
import { SHIP_CLASSES } from '@shared/ships';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import type { Vec3 } from '@shared/physics/vec';
import type { InventoryStacks } from '@shared/inventory';
import { emptyCargoHold } from '@shared/cargo';

import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-49: the full death-and-recovery loop, at the shard level (the single
 * writer). A killer's weapon drives a ship's hull to zero → the destruction
 * sequence (wreck with killer attribution + 'destroyed'/'kill' events) and —
 * for a player ship — the immediate dock respawn in a fresh starter scout
 * (cargo LOST, credits + on-foot inventory KEPT). Also: docked-ship
 * invulnerability (the safe zone — the "destroyed while on foot" guard), the
 * wreck's 600 s ttl expiry, and two players observing the same wreck.
 *
 * Shard conventions are shard.weapons.test.ts': stub repo/bus/log, a FAKE
 * `now` closure, one sim tick per 50 ms of fake time.
 */

const SEED = 'DESTRUCTION-RESPAWN-SEED';
const PLANET: Planet = {
  id: 'planet-1',
  name: 'Varda',
  class: 'terran',
  radiusKm: 3000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ['iron'],
  aiRoster: { count: 0, classes: [] },
};
const SYSTEM: SystemGen = {
  systemId: 'sys-destruction-respawn',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};

let fakeNow = 1_000_000;

/** The system's single pad (one landable planet) — the respawn target. */
const PAD = padsForSystem(SEED, SYSTEM)[0];

function makeShard(
  repo: SystemShard['repo'] = {
    getShipByOwner: async () => undefined,
    getPlayersByIds: async () => [],
  },
): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: SEED,
    system: SYSTEM,
    repo,
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: { debug() {}, warn() {}, info() {} },
    now: () => fakeNow,
    spawnRogues: false,
  });
}

/** Advance the fake clock `ms`, one sim tick per 50 ms step. */
function advance(shard: SystemShard, ms: number): void {
  const end = fakeNow + ms;
  while (fakeNow < end) {
    fakeNow += 50;
    shard.sim.step(fakeNow);
  }
}

function shipAt(
  shard: SystemShard,
  playerId: string,
  pos: Vec3,
  classId: string,
  sent?: string[],
  extra?: Partial<SimEntity>,
): SimEntity {
  const entity: SimEntity = {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId,
    classId,
    ship: {
      pos: { ...pos },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    ...extra,
  };
  shard.addEntity(entity);
  shard.registerConnection(playerId, playerId, (b) => sent?.push(b));
  return entity;
}

interface Envelope {
  type: string;
  payload: unknown;
}
const combat = (sent: string[]): Record<string, unknown>[] =>
  sent
    .map((b) => JSON.parse(b) as Envelope)
    .filter((m) => m.type === 'combat_event')
    .map((m) => m.payload as Record<string, unknown>);
const snapshots = (sent: string[]): Array<{ entities: Array<Record<string, unknown>> }> =>
  sent
    .map((b) => JSON.parse(b) as Envelope)
    .filter((m) => m.type === 'entity_update')
    .map((m) => m.payload as { entities: Array<Record<string, unknown>> });

function warmup(shard: SystemShard): void {
  advance(shard, 250);
}

describe('destruction → respawn (the full death-and-recovery loop)', () => {
  it('A kills B: B respawns at the nearest dock in a fresh starter scout — cargo LOST, credits+inventory KEPT, wreck carries A', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    const eA = shipAt(shard, 'p1', { x: 60000, y: 60000, z: 0 }, 'interceptor', a);
    const eB = shipAt(shard, 'p2', { x: 60060, y: 60000, z: 0 }, 'scout', b);
    warmup(shard);

    // B is carrying loot: a cargo hold (LOST on death) + an on-foot inventory
    // (KEPT) + credits live on the player row (untouched here).
    eB.cargo = { ...emptyCargoHold('scout'), stacks: { iron: 12 } };
    const backpack: InventoryStacks = { iron: 12 };
    eB.inventory = backpack;

    // The killer's weapon drives B's hull to zero (the shared pipeline). One
    // overkill hit: shields absorb 50, the overflow caps at the 100 hull.
    const source = { kind: 'player' as const, id: 'p1' };
    shard.applyHit('ship-p2', 1000, source, 'missile');

    // (1) RESPAWN: the SAME ship id is reset in place to a fresh starter
    //     scout, docked at the nearest pad (here the system's single pad).
    const respawned = shard.playerEntities.get('p2')!;
    expect(respawned.id).toBe('ship-p2'); // wire-stable id (the client re-renders it)
    expect(respawned.destroyed).toBe(false);
    expect(respawned.classId).toBe('scout');
    expect(respawned.hull).toBe(1);
    expect(respawned.shields).toBe(1);
    expect(respawned.docked).toBe(true);
    expect(respawned.padId).toBe(PAD.padId);
    expect(respawned.livery).toEqual(SHIP_CLASSES.scout.defaultLivery);
    expect(respawned.ship.pos).toEqual(PAD.pos);
    expect(respawned.ship.vel).toEqual({ x: 0, y: 0, z: 0 });

    // (2) LOSS: the destroyed ship's cargo is LOST (the hold is cleared).
    expect(respawned.cargo).toBeUndefined();
    // The player's on-foot INVENTORY is KEPT (the PRD risk model: mining trips
    // are the stakes, not the player's backpack or credits).
    expect(respawned.inventory).toEqual(backpack);

    // (3) WRECK: a static impostor at B's FINAL position (the death spot, not
    //     the dock) carrying A as the killer (the skull marker, TASK-42/49).
    const wreck = shard.entities.get('wreck:ship-p2')!;
    expect(wreck).toBeDefined();
    expect(wreck.kind).toBe('wreck');
    expect(wreck.killerId).toBe('p1');
    expect(wreck.ship.pos).toEqual({ x: 60060, y: 60000, z: 0 });
    expect(wreck.ttl).toBeTypeOf('number');
    expect(wreck.ttl!).toBeGreaterThan(0);

    // (4) EVENTS: the victim's connection saw the 'destroyed' + the 'kill'
    //     (the PvP feed), both attributed to A.
    expect(combat(b)).toContainEqual({
      kind: 'destroyed',
      target: 'ship-p2',
      source: { kind: 'player', id: 'p1' },
      weapon: 'missile',
    });
    expect(combat(b)).toContainEqual({
      kind: 'kill',
      killer: 'p1',
      victim: 'ship-p2',
      weapon: 'missile',
    });
    // A's own ledger also carries the exchange (the shooter FX).
    expect(combat(a).some((e) => e.kind === 'destroyed')).toBe(true);
    expect(shard.entities.get('ship-p1')!.destroyed).toBeFalsy(); // A survives
    shard.stop();
  });

  it('persists the respawn: respawnShip replaces the record (classId → scout, cargo scrubbed, docked)', async () => {
    fakeNow = 1_000_000;
    const calls: Array<{ shipId: string; onPad: string | null; regime: string }> = [];
    const repo = {
      getShipByOwner: async () => undefined,
      getPlayersByIds: async () => [],
      withTransaction: async (fn: (r: unknown) => Promise<unknown>) => fn(repo),
      respawnShip: async (shipId: string, input: { onPad?: string | null; regime: string }) => {
        calls.push({ shipId, onPad: input.onPad ?? null, regime: input.regime });
        return {} as never;
      },
    };
    const shard = makeShard(repo as never);
    const eB = shipAt(shard, 'p2', { x: 60060, y: 60000, z: 0 }, 'scout');
    warmup(shard);
    const source = { kind: 'player' as const, id: 'p1' };
    shard.applyHit('ship-p2', 1000, source, 'missile');
    expect(eB.destroyed).toBeFalsy(); // respawned in place (immediate server-side)
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget tx settle
    expect(calls).toEqual([{ shipId: 'ship-p2', onPad: PAD.padId, regime: 'surface' }]);
    shard.stop();
  });
});

describe('docked invulnerability (the safe zone)', () => {
  it('a DOCKED ship cannot be damaged by weapons — the fire pipeline deals nothing (the on-foot guard)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor', a);
    // B is DOCKED (a ship its player left — disembarked ships are frozen on
    // the pad). A aims a laser dead at it.
    const eB = shipAt(shard, 'p2', { x: 0, y: 0, z: 100 }, 'scout', b, { docked: true, disembarked: true });
    warmup(shard);

    shard.handleFire('p1', { weapon: 'laser', targetId: 'ship-p2' });
    advance(shard, 100);

    expect(eB.shields).toBe(1); // no damage
    expect(eB.hull).toBe(1);
    expect(eB.destroyed).toBeFalsy(); // the "destroyed while on foot" edge cannot occur
    expect(combat(a).filter((e) => e.kind === 'hit' && e.target === 'ship-p2')).toHaveLength(0);
    expect(combat(b).filter((e) => e.kind === 'hit')).toHaveLength(0);
    shard.stop();
  });

  it('a docked ship cannot be LOCKED (the lock gate rejects it before storing)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'interceptor', a);
    shipAt(shard, 'p2', { x: 0, y: 0, z: 100 }, 'scout', b, { docked: true });
    warmup(shard);

    // A lock within 500 m + cone is normally accepted; a DOCKED target is a
    // safe zone — the lock gate rejects it and stores nothing.
    shard.handleTargetLock('p1', 'ship-p2');
    expect(shard.targets.get('p1')).toBeUndefined(); // no lock stored
    shard.stop();
  });
});

describe('wreck lifecycle', () => {
  it('a wreck expires after its 600 s ttl (fake timers)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const eB = shipAt(shard, 'p2', { x: 60060, y: 60000, z: 0 }, 'scout');
    warmup(shard);
    const source = { kind: 'ai' as const, id: 'ai-x' };
    shard.applyHit('ship-p2', 1000, source, 'missile');
    expect(eB.destroyed).toBeFalsy(); // respawned in place; the wreck is what lingers
    expect(shard.entities.has('wreck:ship-p2')).toBe(true);

    // 599 s: still present. 601 s: gone (the ttl sweep removes it).
    advance(shard, 599_000);
    expect(shard.entities.has('wreck:ship-p2')).toBe(true);
    advance(shard, 2_000);
    expect(shard.entities.has('wreck:ship-p2')).toBe(false);
    shard.stop();
  });

  it('two players observe the SAME wreck (killer marker) on the 10 Hz snapshot', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const a: string[] = [];
    const b: string[] = [];
    const c: string[] = [];
    shipAt(shard, 'p1', { x: 60000, y: 60000, z: 0 }, 'interceptor', a);
    const eB = shipAt(shard, 'p2', { x: 60060, y: 60000, z: 0 }, 'scout', b);
    shipAt(shard, 'p3', { x: 60000, y: 60060, z: 0 }, 'scout', c); // observer
    warmup(shard);

    const source = { kind: 'player' as const, id: 'p1' };
    shard.applyHit('ship-p2', 1000, source, 'missile');
    advance(shard, 200); // let a snapshot (10 Hz) carry the wreck out

    // The OBSERVER C saw the destroyed event AND the wreck (with A's killer
    // marker) in its snapshot — the same wreck B's death produced.
    expect(combat(c).some((e) => e.kind === 'destroyed' && e.target === 'ship-p2')).toBe(true);
    const seen = snapshots(c).flatMap((s) => s.entities).find((e) => e.id === 'wreck:ship-p2');
    expect(seen).toBeDefined();
    expect(seen!.killerId).toBe('p1');
    shard.stop();
  });
});
