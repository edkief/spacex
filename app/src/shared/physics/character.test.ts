import { describe, expect, it } from 'vitest';

import {
  CHAR_GRAVITY,
  CHAR_JUMP_VELOCITY,
  CHAR_RUN_SPEED,
  CHAR_TERRAIN_LERP_SPEED,
  CHAR_TURN_RATE,
  CHAR_WALK_SPEED,
  characterSpawnPos,
  CHAR_SHIP_SIDE_OFFSET_M,
  integrateCharacter,
  restCharacterState,
  ZERO_CHARACTER_INPUT,
  type CharacterInput,
  type CharacterState,
} from './character';
import { quatFromEuler, quatIdentity, type Vec3 } from './vec';

/**
 * TASK-32: the shared character movement model. Pure: no DOM, no clock, no
 * Math.random — the same function the server sim and the client predictor
 * integrate, so both state streams stay in lock step.
 */

const SHIP_POS: Vec3 = { x: 100, y: 7.5, z: -40 };

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

const FLAT = () => 0;

/** Integrate `secs` of flat-ground physics at 20 Hz, returning the path. */
function simulate(
  secs: number,
  input: CharacterInput,
  dt = 0.05,
  heightAt: (x: number, z: number) => number = FLAT,
  initial: CharacterState = restCharacterState({ x: 0, y: 0, z: 0 }),
): CharacterState[] {
  const out: CharacterState[] = [];
  let s = initial;
  for (let t = 0; t < secs / dt; t++) {
    s = integrateCharacter(s, input, dt, heightAt);
    out.push(s);
  }
  return out;
}

describe('characterSpawnPos (TASK-31)', () => {
  it('identity quaternion: spawns 2.5 m along world +X, y pinned to the pad height', () => {
    // Ship resting AT the pad height: the spawn is a pure lateral shift.
    const pos = characterSpawnPos({ ...SHIP_POS, y: 5 }, quatIdentity(), 5);
    expect(pos.x).toBeCloseTo(SHIP_POS.x + CHAR_SHIP_SIDE_OFFSET_M, 6);
    expect(pos.y).toBe(5);
    expect(pos.z).toBeCloseTo(SHIP_POS.z, 6);
    expect(distance(pos, { ...SHIP_POS, y: 5 })).toBeCloseTo(CHAR_SHIP_SIDE_OFFSET_M, 6);
  });

  it('yawed ship: the offset rotates with the ship (perpendicular to forward)', () => {
    // 90° yaw (rotation about +Y): forward (+Z) turns to +X and the ship's
    // right axis (+X) turns to -Z — the spawn must sit EXACTLY perpendicular
    // to the new forward.
    const quat = quatFromEuler(Math.PI / 2, 0, 0);
    const atPad: Vec3 = { ...SHIP_POS, y: 0 };
    const pos = characterSpawnPos(atPad, quat, 0);
    expect(distance(pos, atPad)).toBeCloseTo(CHAR_SHIP_SIDE_OFFSET_M, 6);
    const dx = pos.x - atPad.x;
    const dz = pos.z - atPad.z;
    expect(dx).toBeCloseTo(0, 6); // no forward component (forward is now +X)
    expect(dz).toBeCloseTo(-CHAR_SHIP_SIDE_OFFSET_M, 6);
  });

  it('always lands on the pad plane (y = pad height) regardless of ship altitude', () => {
    const high = { ...SHIP_POS, y: 120 };
    const pos = characterSpawnPos(high, quatIdentity(), 3.25);
    expect(pos.y).toBe(3.25);
  });
});

describe('integrateCharacter: speeds (TASK-32 step 1)', () => {
  it('walk: 3 u/s along the facing, y pinned to the terrain', () => {
    const path = simulate(1, { ...ZERO_CHARACTER_INPUT, forward: true });
    const s = path[path.length - 1];
    expect(s.pos.z).toBeCloseTo(CHAR_WALK_SPEED, 6); // 3 m in 1 s along +Z
    expect(s.pos.x).toBe(0);
    expect(s.pos.y).toBe(0);
    expect(s.vel.z).toBeCloseTo(CHAR_WALK_SPEED, 6);
    expect(s.onGround).toBe(true);
  });

  it('run (shift): 6 u/s', () => {
    const path = simulate(1, { ...ZERO_CHARACTER_INPUT, forward: true, run: true });
    const s = path[path.length - 1];
    expect(s.pos.z).toBeCloseTo(CHAR_RUN_SPEED, 6);
    expect(s.vel.z).toBeCloseTo(CHAR_RUN_SPEED, 6);
  });

  it('back: walks along −facing', () => {
    const path = simulate(1, { ...ZERO_CHARACTER_INPUT, back: true });
    expect(path[path.length - 1].pos.z).toBeCloseTo(-CHAR_WALK_SPEED, 6);
  });

  it('no input: a moving character decelerates at 8 u/s² (ground friction)', () => {
    let s = restCharacterState({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < 10; i++)
      s = integrateCharacter(s, { ...ZERO_CHARACTER_INPUT, forward: true, run: true }, 0.05, FLAT);
    // Holding the key for 0.5 s → exactly run speed…
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeCloseTo(CHAR_RUN_SPEED, 6);
    // …then release: 6 − 8t, floored at 0.
    let t = 0;
    while (t < 1 && Math.hypot(s.vel.x, s.vel.z) > 1e-9) {
      s = integrateCharacter(s, ZERO_CHARACTER_INPUT, 0.05, FLAT);
      t += 0.05;
    }
    // 6 / 8 = 0.75 s to a full stop (± one tick of the floor transition).
    expect(t).toBeGreaterThan(0.7);
    expect(t).toBeLessThan(0.85);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeLessThan(1e-9);
    // Friction never reverses the direction of travel.
    expect(s.pos.z).toBeGreaterThan(0);
  });

  it('turning: right/left yaw the facing at CHAR_TURN_RATE (yaw-only quat)', () => {
    let s = restCharacterState({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) {
      s = integrateCharacter(s, { ...ZERO_CHARACTER_INPUT, right: true }, 0.05, FLAT);
    }
    // 1 s of right-turn = exactly CHAR_TURN_RATE radians about +Y.
    const expected = quatFromEuler(CHAR_TURN_RATE, 0, 0);
    expect(s.quat.x).toBeCloseTo(expected.x, 6);
    expect(s.quat.y).toBeCloseTo(expected.y, 6);
    expect(s.quat.z).toBeCloseTo(expected.z, 6); // yaw-only: no pitch/roll part
    expect(s.quat.w).toBeCloseTo(expected.w, 6);
    // Rotating +Z by yaw θ about Y gives (sin θ, 0, cos θ) — and the NEXT
    // forward step must follow the NEW facing.
    const fwdNow = { x: Math.sin(CHAR_TURN_RATE), y: 0, z: Math.cos(CHAR_TURN_RATE) };
    const s2 = integrateCharacter(s, { ...ZERO_CHARACTER_INPUT, forward: true }, 0.05, FLAT);
    expect(s2.pos.x).toBeCloseTo(fwdNow.x * CHAR_WALK_SPEED * 0.05, 5);
    expect(s2.pos.z).toBeCloseTo(fwdNow.z * CHAR_WALK_SPEED * 0.05, 5);
  });

  it('dt guards: zero/negative/NaN dt throw', () => {
    const s = restCharacterState({ x: 0, y: 0, z: 0 });
    expect(() => integrateCharacter(s, ZERO_CHARACTER_INPUT, 0, FLAT)).toThrow(/dt/);
    expect(() => integrateCharacter(s, ZERO_CHARACTER_INPUT, -1, FLAT)).toThrow(/dt/);
    expect(() => integrateCharacter(s, ZERO_CHARACTER_INPUT, Number.NaN, FLAT)).toThrow(/dt/);
  });
});

describe('integrateCharacter: jump (TASK-32 step 1)', () => {
  const JUMP: CharacterInput = { ...ZERO_CHARACTER_INPUT, jump: true };
  const WALK: CharacterInput = { ...ZERO_CHARACTER_INPUT, forward: true };

  it('jump arc: apex ≈ 1.04 m (v²/2g = 25/24 at v=5, g=12) and lands back on the ground', () => {
    const dt = 0.01; // fine frame dt: the discrete arc tracks the analytic one
    const s0 = restCharacterState({ x: 0, y: 0, z: 0 });
    // One jump tick (released immediately — holding it auto-rejumps on
    // landing, the documented v1 behavior), then no input.
    let s = integrateCharacter(s0, JUMP, dt, FLAT);
    let apex = s.pos.y;
    let landedAt = -1;
    for (let t = dt; t < 2; t += dt) {
      s = integrateCharacter(s, ZERO_CHARACTER_INPUT, dt, FLAT);
      apex = Math.max(apex, s.pos.y);
      if (landedAt < 0 && s.onGround && t > 0.1) landedAt = t;
    }
    expect(apex).toBeCloseTo(CHAR_JUMP_VELOCITY ** 2 / (2 * CHAR_GRAVITY), 1); // ≈ 1.0417
    // Airtime 2v/g ≈ 0.833 s (± the discrete step bias).
    expect(landedAt).toBeGreaterThan(0.7);
    expect(landedAt).toBeLessThan(0.95);
    // Silent landing: on the surface, no residual vertical velocity.
    expect(s.pos.y).toBeCloseTo(0, 9);
    expect(s.vel.y).toBe(0);
    expect(s.onGround).toBe(true);
  });

  it('no double jump: a jump input mid-air changes nothing (held key re-triggers only on landing)', () => {
    const dt = 0.05;
    const s0 = restCharacterState({ x: 0, y: 0, z: 0 });
    // Reference: a single impulse, then no input.
    let ref = integrateCharacter(s0, JUMP, dt, FLAT);
    // Adversarial: jump HELD the whole flight. While airborne the two runs
    // must be bit-identical (the second impulse never applies)…
    let adv = integrateCharacter(s0, JUMP, dt, FLAT);
    for (let i = 1; i <= 15; i++) {
      ref = integrateCharacter(ref, ZERO_CHARACTER_INPUT, dt, FLAT);
      adv = integrateCharacter(adv, JUMP, dt, FLAT);
      expect(adv.onGround).toBe(false); // still mid-flight this whole stretch
      expect(adv.pos).toEqual(ref.pos);
      expect(adv.vel).toEqual(ref.vel);
    }
    // …and after landing, the held key auto-rejumps (v1, documented):
    // both runs land on the same tick; the NEXT tick, the held jump
    // re-triggers for `adv` while `ref` (no input) stays on the ground.
    for (let i = 0; i < 10 && !ref.onGround; i++) {
      adv = integrateCharacter(adv, JUMP, dt, FLAT);
      ref = integrateCharacter(ref, ZERO_CHARACTER_INPUT, dt, FLAT);
    }
    expect(ref.onGround).toBe(true); // the flight is over
    adv = integrateCharacter(adv, JUMP, dt, FLAT); // the held key re-triggers
    ref = integrateCharacter(ref, ZERO_CHARACTER_INPUT, dt, FLAT);
    expect(ref.onGround).toBe(true);
    expect(ref.pos.y).toBeCloseTo(0, 9);
    expect(adv.onGround).toBe(false);
    expect(adv.vel.y).toBeCloseTo(CHAR_JUMP_VELOCITY, 6);
  });

  it('no air control: horizontal input is ignored while airborne', () => {
    const dt = 0.05;
    const s0 = restCharacterState({ x: 0, y: 0, z: 0 });
    const WALK_RUN_TURN: CharacterInput = { ...WALK, run: true, right: true };
    // One clean jump tick, then full forward + turn demand for the WHOLE
    // flight — all of it must be ignored until landing.
    let s = integrateCharacter(s0, JUMP, dt, FLAT);
    let airborneTicks = 0;
    while (!s.onGround && airborneTicks < 20) {
      s = integrateCharacter(s, WALK_RUN_TURN, dt, FLAT);
      airborneTicks++;
    }
    expect(s.pos.x).toBe(0);
    expect(s.pos.z).toBe(0); // straight up, straight down
    expect(s.quat).toEqual(quatIdentity()); // no mid-air turning either
    expect(s.vel.x).toBe(0);
    expect(s.vel.z).toBe(0); // the frozen ground velocity was zero
    expect(s.onGround).toBe(true); // the held input never moved it mid-air
    // And only NOW does the still-held input take effect on the ground.
    s = integrateCharacter(s, WALK_RUN_TURN, dt, FLAT);
    expect(Math.hypot(s.pos.x, s.pos.z)).toBeGreaterThan(0);
  });

  it('can jump off slopes: the impulse is vertical, terrain-relative', () => {
    const slope = (x: number) => x * Math.tan(Math.PI / 6); // 30°
    let s = restCharacterState({ x: 10, y: slope(10), z: 0 }, quatFromEuler(Math.PI / 2, 0, 0));
    s = integrateCharacter(s, ZERO_CHARACTER_INPUT, 0.05, (x) => slope(x)); // settle
    const s1 = integrateCharacter(s, JUMP, 0.05, (x) => slope(x));
    expect(s1.onGround).toBe(false);
    expect(s1.vel.y).toBeCloseTo(CHAR_JUMP_VELOCITY, 6);
  });
});

describe('integrateCharacter: terrain following (TASK-32 step 1)', () => {
  it('analytic 30° slope: y tracks the terrain within 0.1 m while walking up', () => {
    const slope = (x: number) => x * Math.tan(Math.PI / 6);
    const faceX = quatFromEuler(Math.PI / 2, 0, 0); // forward → +X
    const path = simulate(
      20,
      { ...ZERO_CHARACTER_INPUT, forward: true, run: true },
      0.05,
      (x) => (x > 0 ? slope(x) : 0),
      restCharacterState({ x: 0, y: 0, z: 0 }, faceX),
    );
    let maxGap = 0;
    for (const s of path) {
      maxGap = Math.max(maxGap, Math.abs(s.pos.y - slope(Math.max(0, s.pos.x))));
      expect(s.pos.y).toBeGreaterThanOrEqual(slope(Math.max(0, s.pos.x)) - 1e-6); // never below
    }
    expect(maxGap).toBeLessThan(0.1); // AC: tracks within 0.1 m
  });

  it('walks off a ledge and falls: projectile descent, lands on the lower surface', () => {
    const cliff = (x: number) => (x < 10 ? 5 : 0);
    const faceX = quatFromEuler(Math.PI / 2, 0, 0);
    let s = restCharacterState({ x: 9, y: 5, z: 0 }, faceX);
    let maxAirborne = false;
    for (let i = 0; i < 400 && !(s.onGround && s.pos.y < 0.01); i++) {
      s = integrateCharacter(s, { ...ZERO_CHARACTER_INPUT, forward: true, run: true }, 0.05, cliff);
      expect(s.pos.y).toBeGreaterThanOrEqual(cliff(s.pos.x) - 1e-6); // never in the ground
      if (!s.onGround) maxAirborne = true;
    }
    expect(maxAirborne).toBe(true); // it DID become airborne at the edge
    expect(s.onGround).toBe(true);
    expect(s.pos.y).toBeCloseTo(0, 6);
    expect(s.vel.y).toBe(0);
  });

  it('substeps: a large frame dt across a 45° edge kink never tunnels (cliff edge case)', () => {
    // Flat → 45° ramp at x = 10 (rising to y = 2 at x = 12): the seeded
    // terrain's steepest legal profile (TASK-5: max slope 45°).
    const kink = (x: number) => Math.max(0, Math.min(x - 10, 2));
    const faceX = quatFromEuler(Math.PI / 2, 0, 0);
    let s = restCharacterState({ x: 9, y: 0, z: 0 }, faceX);
    const dt = 0.25; // 6 u/s × 0.25 s = 1.5 m travel → 2 substeps per tick
    for (let i = 0; i < 30 && s.pos.x < 14; i++) {
      s = integrateCharacter(s, { ...ZERO_CHARACTER_INPUT, forward: true, run: true }, dt, kink);
      // Never below the surface, never floating above it by more than one
      // terrain-lerp step (the anti-tunnel / anti-teleport invariant).
      expect(s.pos.y).toBeGreaterThanOrEqual(kink(s.pos.x) - 1e-6);
      expect(s.pos.y).toBeLessThanOrEqual(kink(s.pos.x) + CHAR_TERRAIN_LERP_SPEED * dt);
    }
    expect(s.pos.x).toBeGreaterThan(13); // crossed the whole kink
    expect(s.pos.y).toBeCloseTo(kink(s.pos.x), 3); // resting on the ramp top
    expect(s.onGround).toBe(true);
  });
});

describe('integrateCharacter: determinism (TASK-32 step 1)', () => {
  it('same input sequence → same path (two runs, mixed inputs, 30 s)', () => {
    const dt = 0.05;
    const phases: Array<{ secs: number; input: CharacterInput }> = [
      { secs: 8, input: { ...ZERO_CHARACTER_INPUT, forward: true } },
      { secs: 5, input: { ...ZERO_CHARACTER_INPUT, forward: true, run: true } },
      { secs: 2, input: { ...ZERO_CHARACTER_INPUT, right: true } },
      { secs: 3, input: { ...ZERO_CHARACTER_INPUT, forward: true, jump: true } },
      { secs: 4, input: ZERO_CHARACTER_INPUT },
      { secs: 8, input: { ...ZERO_CHARACTER_INPUT, left: true, run: true } },
    ];
    const runOnce = (): Array<[number, number, number]> => {
      let s = restCharacterState({ x: 0, y: 0, z: 0 });
      const out: Array<[number, number, number]> = [];
      for (const p of phases) {
        for (let t = 0; t < p.secs / dt; t++) {
          s = integrateCharacter(s, p.input, dt, FLAT);
          if ((t + 1) % 20 === 0) out.push([s.pos.x, s.pos.y, s.pos.z]);
        }
      }
      return out;
    };
    const a = runOnce();
    const b = runOnce();
    expect(a).toEqual(b); // bit-identical paths
    expect(a.length).toBe(30); // 30 s / 1 s samples
  });
});
