import { describe, expect, it } from 'vitest';

import { MINING_UNIT_MS } from '@shared/mining';
import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-38 steps 1–2: the server mining channel through the REAL SimLoop with
 * an INJECTED clock (fake timers — the shard's `now` option). The shard
 * conventions are shard.interact.test.ts' (stub repo/bus/log, one step per
 * 50 ms, pad position ONLY from the derived pad — here the character is
 * teleported instead, like shard.deposits.test.ts).
 *
 * Contracts under test:
 * - a unit is awarded ONLY on the server's 1.5 s tick (spamming
 *   'mine-tick' changes nothing — the anti-spam AC);
 * - cancel (mine-stop / range loss / re-entry / disconnect) awards nothing;
 * - the weight cap PAUSES the channel ('full' echo) and the held award lands
 *   once space frees;
 * - depletion despawns the deposit for everyone and ends the channel
 *   ('depleted');
 * - two miners on one deposit: the last unit goes to exactly one of them
 *   (atomic decrement, no negative remaining).
 */

const SEED = 'MINING-SIM-SEED';
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
  systemId: 'sys-mining-sim',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};

interface WireMsg {
  type: string;
  payload: {
    phase?: string;
    reason?: string;
    status?: string;
    depositId?: string;
    units?: number;
    progress?: number;
  };
}

let fakeNow = 1_000_000;

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
    now: () => fakeNow,
  });
}

/** Advance the fake clock `ms`, running one sim tick per 50 ms step. */
function advance(shard: SystemShard, ms: number): void {
  const end = fakeNow + ms;
  while (fakeNow < end) {
    fakeNow += 50;
    shard.sim.step(fakeNow);
  }
}

/** A docked player ship + its on-foot character, both at `pos` (feet). */
function onFootAt(shard: SystemShard, pos: Vec3, playerId: string, callsign: string): void {
  const ship: SimEntity = {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign,
    classId: 'scout',
    ship: { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'surface' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: true,
    padId: 'pad-test',
    planetId: PLANET.id,
  };
  shard.addEntity(ship);
  shard.registerConnection(playerId, callsign, () => undefined);
  shard.addEntity({
    id: `char:${playerId}`,
    kind: 'character',
    playerId,
    callsign,
    classId: 'scout',
    ship: { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'surface' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId: PLANET.id,
    charOnGround: true,
  });
}

/** A player that RECEIVES its connection frames (the mining echoes land here). */
function onFootAtListening(
  shard: SystemShard,
  pos: Vec3,
  playerId: string,
  callsign: string,
  sent: string[],
): void {
  const ship: SimEntity = {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign,
    classId: 'scout',
    ship: { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'surface' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: true,
    padId: 'pad-test',
    planetId: PLANET.id,
  };
  shard.addEntity(ship);
  shard.registerConnection(playerId, callsign, (b) => sent.push(b));
  shard.addEntity({
    id: `char:${playerId}`,
    kind: 'character',
    playerId,
    callsign,
    classId: 'scout',
    ship: { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'surface' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId: PLANET.id,
    charOnGround: true,
  });
}

const miningFrames = (sent: string[]): WireMsg[] =>
  sent.map((b) => JSON.parse(b) as WireMsg).filter((m) => m.type === 'mining');

describe('TASK-38: the server mining channel (fake timers, real SimLoop)', () => {
  it('full channel: the FIRST unit lands exactly at the server 1.5 s tick (nothing before)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    onFootAt(shard, pos, 'p1', 'miner');
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 3);

    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');
    expect(shard.mining.get('p1')?.depositId).toBe(dep);

    // 1.45 s of channeling: NOT due — the deposit and inventory are untouched.
    advance(shard, 1_450);
    expect(shard.entities.get(dep)?.quantity).toBe(3);
    expect(shard.getInventory('p1')).toEqual({});

    // Cross the 1.5 s boundary: exactly ONE unit lands (deposit −1, +1 iron).
    advance(shard, 100);
    expect(shard.entities.get(dep)?.quantity).toBe(2);
    expect(shard.getInventory('p1')).toEqual({ iron: 1 });
    expect(shard.mining.get('p1')?.unitsSoFar).toBe(1);

    // A second unit needs a full 1.5 s of the NEXT cadence (the anchor is
    // the last award, not the start — the shared stepMiningChannel math).
    advance(shard, 1_400);
    expect(shard.entities.get(dep)?.quantity).toBe(2);
    advance(shard, 100);
    expect(shard.entities.get(dep)?.quantity).toBe(1);
    expect(shard.getInventory('p1')).toEqual({ iron: 2 });
    shard.stop();
  });

  it('anti-spam: 20 "mine-tick" messages inside 1 s award NOTHING; the tick cadence is the truth', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    onFootAt(shard, pos, 'p1', 'miner');
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 10);

    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');
    for (let i = 0; i < 20; i++) {
      advance(shard, 50); // 1 s of spam, 20 mine-tick re-assertions
      expect(shard.handleInteract('p1', dep, 'mine-tick')).toBe('ok');
    }
    expect(shard.entities.get(dep)?.quantity).toBe(10); // spam gained nothing extra
    expect(shard.getInventory('p1')).toEqual({});

    // After the true 1.5 s cadence the floor-expected count is exactly 1
    // (1600 ms elapsed < 2 × 1500 ms).
    advance(shard, 1_000);
    expect(shard.entities.get(dep)?.quantity).toBe(9);
    expect(shard.getInventory('p1')).toEqual({ iron: 1 });
    shard.stop();
  });

  it('cancel: "mine-stop" mid-channel awards nothing (the in-flight unit is not granted)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    const sent: string[] = [];
    onFootAtListening(shard, pos, 'p1', 'miner', sent);
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 3);

    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');
    advance(shard, 700); // 0.7 s into the first 1.5 s unit
    expect(shard.handleInteract('p1', dep, 'mine-stop')).toBe('ok');
    advance(shard, 2_000); // well past where a unit would have landed
    expect(shard.entities.get(dep)?.quantity).toBe(3);
    expect(shard.getInventory('p1')).toEqual({});
    expect(shard.mining.size).toBe(0);
    // The ended frame carries the cancel (the client hides the HUD).
    const ended = miningFrames(sent).filter((f) => f.payload.phase === 'ended');
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toEqual(
      expect.objectContaining({ phase: 'ended', reason: 'stopped', units: 0, depositId: dep }),
    );
    shard.stop();
  });

  it('range loss: walking > 3 m away cancels per tick (no unit awarded)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    onFootAt(shard, pos, 'p1', 'miner');
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 3);
    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');

    // Walk 4 m away (the test teleport — the per-tick range check sees it).
    const character = shard.entities.get('char:p1')!;
    character.ship.pos = { x: pos.x + 4, y: pos.y, z: pos.z };
    advance(shard, 100);
    expect(shard.mining.size).toBe(0);
    advance(shard, 2_000);
    expect(shard.entities.get(dep)?.quantity).toBe(3);
    expect(shard.getInventory('p1')).toEqual({});
    shard.stop();
  });

  it('re-entry into the ship cancels the channel (the character is gone)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    onFootAt(shard, pos, 'p1', 'miner');
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 3);
    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');

    // The ship sits right on top of the character → the 5 m enter check passes.
    expect(shard.handleInteract('p1', `ship-p1`)).toBe('ok');
    advance(shard, 100); // the tick sees no character → cancelled
    expect(shard.mining.size).toBe(0);
    advance(shard, 2_000);
    expect(shard.entities.get(dep)?.quantity).toBe(3);
    expect(shard.getInventory('p1')).toEqual({});
    shard.stop();
  });

  it('disconnect kills the channel (no awarding into an empty backpack)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    onFootAt(shard, pos, 'p1', 'miner');
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 3);
    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');
    advance(shard, 700);

    shard.leavePlayer('p1');
    advance(shard, 2_000);
    expect(shard.mining.size).toBe(0);
    expect(shard.entities.get(dep)?.quantity).toBe(3);
    expect(shard.getInventory('p1')).toEqual({});
    shard.stop();
  });

  it('weight cap: the channel PAUSES ("full") and the held award lands once space frees', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    const sent: string[] = [];
    onFootAtListening(shard, pos, 'p1', 'miner', sent);
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 5, 'copper');
    shard.giveInventoryForTesting('p1', { iron: 40 }); // the 40 u cap, full

    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');
    advance(shard, 1_700); // due — but 0 u of room
    expect(shard.entities.get(dep)?.quantity).toBe(5); // nothing awarded
    expect(shard.getInventory('p1')).toEqual({ iron: 40 });
    // The echo reports the PAUSE (the client's 'Backpack full' prompt).
    const active = miningFrames(sent).filter((f) => f.payload.phase === 'active');
    expect(active.length).toBeGreaterThan(0);
    expect(active[active.length - 1].payload.status).toBe('full');

    // Free 1 u (drop one iron through the REAL drop path): the held award
    // lands on the very next tick (lastAwardAt was never advanced).
    expect(shard.handleDrop('p1', 'iron', 1)).toBe('ok');
    advance(shard, 100);
    expect(shard.getInventory('p1')).toEqual({ iron: 39, copper: 1 });
    expect(shard.entities.get(dep)?.quantity).toBe(4);
    shard.stop();
  });

  it('depletion: the last unit despawns the deposit for everyone and ends the channel "depleted"', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    const sent: string[] = [];
    onFootAtListening(shard, pos, 'p1', 'miner', sent);
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 2);

    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');
    advance(shard, MINING_UNIT_MS + 100);
    expect(shard.entities.get(dep)?.quantity).toBe(1);
    expect(shard.getInventory('p1')).toEqual({ iron: 1 });
    advance(shard, MINING_UNIT_MS + 100);
    expect(shard.entities.has(dep)).toBe(false); // despawned for every client
    expect(shard.getInventory('p1')).toEqual({ iron: 2 });
    expect(shard.mining.size).toBe(0);
    const ended = miningFrames(sent).filter((f) => f.payload.phase === 'ended');
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toEqual(
      expect.objectContaining({ phase: 'ended', reason: 'depleted', units: 2, depositId: dep }),
    );
    // No further awards after the deposit is gone (nothing to mine).
    advance(shard, 3_000);
    expect(shard.getInventory('p1')).toEqual({ iron: 2 });
    shard.stop();
  });

  it('concurrent miners: two players, one last unit — it lands exactly once, remaining never negative', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    onFootAt(shard, pos, 'p1', 'miner-a');
    onFootAt(shard, { x: pos.x + 0.5, y: pos.y, z: pos.z }, 'p2', 'miner-b');
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 1);

    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');
    expect(shard.handleInteract('p2', dep, 'mine-start')).toBe('ok');
    advance(shard, MINING_UNIT_MS + 100); // both ticks are due on the same tick

    const a = shard.getInventory('p1');
    const b = shard.getInventory('p2');
    const total = (a.iron ?? 0) + (b.iron ?? 0);
    expect(total).toBe(1); // the last unit went to exactly ONE of them
    expect(shard.entities.has(dep)).toBe(false); // despawned at zero
    expect(shard.mining.size).toBe(0); // both channels ended cleanly
    expect(shard.entities.get(dep)?.quantity).toBeUndefined(); // never negative
    shard.stop();
  });

  it("mining works on any resource type: the unit lands as the deposit's resource", () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    onFootAt(shard, pos, 'p1', 'miner');
    const dep = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 2, 'rare-earth');
    expect(shard.handleInteract('p1', dep, 'mine-start')).toBe('ok');
    advance(shard, MINING_UNIT_MS + 100);
    expect(shard.getInventory('p1')).toEqual({ 'rare-earth': 1 });
    expect(shard.entities.get(dep)?.quantity).toBe(1);
    shard.stop();
  });

  it('switching deposits mid-hold cancels the old channel and starts a fresh one', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const pos = { x: 0, y: 0, z: 0 };
    const sent: string[] = [];
    onFootAtListening(shard, pos, 'p1', 'miner', sent);
    const depA = shard.addDepositForTesting({ x: pos.x, y: pos.y, z: pos.z + 1 }, 3);
    const depB = shard.addDepositForTesting({ x: pos.x + 2, y: pos.y, z: pos.z + 1 }, 3, 'copper');

    expect(shard.handleInteract('p1', depA, 'mine-start')).toBe('ok');
    advance(shard, 700);
    expect(shard.handleInteract('p1', depB, 'mine-start')).toBe('ok'); // switch target
    expect(shard.mining.get('p1')?.depositId).toBe(depB);
    // The OLD channel's in-flight unit is NOT awarded on A…
    advance(shard, 1_000);
    expect(shard.entities.get(depA)?.quantity).toBe(3);
    // …while the NEW channel runs its own 1.5 s cadence on B (copper).
    advance(shard, MINING_UNIT_MS);
    expect(shard.entities.get(depB)?.quantity).toBe(2);
    expect(shard.getInventory('p1')).toEqual({ copper: 1 });
    const switched = miningFrames(sent).filter(
      (f) => f.payload.phase === 'ended' && f.payload.depositId === depA,
    );
    expect(switched).toHaveLength(1);
    expect(switched[0].payload.reason).toBe('cancelled');
    shard.stop();
  });
});
