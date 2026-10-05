import { describe, expect, it } from 'vitest';

import type { Planet, SystemGen } from '@shared/galaxy/types';
import { vecLength, vecSub } from '@shared/physics/vec';
import { rosterFor } from '@shared/world/ai';

import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-45 step 2: the shard's rogue AI integration — the constructor loads
 * the seeded roster (6-10 full-hull ai-ship entities), a killed rogue
 * respawns IN PLACE at its spawnPos after exactly 120 s (fake clock, tick
 * timer — no setTimeout), a 'rogue respawn' debug log rides the event, and
 * a reaped shard (fresh SystemShard) re-derives the full roster. Shard
 * conventions follow shard.targeting.test.ts (fake `now`, one tick / 50 ms).
 */

const SEED = 'ROGUE-AI-SIM-SEED';
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
  systemId: 'sys-rogue-sim',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};

let fakeNow = 1_000_000;

interface LogLines {
  debug: string[];
  warn: string[];
  info: string[];
}

function makeShard(log: LogLines): SystemShard {
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
    log: {
      debug: (m) => log.debug.push(m),
      warn: (m) => log.warn.push(m),
      info: (m) => log.info.push(m),
    },
    now: () => fakeNow,
  });
}

const logLines = (): LogLines => ({ debug: [], warn: [], info: [] });

/** Advance the fake clock `ms`, one sim tick per 50 ms step. */
function advance(shard: SystemShard, ms: number): void {
  const end = fakeNow + ms;
  while (fakeNow < end) {
    fakeNow += 50;
    shard.sim.step(fakeNow);
  }
}

/** Burn the SimLoop's initial catch-up burst so each advance = exactly 1 tick. */
function warmup(shard: SystemShard): void {
  advance(shard, 250);
}

const roguesOf = (shard: SystemShard): SimEntity[] =>
  [...shard.entities.values()].filter((e) => e.kind === 'ai-ship');

describe('shard rogue AI (TASK-45 AC)', () => {
  it('spawn loads the seeded roster: 6-10 ai-ship entities, full hull, at spawnPos, ai flag on the wire', () => {
    fakeNow = 1_000_000;
    const shard = makeShard(logLines());
    warmup(shard);

    const roster = rosterFor(SEED, SYSTEM);
    const rogues = roguesOf(shard);
    expect(roster.length).toBeGreaterThanOrEqual(6);
    expect(roster.length).toBeLessThanOrEqual(10);
    expect(rogues).toHaveLength(roster.length);
    const callsigns = new Set<string>();
    for (const entry of roster) {
      const e = shard.entities.get(entry.aiId);
      expect(e, entry.aiId).toBeDefined();
      expect(e!.kind).toBe('ai-ship');
      expect(e!.playerId).toBeNull();
      expect(e!.classId).toBe(entry.classId);
      expect(e!.callsign).toBe(entry.callsign);
      callsigns.add(e!.callsign!);
      // Full hull/shields (normalized), undocked, space regime, spawned at
      // spawnPos (TASK-46: the rogue PATROLS from there, so the warmup ticks
      // drift it a few units — in-place spawn, no longer exact rest).
      expect(e!.hull).toBe(1);
      expect(e!.shields).toBe(1);
      expect(e!.docked).toBe(false);
      expect(e!.destroyed).toBeUndefined();
      expect(e!.ship.regime).toBe('space');
      expect(vecLength(vecSub(e!.ship.pos, entry.spawnPos))).toBeLessThan(25);
      expect(vecLength(e!.ship.vel)).toBeLessThan(100); // never above patrol speed
    }
    expect(callsigns.size).toBe(rogues.length);

    // The wire state carries the ai flag + callsign (same EntityState shape
    // as player ships — the client's presence list marks them 'AI').
    const [state] = shard.snapshot().filter((s) => s.kind === 'ai-ship');
    expect(state).toBeDefined();
    expect(state!.ai).toBe(true);
    expect(state!.callsign).toBeTruthy();
    // Player-shaped states omit the flag.
    expect(shard.snapshot().filter((s) => s.kind !== 'ai-ship' && s.ai !== undefined)).toEqual([]);
    shard.stop();
  });

  it('a killed rogue respawns FULL at its spawnPos after 120 s (fake timers), with a debug log', () => {
    fakeNow = 1_000_000;
    const lines = logLines();
    const shard = makeShard(lines);
    warmup(shard);
    const entry = rosterFor(SEED, SYSTEM)[0];
    const rogue = shard.entities.get(entry.aiId)!;

    // Kill it (player source: 100 000 points > shields + hull of any class).
    const result = shard.applyHit(rogue.id, 100_000, { kind: 'player', id: 'p1' }, 'laser');
    expect(result?.destroyed).toBe(true);
    expect(rogue.destroyed).toBe(true);
    expect(rogue.hull).toBe(0);
    expect(rogue.shields).toBe(0);

    // 119.9 s later: still down (the 120 s has not elapsed).
    advance(shard, 119_900);
    expect(rogue.destroyed).toBe(true);
    expect(rogue.hull).toBe(0);

    // Cross the 120 s boundary: respawned IN PLACE — same id, full, at
    // spawnPos (TASK-46: the couple of live patrol ticks drift it a
    // whisker), slow, energy full, flag back to the snapshot.
    advance(shard, 100);
    expect(rogue.destroyed).toBe(false);
    expect(rogue.hull).toBe(1);
    expect(rogue.shields).toBe(1);
    expect(vecLength(vecSub(rogue.ship.pos, entry.spawnPos))).toBeLessThan(25);
    expect(vecLength(rogue.ship.vel)).toBeLessThan(100); // never above patrol speed
    expect(rogue.energy).toBe(100);
    expect(lines.debug).toContain('rogue respawn');
    const [state] = shard.snapshot().filter((s) => s.id === entry.aiId);
    expect(state?.hull ?? 1).toBe(1); // TASK-18: full hull rides the wire default
    expect(state?.ai).toBe(true);
    shard.stop();
  });

  it('shard reap re-derives the roster to full: a fresh shard has the same full roster', () => {
    fakeNow = 1_000_000;
    const shard = makeShard(logLines());
    warmup(shard);
    // Kill every rogue, then let them all respawn at full.
    for (const r of roguesOf(shard)) {
      shard.applyHit(r.id, 100_000, { kind: 'ai', id: 'rogue-weapon' }, 'laser');
    }
    expect(roguesOf(shard).every((r) => r.destroyed)).toBe(true);
    advance(shard, 120_100);
    expect(roguesOf(shard).every((r) => !r.destroyed && r.hull === 1 && r.shields === 1)).toBe(
      true,
    );
    shard.stop(); // the reap path drops the shard object entirely

    // The reap sim: a fresh shard for the same system re-derives the roster
    // to full (rogues are renewable — no persisted state exists).
    const reborn = makeShard(logLines());
    const expected = rosterFor(SEED, SYSTEM);
    const live = roguesOf(reborn);
    expect(live).toHaveLength(expected.length);
    for (const entry of expected) {
      const e = reborn.entities.get(entry.aiId)!;
      expect(e.hull).toBe(1);
      expect(e.shields).toBe(1);
      expect(e.ship.pos).toEqual(entry.spawnPos);
    }
    reborn.stop();
  });
});
