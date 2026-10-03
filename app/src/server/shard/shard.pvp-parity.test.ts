import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generateSystem } from '@shared/galaxy/system';
import { generateStars } from '@shared/galaxy/stars';
import type { SystemGen } from '@shared/galaxy/types';
import type { Vec3 } from '@shared/physics/vec';

import { mulberry32 } from './ai';
import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-47: PvP parity — players use the IDENTICAL combat pipeline vs AI.
 *
 * Two proofs:
 * 1. CODE PATH AUDIT (AC 1): a static scan of the server source asserts the
 *    fire handling has exactly ONE implementation — one fireLaser/fireMissile
 *    pair, one hit pipeline (handleWeaponContact → applyHit), and that BOTH
 *    resolvers (the player's resolveFireIntent and the AI's resolveAiFire)
 *    funnel into it, with the wire 'fire' branch the single inbound route.
 * 2. PARITY PROPERTY TEST (AC 3): 100 random fire sequences (weapon, timing,
 *    target positions) replayed against two identical shards — one whose
 *    target is an AI ship, one whose target is an identical PLAYER ship
 *    (same class, same start). The hull/shield trajectories must match
 *    EXACTLY (determinism + shared pipeline proof). If this ever diverges,
 *    the bug is in TASK-43/46 (a branch in the shared pipeline) — not here.
 *
 * Shard conventions follow shard.targeting.test.ts: fake `now`, one tick per
 * 50 ms via shard.sim.step, entities placed by hand in open space (no LOS,
 * no terrain, no rogue roster).
 */

const SEED = 'PVP-PARITY-SEED';
const SYSTEM: SystemGen = (() => {
  const star = generateStars(SEED, 4)[0];
  return generateSystem(SEED, star.id);
})();

/** One shard + its scripted shooter (interceptor) and target, in open space. */
function makeSide(kind: 'ai-ship' | 'ship') {
  let fakeNow = 1_000_000;
  const shard = new SystemShard({
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
    now: () => fakeNow,
    spawnRogues: false, // the scripted targets are the only non-shooter entities
  });
  // The shooter: a player INTERCEPTOR (laser + missile) at the origin, nose +Z.
  const shooter: SimEntity = {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'P1',
    classId: 'interceptor',
    ship: {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
  };
  shard.addEntity(shooter);
  shard.registerConnection('p1', 'P1', () => {});
  // The target: IDENTICAL class (scout 50/100) + start — an ai-ship in one
  // shard, a live player ship in the other (the parity pair under test).
  const target: SimEntity = {
    id: 'ship-p9',
    kind: kind,
    playerId: kind === 'ship' ? 'p9' : null,
    callsign: kind === 'ship' ? 'P9' : 'AI-001-1',
    classId: 'scout',
    ship: {
      pos: { x: 0, y: 0, z: 100 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
  };
  shard.addEntity(target);
  if (kind === 'ship') shard.registerConnection('p9', 'P9', () => {});

  /** Advance the fake clock, one sim tick per 50 ms step. */
  function step(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      fakeNow += 50;
      shard.sim.step(fakeNow);
    }
  }

  /** Reposition the target (both shards replay the SAME point each shot). */
  function aimTarget(pos: Vec3): void {
    target.ship.pos = { ...pos };
  }

  /** Reset to a full-hull, full-energy, cooldown-free state (sequence start). */
  function reset(): void {
    target.hull = 1;
    target.shields = 1;
    shooter.energy = 100;
    shooter.fireCooldownUntil = undefined;
  }

  return { shard, shooter, target, step, aimTarget, reset };
}

/** One random shot: weapon, the gap after the previous shot, a target point. */
function generateShot(rng: () => number): {
  weapon: 'laser' | 'missile';
  gapTicks: number;
  pos: Vec3;
} {
  const weapon = rng() < 0.65 ? 'laser' : 'missile';
  // ≥ the weapon's cooldown, plus room for a missile's full 5 s ttl flight.
  const gapTicks = weapon === 'laser' ? 8 + Math.floor(rng() * 24) : 45 + Math.floor(rng() * 60);
  const dist = 30 + rng() * 320; // always in laser (400) and missile (800) range
  const theta = rng() * Math.PI * 2;
  const phi = (rng() - 0.5) * Math.PI;
  const pos: Vec3 = {
    x: Math.cos(theta) * Math.cos(phi) * dist,
    y: Math.sin(phi) * dist,
    z: Math.sin(theta) * Math.cos(phi) * dist,
  };
  return { weapon, gapTicks, pos };
}

type Side = ReturnType<typeof makeSide>;
type Trajectory = number[][]; // [tick, hull, shields] per tick, EXACT values

/** Replay one fire sequence on one side, recording the tick-by-tick trajectory. */
function replay(side: Side, seq: number): Trajectory {
  const rng = mulberry32((0x5eed + seq) >>> 0);
  side.reset();
  const traj: Trajectory = [];
  const shots = 3 + Math.floor(rng() * 6); // 3..8 shots
  for (let s = 0; s < shots; s++) {
    const shot = generateShot(rng);
    side.aimTarget(shot.pos);
    side.shard.handleFire('p1', { weapon: shot.weapon, targetId: 'ship-p9' });
    for (let t = 0; t < shot.gapTicks; t++) {
      side.step(1);
      traj.push([side.shard.sim.tickNumber, side.target.hull, side.target.shields]);
    }
  }
  // Settle: let any missile in flight finish (its ttl is at most 100 ticks).
  for (let t = 0; t < 100; t++) {
    side.step(1);
    traj.push([side.shard.sim.tickNumber, side.target.hull, side.target.shields]);
  }
  return traj;
}

describe('TASK-47 code path audit: exactly ONE fire implementation', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'shard.ts'), 'utf8');
  const combatSrc = fs.readFileSync(path.join(here, 'combat.ts'), 'utf8');
  const routingSrc = fs.readFileSync(path.join(here, '..', 'shards.ts'), 'utf8');
  const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  /** The source between two method signatures (the first method's region). */
  function between(source: string, fromSig: string, toSig: string): string {
    const start = source.indexOf(fromSig);
    const end = source.indexOf(toSig, start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('the pipeline has exactly one definition of each stage', () => {
    // One definition of every pipeline stage in shard.ts…
    expect(count(src, 'private fireLaser(')).toBe(1);
    expect(count(src, 'private fireMissile(')).toBe(1);
    expect(count(src, 'private resolveFireIntent(')).toBe(1);
    expect(count(src, 'private resolveAiFire(')).toBe(1);
    expect(count(src, 'handleWeaponContact(')).toBeGreaterThanOrEqual(1);
    expect(count(src, '\n  applyHit(')).toBe(1); // the definition
    expect(count(src, 'private destroyEntity(')).toBe(1);
    expect(count(src, 'private detonateMissile(')).toBe(1);
    // …the shared damage model is applied from exactly ONE place (applyHit):
    // no parallel damage path can exist without touching that count.
    expect(count(src, 'applyDamage(')).toBe(1);
    expect(count(src, 'this.applyHit(')).toBe(2); // missile direct + splash
    expect(count(src, 'this.handleWeaponContact(')).toBe(1); // fireLaser only
    // combat.ts: resolveHit is the ONLY consumer of the contact contract.
    expect(count(combatSrc, 'shard.applyHit(')).toBe(1);
  });

  it('player fire and AI fire both funnel into the same fireLaser/fireMissile pair', () => {
    expect(count(src, 'this.fireLaser(')).toBe(2); // resolveFireIntent + resolveAiFire
    expect(count(src, 'this.fireMissile(')).toBe(2);
    // The player resolver's region ends at fireLaser itself; the AI
    // resolver's at the next method (stepAiShips).
    const playerRegion = between(src, 'private resolveFireIntent(', 'private fireLaser(');
    const aiRegion = between(src, 'private resolveAiFire(', 'private stepAiShips(');
    expect(playerRegion).toContain('this.fireLaser(');
    expect(playerRegion).toContain('this.fireMissile(');
    expect(aiRegion).toContain('this.fireLaser(');
    expect(aiRegion).toContain('this.fireMissile(');
  });

  it("the wire 'fire' branch is the single inbound fire route (no parallel player-combat code)", () => {
    expect(routingSrc).toMatch(/type === 'fire'/);
    expect(count(routingSrc, 'shard.handleFire(')).toBe(1);
    // Every NON-TEST server file: handleFire is invoked nowhere else.
    const serverDir = path.join(here, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
          files.push(full);
      }
    };
    walk(serverDir);
    let callSites = 0;
    for (const file of files) {
      if (file.endsWith('shard.ts')) continue; // the definition
      callSites += count(fs.readFileSync(file, 'utf8'), '.handleFire(');
    }
    expect(callSites).toBe(1); // the routeGameMessage 'fire' branch
  });
});

describe('TASK-47 parity property test: 100 fire sequences, AI target vs player target', () => {
  it('identical hull/shield trajectories on an ai-ship and an identical player ship', () => {
    const playerSide = makeSide('ship'); // shooter p1 → player target p9
    const aiSide = makeSide('ai-ship'); // shooter p1 → ai-ship target (same class/start)
    let seq0Traj: Trajectory | undefined;
    for (let seq = 0; seq < 100; seq++) {
      // Replay the SAME generated sequence on both sides (same seed → the
      // same weapons, gaps and target positions, tick for tick).
      const trajPlayer = replay(playerSide, seq);
      const trajAi = replay(aiSide, seq);
      expect(trajPlayer).toEqual(trajAi); // EXACT hull/shield trajectory match
      if (seq === 0) seq0Traj = trajPlayer;
    }
    playerSide.shard.stop();
    aiSide.shard.stop();

    // Determinism: a FRESH pair of shards replaying sequence 0 reproduces
    // the recorded trajectory bit-for-bit.
    const freshPlayer = makeSide('ship');
    const freshAi = makeSide('ai-ship');
    expect(replay(freshPlayer, 0)).toEqual(seq0Traj);
    expect(replay(freshAi, 0)).toEqual(seq0Traj);
    freshPlayer.shard.stop();
    freshAi.shard.stop();
  }, 60_000);

  it('the sequences actually deal damage (the trajectories are non-trivial)', () => {
    const aiSide = makeSide('ai-ship');
    const traj = replay(aiSide, 0);
    // Sequence 0 must land hits: the final hull/shield state is strictly
    // below full (and the trajectory is not a flat line).
    const [, hull, shields] = traj[traj.length - 1]; // [tick, hull, shields]
    expect(hull + shields).toBeLessThan(2);
    const distinct = new Set(traj.map((t) => `${t[1]}:${t[2]}`)).size;
    expect(distinct).toBeGreaterThan(1);
    aiSide.shard.stop();
  }, 30_000);
});
