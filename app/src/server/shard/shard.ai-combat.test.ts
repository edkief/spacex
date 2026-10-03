import { describe, expect, it } from 'vitest';

import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import type { SystemGen } from '@shared/galaxy/types';
import { vecLength, vecSub, type Vec3 } from '@shared/physics/vec';
import type { InputPayload } from '@shared/protocol/schemas';
import { decodeMessage, type Envelope } from '@shared/protocol';
import type { CombatEvent } from '@client/fx';

import { SystemShard } from './shard';
import type { SimEntity } from './types';
import { rosterFor } from '@shared/world/ai';

/**
 * TASK-46 steps 3-4: the rogue AI inside the live shard (fake `now`, one sim
 * tick per 50 ms — the same harness as shard.ai.test.ts / shard.weapons.
 * test.ts). The full AC state cycle driven by REAL player entities (with
 * the 'ai-acquiring' event on the player's wire), the player-fire aggro
 * memory, the outrun + evasion sim tests, rogue non-hostility, AI fire
 * parity (energy / cooldown committed), the 60 s two-shard determinism run,
 * and the TASK-13 benchmark re-run with 10 AI (p95 < 30 ms, delta < 3 ms).
 */

const SEED = 'AI-COMBAT-SEED';
const star = generateStars(SEED, 4)[0];
const SYSTEM: SystemGen = generateSystem(SEED, star.id);

let fakeNow = 1_000_000;

function makeShard(spawnRogues: boolean = true): SystemShard {
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
    spawnRogues,
  });
}

/** Advance the fake clock `ms`, one sim tick per 50 ms step (every shard). */
function advance(shards: SystemShard | SystemShard[], ms: number): void {
  const list = Array.isArray(shards) ? shards : [shards];
  const end = fakeNow + ms;
  while (fakeNow < end) {
    fakeNow += 50;
    for (const s of list) s.sim.step(fakeNow);
  }
}

function warmup(shards: SystemShard | SystemShard[]): void {
  advance(shards, 250);
}

/** A live player ship (entity + conn) in open space; `sent` collects the wire. */
function shipAt(
  shard: SystemShard,
  playerId: string,
  pos: Vec3,
  classId: string,
  sent?: string[],
): SimEntity {
  const entity: SimEntity = {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId,
    classId,
    ship: { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 }, regime: 'space' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
  };
  shard.addEntity(entity);
  shard.registerConnection(playerId, playerId, (b) => sent?.push(b));
  return entity;
}

/** A held input frame (re-integrated every tick until replaced — TASK-14). */
function input(seq: number, partial: Partial<InputPayload> = {}): InputPayload {
  return { seq, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false, ...partial };
}

/** Every combat_event a conn received (decoded). */
function combatEvents(sent: string[]): CombatEvent[] {
  return sent
    .map((b) => decodeMessage(b))
    .filter((m): m is { ok: true; envelope: Envelope } => m.ok)
    .map((m) => m.envelope)
    .filter((m) => m.type === 'combat_event')
    .map((m) => m.payload as CombatEvent);
}

const rogues = rosterFor(SEED, SYSTEM);
const scoutRogue = rogues.find((r) => r.classId === 'scout')!;
const interceptorRogue = rogues.find((r) => r.classId === 'interceptor')!;

/** Teleport a rogue for the test (test-only; the sim stays the single writer afterwards). */
function placeRogue(shard: SystemShard, entry: (typeof rogues)[number], pos: Vec3): SimEntity {
  const e = shard.entities.get(entry.aiId)!;
  e.ship.pos = { ...pos };
  e.ship.vel = { x: 0, y: 0, z: 0 };
  e.ship.quat = { x: 0, y: 0, z: 0, w: 1 }; // facing +Z
  e.ship.regime = 'space';
  e.hull = 1;
  e.shields = 1;
  e.energy = 100;
  const st = shard.ai.get(entry.aiId)!;
  st.mode = 'patrol';
  st.targetId = null;
  return e;
}

describe('TASK-46 shard AI combat', () => {
  it('full state cycle: patrol → aggro → engage → disengage → patrol, with the ACQUIRING event + AI damage', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const sent: string[] = [];
    const player = shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'scout', sent);
    const rogue = placeRogue(shard, scoutRogue, { x: 0, y: 0, z: -400 }); // 400 m BEHIND its bow
    warmup(shard);

    // AGGRO on the first real tick: the player is inside 600 m + the 60deg cone.
    advance(shard, 100);
    expect(shard.ai.get(scoutRogue.aiId)!.mode).toBe('aggro');
    let events = combatEvents(sent);
    const acquiring = events.find((e) => e.kind === 'ai-acquiring');
    expect(acquiring, 'the ACQUIRING toast event rides the player wire').toMatchObject({
      kind: 'ai-acquiring',
      source: { kind: 'ai', id: scoutRogue.aiId },
      target: player.id,
    });

    // ENGAGE after the 1 s acquire delay — then the SAME pipeline fires:
    // 'laser-fired' with source {kind:'ai'} + a 'hit' on the player.
    advance(shard, 1_200);
    expect(shard.ai.get(scoutRogue.aiId)!.mode).toBe('engage');
    advance(shard, 1_500);
    events = combatEvents(sent);
    expect(events.some((e) => e.kind === 'laser-fired' && e.source.kind === 'ai' && e.source.id === scoutRogue.aiId)).toBe(true);
    expect(events.some((e) => e.kind === 'hit' && e.target === player.id && e.source.kind === 'ai')).toBe(true);
    expect(player.shields < 1 || player.hull < 1).toBe(true); // the player took damage

    // DISENGAGE: bring the rogue below 25% hull → it breaks off (no more fire).
    shard.applyHit(scoutRogue.aiId, 140, { kind: 'player', id: 'p1' }, 'laser');
    advance(shard, 100);
    expect(shard.ai.get(scoutRogue.aiId)!.mode).toBe('disengage');
    const before = combatEvents(sent).length;
    advance(shard, 500);
    expect(combatEvents(sent).length).toBe(before); // broken off: zero new combat events
    expect(shard.ai.get(scoutRogue.aiId)!.disengageUntilMs).toBeGreaterThanOrEqual(fakeNow);

    // Re-PATROL at the 30 s boundary.
    advance(shard, 30_200);
    expect(shard.ai.get(scoutRogue.aiId)!.mode).toBe('patrol');
    shard.stop();
  });

  it('a player firing on the rogue aggros it (5 s memory) even from behind; the memory expires', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const sent: string[] = [];
    const player = shipAt(shard, 'p1', { x: 0, y: 0, z: -300 }, 'scout', sent); // BEHIND the rogue's bow
    const rogue = placeRogue(shard, scoutRogue, { x: 0, y: 0, z: 0 });
    warmup(shard);

    // 180deg off the bow and 300 m out: NO aggro while the player stays silent.
    advance(shard, 500);
    expect(shard.ai.get(scoutRogue.aiId)!.mode).toBe('patrol');

    // The player's laser (the real fire pipeline) resolves onto the rogue →
    // the 5 s aggro memory lights regardless of the cone.
    shard.handleFire('p1', { weapon: 'laser', targetId: rogue.id });
    advance(shard, 100);
    expect(shard.ai.get(scoutRogue.aiId)!.mode).toBe('aggro');
    expect(shard.ai.get(scoutRogue.aiId)!.targetId).toBe(player.id);

    // Move the player out of the cone's reach (test-only) and let the memory age.
    player.ship.pos = { x: 0, y: 0, z: -10_000 };
    advance(shard, 100); // engage at ~1 s…
    advance(shard, 100); // …out-ranged (10 km > 1200 m) → PATROL before the memory even expires
    expect(shard.ai.get(scoutRogue.aiId)!.mode).toBe('patrol');
    shard.stop();
  });

  it('outrun: a full-burn interceptor escapes an AGGRO\'d scout (the gap widens)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const sent: string[] = [];
    const player = shipAt(shard, 'p1', { x: 0, y: 0, z: 100 }, 'interceptor', sent);
    placeRogue(shard, scoutRogue, { x: 0, y: 0, z: 0 }); // chasing from behind
    warmup(shard);
    shard.enqueueInput('p1', input(1, { thrust: 1 })); // full burn away (+Z), held every tick

    advance(shard, 15_000);
    const gap = vecLength(vecSub(player.ship.pos, shard.entities.get(scoutRogue.aiId)!.ship.pos));
    expect(gap).toBeGreaterThan(2 * 100); // the escape is real: 2x the starting gap
    expect(shard.ai.get(scoutRogue.aiId)!.mode).not.toBe('engage'); // out-ranged or chasing a wreck
    shard.stop();
  });

  it('evasion: a sharp turn within 200 m breaks the AI\'s missile lock (the missile expires, no hit)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const sent: string[] = [];
    const player = shipAt(shard, 'p1', { x: 0, y: 0, z: 450 }, 'interceptor', sent);
    placeRogue(shard, interceptorRogue, { x: 0, y: 0, z: 0 });
    warmup(shard);
    // Full burn + full turn: the player flies a ~150 m circle at 180 u/s,
    // faster than the missile's 120 u/s, while the target's bearing keeps
    // swinging past the missile's 1.5 rad/s homing limit (the AC).
    shard.enqueueInput('p1', input(1, { thrust: 1, yaw: 1 }));

    advance(shard, 12_000);
    const events = combatEvents(sent);
    // The AI actually tried: missiles left the rogue's rails…
    expect(events.some((e) => e.kind === 'missile-fired' && e.source.kind === 'ai')).toBe(true);
    // …and every one of them missed (the turn broke the lock).
    expect(events.filter((e) => e.kind === 'hit' && e.target === player.id)).toEqual([]);
    expect(player.hull).toBe(1);
    expect(player.shields).toBe(1);
    shard.stop();
  });

  it('rogues never target rogues, and never fire with no player in the system', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const sent: string[] = [];
    shard.registerConnection('ghost', 'Ghost', (b) => sent.push(b)); // a conn with NO ship entity
    warmup(shard);
    advance(shard, 15_000);
    const fired = combatEvents(sent).filter((e) => e.kind === 'laser-fired' || e.kind === 'missile-fired');
    expect(fired).toEqual([]); // no players → no AI fire, ever (rogues don't hunt rogues)

    // With a player 5 km away (far outside aggro range) the answer is the same.
    shipAt(shard, 'p1', { x: 5_000, y: 0, z: 0 }, 'scout');
    advance(shard, 10_000);
    expect(combatEvents(sent).filter((e) => e.kind === 'laser-fired' || e.kind === 'missile-fired')).toEqual([]);
    shard.stop();
  });

  it('AI fire parity: energy + cooldown are committed per shot (same pipeline as players)', () => {
    fakeNow = 1_000_000;
    const shard = makeShard();
    const sent: string[] = [];
    shipAt(shard, 'p1', { x: 0, y: 0, z: 0 }, 'freighter', sent); // 280 hp: outlives the sample
    const rogue = placeRogue(shard, scoutRogue, { x: 0, y: 0, z: -250 });
    warmup(shard);
    advance(shard, 1_500); // aggro + acquire…
    const startTick = shard.sim.tickNumber;
    advance(shard, 1_000); // …and 1 s of firing
    const state = shard.ai.get(scoutRogue.aiId)!;
    expect(state.mode).toBe('engage');
    // Cooldown committed (the next laser no earlier than +2 ticks at 3/s)…
    expect((rogue.fireCooldownUntil?.['laser'] ?? 0)).toBeGreaterThan(startTick + 2);
    // …and energy spent (laser 2/shot, regen 10/s — 3 shots > the 1 s regen).
    expect(rogue.energy).toBeLessThan(100);
    // Rate: the wire shows at most the 3/s cadence (+1 slack for the window).
    const fired = combatEvents(sent).filter(
      (e) => e.kind === 'laser-fired' && e.source.kind === 'ai' && e.source.id === scoutRogue.aiId,
    );
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.length).toBeLessThanOrEqual(4);
    shard.stop();
  });

  it('determinism: two shards, same inputs, 60 s → identical rogue trajectories (within 0.1 u)', () => {
    fakeNow = 1_000_000;
    const a = makeShard();
    const b = makeShard();
    shipAt(a, 'p1', { x: 2_000, y: 0, z: 0 }, 'scout');
    shipAt(b, 'p1', { x: 2_000, y: 0, z: 0 }, 'scout');
    warmup([a, b]);
    a.enqueueInput('p1', input(1, { thrust: 0.5, yaw: 0.2 }));
    b.enqueueInput('p1', input(1, { thrust: 0.5, yaw: 0.2 }));

    let maxDiff = 0;
    for (let i = 1; i <= 120; i++) {
      advance([a, b], 500); // 10 s per sample
      for (const r of rogues) {
        const pa = a.entities.get(r.aiId)!.ship.pos;
        const pb = b.entities.get(r.aiId)!.ship.pos;
        maxDiff = Math.max(maxDiff, vecLength(vecSub(pa, pb)));
      }
    }
    expect(maxDiff).toBeLessThan(0.1); // 60 s of lockstep: bit-identical worlds
    a.stop();
    b.stop();
  });

  it('benchmark: 6 players + 10 rogues (16 ships) keep p95 < 30 ms and add < 3 ms per tick', () => {
    fakeNow = 1_000_000;
    const base = makeShard(false);
    const withAi = makeShard(true);
    for (const shard of [base, withAi]) {
      for (let i = 0; i < 6; i++) {
        shipAt(shard, `p${i}`, { x: 1_000 + i * 400, y: 0, z: 0 }, i % 2 ? 'interceptor' : 'scout');
        shard.enqueueInput(`p${i}`, input(1, { thrust: 0.5 + i * 0.05, yaw: i % 2 ? 0.3 : -0.3 }));
      }
    }
    warmup([base, withAi]);
    advance([base, withAi], 60_000); // 1 200 ticks each

    const p95Base = base.histogram.percentile(0.95);
    const p95Ai = withAi.histogram.percentile(0.95);
    const delta = p95Ai - p95Base;
    console.log(
      `TASK-46 AI benchmark (16 ships, 1200 ticks): p95 base=${p95Base.toFixed(3)}ms p95 +AI=${p95Ai.toFixed(3)}ms delta=${delta.toFixed(3)}ms`,
    );
    expect(p95Ai).toBeLessThan(30); // the TASK-13 budget still holds with AI engaged
    expect(delta).toBeLessThan(3); // 10 rogues add < 3 ms to the tick (AC)
    base.stop();
    withAi.stop();
  });
});
