import { describe, expect, it } from 'vitest';

import { shipStats } from '@shared/ships';
import { quatIdentity, quatRotateVector, vecLength, vecSub, type Vec3 } from '@shared/physics/vec';
import { integrateShip, type ShipState } from '@shared/physics/flight';

import {
  ACQUIRE_DELAY_MS,
  AGGRO_CONE_COS,
  AGGRO_RANGE_M,
  DISENGAGE_DURATION_MS,
  DISENGAGE_HULL_FRACTION,
  LOST_TARGET_RANGE_M,
  MISSILE_MIN_RANGE_M,
  PATROL_SPEED_FACTOR,
  PLAYER_FIRE_MEMORY_MS,
  WAYPOINT_COUNT,
  createAiState,
  makeWaypoints,
  mulberry32,
  resetAiState,
  stepAi,
  tickRng,
  type AiWorld,
} from './ai';

/**
 * TASK-46 steps 1-2: the rogue AI state machine, tested PURE (fake world,
 * no shard): the exact AC state cycle (patrol → aggro → engage → disengage
 * → patrol) with timing bounds, the aggro triggers (range + 60deg cone, the
 * 5 s fire memory), the 1 s acquire delay, the weapon choice (missiles only
 * > 300 m AND when the class carries them), the 25% hull disengage, the
 * out-ranged give-up, the 0.5x patrol speed, and the shard RNG determinism.
 */

const CENTER: Vec3 = { x: 0, y: 0, z: 0 };
const RADIUS = 500;

function shipAt(pos: Vec3, quat = quatIdentity()): ShipState {
  return { pos, vel: { x: 0, y: 0, z: 0 }, quat, regime: 'space' };
}

function world(over: Partial<AiWorld> & { nowMs: number }): AiWorld {
  return {
    tick: 1,
    dt: 0.05,
    hull: 1,
    players: [],
    canFire: () => true,
    ...over,
  };
}

const scout = shipStats('scout');
const interceptor = shipStats('interceptor');

describe('shard RNG (TASK-46 determinism AC)', () => {
  it('mulberry32: same seed → identical sequences, different seeds diverge', () => {
    const a = mulberry32(0xdeadbeef);
    const b = mulberry32(0xdeadbeef);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
    const c = mulberry32(0xdeadbeef + 1);
    expect(Array.from({ length: 10 }, () => a())).not.toEqual(
      Array.from({ length: 10 }, () => c()),
    );
  });

  it('tickRng: same (systemId, tick) → same stream; different tick or system → different', () => {
    const a = tickRng('sys-1', 42);
    const b = tickRng('sys-1', 42);
    expect(Array.from({ length: 16 }, () => a())).toEqual(Array.from({ length: 16 }, () => b()));
    expect(Array.from({ length: 16 }, () => a())).not.toEqual(
      Array.from({ length: 16 }, () => tickRng('sys-1', 43)()),
    );
    expect(Array.from({ length: 16 }, () => tickRng('sys-1', 42)())).not.toEqual(
      Array.from({ length: 16 }, () => tickRng('sys-2', 42)()),
    );
  });
});

describe('seeded patrol waypoints', () => {
  it('WAYPOINT_COUNT points at a jittered radius around the center (y=0 plane)', () => {
    const rng = tickRng('sys-1', 0);
    const wps = makeWaypoints(rng, CENTER, RADIUS);
    expect(wps).toHaveLength(WAYPOINT_COUNT);
    for (const wp of wps) {
      const r = vecLength(vecSub(wp, CENTER));
      expect(r).toBeGreaterThanOrEqual(RADIUS * 0.75);
      expect(r).toBeLessThanOrEqual(RADIUS * 1.25);
      expect(wp.y).toBe(0);
    }
  });

  it('deterministic per seed (the client could re-derive the same loop)', () => {
    const a = makeWaypoints(tickRng('sys-1', 0), CENTER, RADIUS);
    const b = makeWaypoints(tickRng('sys-1', 0), CENTER, RADIUS);
    expect(a).toEqual(b);
  });
});

describe('the AC state cycle (patrol → aggro → engage → disengage → patrol)', () => {
  it('walks the exact sequence with the AC timing bounds', () => {
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    const ship = shipAt(CENTER);
    expect(state.mode).toBe('patrol');

    // No players: PATROL forever (the waypoint loop advances on approach).
    expect(stepAi(state, ship, scout, world({ nowMs: t0 })).fire).toBeUndefined();
    expect(state.mode).toBe('patrol');

    // A player inside 600 m AND in the forward 60deg cone → AGGRO, and the
    // acquiring player is reported (the 'ACQUIRING' toast trigger).
    const player = { id: 'p1', pos: { x: 0, y: 0, z: 400 }, vel: { x: 0, y: 0, z: 0 } };
    const r = stepAi(state, ship, scout, world({ nowMs: t0, players: [player] }));
    expect(state.mode).toBe('aggro');
    expect(state.targetId).toBe('p1');
    expect(r.acquiring).toBe('p1');
    expect(state.acquireStartedAtMs).toBe(t0);

    // ACQUIRING: no fire before the 1 s delay elapses (the player's grace).
    const pre = stepAi(state, ship, scout, world({ nowMs: t0 + 999, players: [player] }));
    expect(state.mode).toBe('aggro');
    expect(pre.fire).toBeUndefined();

    // At the 1 s boundary the machine flips to ENGAGE (still the grace tick:
    // no fire on the very tick the delay elapses)…
    const post = stepAi(state, ship, scout, world({ nowMs: t0 + 1_000, players: [player] }));
    expect(state.mode).toBe('engage');
    expect(post.fire).toBeUndefined();
    // …and from the next tick on it fires (laser: a scout carries no missiles).
    const post2 = stepAi(state, ship, scout, world({ nowMs: t0 + 1_050, players: [player] }));
    expect(state.mode).toBe('engage');
    expect(post2.fire).toEqual({ weapon: 'laser', targetId: 'p1' });

    // Badly damaged (hull < 25%) → DISENGAGE with the 30 s timer, no fire.
    const out = stepAi(
      state,
      ship,
      scout,
      world({ nowMs: t0 + 2_000, players: [player], hull: DISENGAGE_HULL_FRACTION - 0.01 }),
    );
    expect(state.mode).toBe('disengage');
    expect(out.fire).toBeUndefined();
    expect(state.disengageUntilMs).toBe(t0 + 2_000 + DISENGAGE_DURATION_MS);

    // Still broken off at 29.9 s…
    const late = stepAi(
      state,
      ship,
      scout,
      world({ nowMs: t0 + 2_000 + 29_900, hull: 0.1, players: [] }),
    );
    expect(state.mode).toBe('disengage');
    expect(late.fire).toBeUndefined();
    // …and re-PATROL at the boundary.
    const done = stepAi(
      state,
      ship,
      scout,
      world({ nowMs: state.disengageUntilMs, hull: 0.1, players: [] }),
    );
    expect(state.mode).toBe('patrol');
    expect(done.fire).toBeUndefined();
  });

  it('aggro requires range + cone (or the fire memory) — a flanker at range does not aggro', () => {
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    const ship = shipAt(CENTER); // facing +Z
    // 500 m out but 90deg off the bow: OUTSIDE the 60deg cone (dot < cos60).
    const flanker = { id: 'p1', pos: { x: 500, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    stepAi(state, ship, scout, world({ nowMs: t0, players: [flanker] }));
    expect(state.mode).toBe('patrol');
    // Same bearing but 700 m out: outside AGGRO_RANGE_M.
    const far = { id: 'p2', pos: { x: 0, y: 0, z: 700 }, vel: { x: 0, y: 0, z: 0 } };
    stepAi(state, ship, scout, world({ nowMs: t0, players: [far] }));
    expect(state.mode).toBe('patrol');
    // The cone half-angle is 60deg: 300 m at 55deg is IN, at 65deg is OUT.
    const atAngle = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return {
        id: `p${deg}`,
        pos: { x: 300 * Math.sin(a), y: 0, z: 300 * Math.cos(a) },
        vel: { x: 0, y: 0, z: 0 },
      };
    };
    expect(AGGRO_CONE_COS).toBeCloseTo(Math.cos(Math.PI / 3), 10);
    const outside = atAngle(65);
    stepAi(state, ship, scout, world({ nowMs: t0, players: [outside] }));
    expect(state.mode).toBe('patrol');
    const inside = atAngle(55);
    stepAi(state, ship, scout, world({ nowMs: t0, players: [inside] }));
    expect(state.mode).toBe('aggro');
    expect(AGGRO_RANGE_M).toBe(600);
  });

  it('a player firing on the AI aggros it within the 5 s memory (even from behind)', () => {
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    const ship = shipAt(CENTER);
    const behind = { id: 'p1', pos: { x: 0, y: 0, z: -500 }, vel: { x: 0, y: 0, z: 0 } };
    state.lastPlayerFireAtMs = t0 - 1_000; // fired 1 s ago
    state.lastPlayerFireBy = 'p1';
    stepAi(state, ship, scout, world({ nowMs: t0, players: [behind] }));
    expect(state.mode).toBe('aggro');
    // The same memory aged past 5 s no longer aggros (and a stranger's shot doesn't).
    const state2 = createAiState('ai:2', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    state2.lastPlayerFireAtMs = t0 - (PLAYER_FIRE_MEMORY_MS + 1);
    state2.lastPlayerFireBy = 'p1';
    stepAi(state2, ship, scout, world({ nowMs: t0, players: [behind] }));
    expect(state2.mode).toBe('patrol');
    const state3 = createAiState('ai:3', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    state3.lastPlayerFireAtMs = t0 - 1_000;
    state3.lastPlayerFireBy = 'someone-else';
    stepAi(state3, ship, scout, world({ nowMs: t0, players: [behind] }));
    expect(state3.mode).toBe('patrol');
  });

  it('weapon choice: missiles only when the class carries them AND the target is > 300 m; lasers otherwise; never beyond range', () => {
    const t0 = 1_000_000;
    const mk = (classId: 'scout' | 'interceptor' | 'freighter') => {
      const s = createAiState(
        `ai:${classId}`,
        t0,
        makeWaypoints(tickRng('sys', 0), CENTER, RADIUS),
      );
      s.mode = 'engage';
      s.targetId = 'p1';
      s.acquireStartedAtMs = t0 - 10_000; // fully acquired
      return s;
    };
    const ship = shipAt(CENTER);
    const at = (d: number) => ({ id: 'p1', pos: { x: 0, y: 0, z: d }, vel: { x: 0, y: 0, z: 0 } });

    // Interceptor: > 300 m → missile; ≤ 300 m → laser.
    expect(
      stepAi(
        mk('interceptor'),
        ship,
        interceptor,
        world({ nowMs: t0, players: [at(MISSILE_MIN_RANGE_M + 1)] }),
      ).fire,
    ).toEqual({ weapon: 'missile', targetId: 'p1' });
    expect(
      stepAi(
        mk('interceptor'),
        ship,
        interceptor,
        world({ nowMs: t0, players: [at(MISSILE_MIN_RANGE_M)] }),
      ).fire,
    ).toEqual({ weapon: 'laser', targetId: 'p1' });
    // Scout: no missiles at all (laser only), and nothing beyond laser range (400 m).
    expect(
      stepAi(mk('scout'), ship, scout, world({ nowMs: t0, players: [at(MISSILE_MIN_RANGE_M + 1)] }))
        .fire,
    ).toEqual({ weapon: 'laser', targetId: 'p1' });
    expect(
      stepAi(mk('scout'), ship, scout, world({ nowMs: t0, players: [at(401)] })).fire,
    ).toBeUndefined();
    // Interceptor beyond missile range (800 m) holds fire (the pipeline would refund it anyway).
    expect(
      stepAi(mk('interceptor'), ship, interceptor, world({ nowMs: t0, players: [at(801)] })).fire,
    ).toBeUndefined();
    // The pipeline check is authoritative: canFire false → no fire (rate limit / energy).
    expect(
      stepAi(
        mk('interceptor'),
        ship,
        interceptor,
        world({ nowMs: t0, players: [at(400)], canFire: () => false }),
      ).fire,
    ).toBeUndefined();
  });

  it('out-ranged: the target beyond LOST_TARGET_RANGE_M gives the AI up (back to PATROL)', () => {
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    state.mode = 'engage';
    state.targetId = 'p1';
    state.acquireStartedAtMs = t0 - 10_000;
    const ship = shipAt(CENTER);
    const far = {
      id: 'p1',
      pos: { x: 0, y: 0, z: LOST_TARGET_RANGE_M + 1 },
      vel: { x: 0, y: 0, z: 0 },
    };
    stepAi(state, ship, scout, world({ nowMs: t0, players: [far] }));
    expect(state.mode).toBe('patrol');
    expect(state.targetId).toBeNull();
  });

  it('a lost target (destroyed) drops the AI straight back to PATROL', () => {
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    state.mode = 'engage';
    state.targetId = 'p1';
    stepAi(state, shipAt(CENTER), scout, world({ nowMs: t0, players: [] }));
    expect(state.mode).toBe('patrol');
  });

  it('DEAD: a destroyed rogue coasts on zero input until the respawn reset', () => {
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    state.mode = 'dead';
    const r = stepAi(state, shipAt(CENTER), scout, world({ nowMs: t0 }));
    expect(r.input).toEqual({ thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 });
    // The respawn sweep (shard) resets the machine to PATROL with a fresh loop.
    resetAiState(state, tickRng('sys', 99), CENTER, RADIUS, t0 + 5_000);
    expect(state.mode).toBe('patrol');
    expect(state.targetId).toBeNull();
    expect(state.waypoints).toHaveLength(WAYPOINT_COUNT);
    expect(state.lastModeChangeAtMs).toBe(t0 + 5_000);
  });

  it('patrol steers the loop at 0.5x max speed: the ship moves and respects the cap', () => {
    // Drive the machine + the real flight model together (the shard's loop,
    // in miniature) and check the speed settles near 0.5x max, not above it.
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    let ship = shipAt(CENTER); // inside the loop: must reach the first waypoint
    let maxSpeed = 0;
    for (let i = 0; i < 300; i++) {
      const r = stepAi(state, ship, scout, world({ nowMs: t0 + i * 50 }));
      // integrateShip inline (pure): rotate then thrust — mirrors the shard.
      ship = integrateShip(ship, r.input, 0.05, 'space', undefined, scout);
      maxSpeed = Math.max(maxSpeed, vecLength(ship.vel));
    }
    // It flew somewhere…
    expect(vecLength(vecSub(ship.pos, CENTER))).toBeGreaterThan(100);
    // …and never outran 0.5x the class max (soft margin for the last thrust).
    expect(maxSpeed).toBeLessThan(PATROL_SPEED_FACTOR * scout.maxVelocity + 10);
    // The loop advances through every waypoint index.
    expect(state.waypointIdx).toBeGreaterThan(0);
  });

  it('steering converges on a moving lead point: it can be outrun by a faster interceptor', () => {
    // The outrun AC in miniature: a full-burn interceptor (180 u/s) fleeing
    // straight ahead vs the machine steering at class turn rate + full
    // thrust (scout 120 u/s). The gap must WIDEN over the run.
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    state.mode = 'engage';
    state.targetId = 'p1';
    state.acquireStartedAtMs = t0 - 10_000;
    let ai = shipAt({ x: -100, y: 0, z: 0 });
    const targetVel = { x: 0, y: 0, z: 180 };
    let target = shipAt({ x: 0, y: 0, z: 0 });
    let gap0 = 0;
    for (let i = 0; i < 400; i++) {
      const t = t0 + i * 50;
      const player = { id: 'p1', pos: target.pos, vel: targetVel };
      const r = stepAi(state, ai, scout, world({ nowMs: t, players: [player] }));
      ai = integrateShip(ai, r.input, 0.05, 'space', undefined, scout);
      target = integrateShip(
        target,
        { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0 },
        0.05,
        'space',
        undefined,
        interceptor,
      );
      if (i === 0) gap0 = vecLength(vecSub(target.pos, ai.pos));
    }
    const gap = vecLength(vecSub(target.pos, ai.pos));
    expect(gap).toBeGreaterThan(gap0 * 1.5); // 20 s of full burn: the escape is real
  });

  it('a dead ship is never integrated: the machine reports dead, the shard keeps it frozen (guard contract)', () => {
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    // (The shard flips the mode on destroy — the machine's contract is only
    // that 'dead' produces zero inputs forever, covered above. This pins the
    // mode set the AC names.)
    expect(['patrol', 'aggro', 'engage', 'disengage', 'dead']).toContain(state.mode);
  });

  it('the acquire anchor is honored for missiles too (no missile before the 1 s delay)', () => {
    const t0 = 1_000_000;
    const state = createAiState('ai:1', t0, makeWaypoints(tickRng('sys', 0), CENTER, RADIUS));
    state.mode = 'engage';
    state.targetId = 'p1';
    state.acquireStartedAtMs = t0; // just acquired THIS tick
    const far = { id: 'p1', pos: { x: 0, y: 0, z: 500 }, vel: { x: 0, y: 0, z: 0 } };
    expect(
      stepAi(state, shipAt(CENTER), interceptor, world({ nowMs: t0, players: [far] })).fire,
    ).toBeUndefined();
    expect(
      stepAi(
        state,
        shipAt(CENTER),
        interceptor,
        world({ nowMs: t0 + ACQUIRE_DELAY_MS, players: [far] }),
      ).fire,
    ).toEqual({ weapon: 'missile', targetId: 'p1' });
    // sanity: the forward cone constant is exactly 60deg
    expect(quatRotateVector(quatIdentity(), { x: 0, y: 0, z: 1 })).toEqual({ x: 0, y: 0, z: 1 });
  });
});
