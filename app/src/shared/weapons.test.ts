import { describe, expect, it } from 'vitest';

import { vecLength, vecSub, type Vec3 } from './physics/vec';
import {
  ENERGY_MAX,
  ENERGY_REGEN_PER_S,
  LASER,
  MISSILE,
  canFire,
  hasWeapon,
  isWeaponId,
  loadoutFor,
  regenEnergy,
  spendEnergy,
  stepMissile,
  turnToward,
  WEAPON_BY_ID,
} from './weapons';

/**
 * TASK-43 step 1: the weapon defs, the per-class loadouts, the energy model
 * and the PURE missile flight math (straight target → converges inside the
 * ttl; an evading target → never converges, so the shard expires it).
 */

describe('weapon defs (v1 armory)', () => {
  it('LASER: 8 damage, 400 m range, 3/s, 2 energy', () => {
    expect(LASER).toMatchObject({
      id: 'laser',
      kind: 'laser',
      damage: 8,
      range: 400,
      fireRate: 3,
      energy: 2,
    });
  });

  it('MISSILE: 25 damage, 12/5 m splash, 800 m, 0.5/s, 10 energy, 120 u/s, 1.5 rad/s, 5 s ttl', () => {
    expect(MISSILE).toMatchObject({
      id: 'missile',
      kind: 'missile',
      damage: 25,
      splashDamage: 12,
      splashRadius: 5,
      range: 800,
      fireRate: 0.5,
      energy: 10,
      speed: 120,
      turnRate: 1.5,
      ttl: 5,
    });
  });

  it('WEAPON_BY_ID / isWeaponId cover exactly the v1 ids', () => {
    expect(WEAPON_BY_ID.laser).toBe(LASER);
    expect(WEAPON_BY_ID.missile).toBe(MISSILE);
    expect(isWeaponId('laser')).toBe(true);
    expect(isWeaponId('missile')).toBe(true);
    expect(isWeaponId('plasma')).toBe(false);
    expect(isWeaponId('')).toBe(false);
  });
});

describe('loadouts (from the ship catalog hardpoints)', () => {
  it('scout: laser only', () => {
    expect(loadoutFor('scout').map((w) => w.id)).toEqual(['laser']);
    expect(hasWeapon('scout', 'laser')).toBe(true);
    expect(hasWeapon('scout', 'missile')).toBe(false);
  });

  it('interceptor: laser AND missile', () => {
    expect(loadoutFor('interceptor').map((w) => w.id)).toEqual(['laser', 'missile']);
    expect(hasWeapon('interceptor', 'missile')).toBe(true);
  });

  it('freighter: laser only', () => {
    expect(loadoutFor('freighter').map((w) => w.id)).toEqual(['laser']);
    expect(hasWeapon('freighter', 'missile')).toBe(false);
  });

  it('unknown class: empty loadout', () => {
    expect(loadoutFor('glider')).toEqual([]);
    expect(hasWeapon('glider', 'laser')).toBe(false);
  });
});

describe('energy model (max 100, regen 10/s)', () => {
  it('regenEnergy adds regen·dt and clamps at ENERGY_MAX', () => {
    expect(ENERGY_MAX).toBe(100);
    expect(ENERGY_REGEN_PER_S).toBe(10);
    expect(regenEnergy(90, 1)).toBe(100);
    expect(regenEnergy(100, 10)).toBe(100);
    expect(regenEnergy(0, 0.5)).toBe(5);
  });

  it('canFire pays the weapon cost; denied fires never spend', () => {
    expect(canFire(100, LASER)).toBe(true);
    expect(canFire(2, LASER)).toBe(true);
    expect(canFire(1.999, LASER)).toBe(false);
    expect(canFire(10, MISSILE)).toBe(true);
    expect(canFire(9.999, MISSILE)).toBe(false);
  });

  it('spendEnergy deducts (never below zero)', () => {
    expect(spendEnergy(100, LASER)).toBe(98);
    expect(spendEnergy(100, MISSILE)).toBe(90);
    expect(spendEnergy(2, LASER)).toBe(0);
    expect(spendEnergy(1, LASER)).toBe(0); // the gate keeps this unreachable
  });
});

describe('turnToward (Rodrigues rotation, capped, magnitude pinned)', () => {
  it('keeps the current heading when already aligned', () => {
    const out = turnToward({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 5 }, 0.5, 10);
    expect(out).toEqual({ x: 0, y: 0, z: 10 });
  });

  it('rotates by at most maxAngle and pins the magnitude', () => {
    // vel +Z, target +X: a 90° turn is requested but capped at 30°.
    const out = turnToward({ x: 0, y: 0, z: 100 }, { x: 1, y: 0, z: 0 }, Math.PI / 6, 42);
    expect(vecLength(out)).toBeCloseTo(42, 9); // magnitude pinned
    // 30° off +Z toward +X: z = 42·cos(30°), x = 42·sin(30°)
    expect(out.z).toBeCloseTo(42 * Math.cos(Math.PI / 6), 6);
    expect(out.x).toBeCloseTo(42 * Math.sin(Math.PI / 6), 6);
  });

  it('takes the full angle when it is smaller than the cap', () => {
    const out = turnToward({ x: 0, y: 0, z: 100 }, { x: 1, y: 0, z: 0 }, Math.PI / 2, 100);
    expect(out.x).toBeCloseTo(100, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });

  it('a zero-distance target keeps the heading (no NaNs)', () => {
    const out = turnToward({ x: 3, y: 0, z: 4 }, { x: 0, y: 0, z: 0 }, 0.5, 5);
    expect(Number.isNaN(out.x)).toBe(false);
    expect(out).toEqual({ x: 3, y: 0, z: 4 });
  });

  it('a zero-velocity missile adopts the full step toward the target', () => {
    const out = turnToward({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.1, 120);
    expect(out).toEqual({ x: 120, y: 0, z: 0 });
  });
});

describe('stepMissile homing (constant speed, turn-rate capped)', () => {
  const DT = 0.05;
  const SPEED = MISSILE.speed!;
  const TURN = MISSILE.turnRate!;
  const TTL_STEPS = Math.round(MISSILE.ttl! / DT); // 100 steps = 5 s

  it('straight (stationary) target: converges to contact (< 5 m) inside the ttl', () => {
    // The shard detonates on the first step whose gap ≤ splashRadius — fly
    // the same loop and record the contact step (300 m at 120 u/s ≈ 2.5 s).
    const target: Vec3 = { x: 0, y: 0, z: 300 };
    let pos: Vec3 = { x: 0, y: 0, z: 0 };
    let vel: Vec3 = { x: 0, y: 0, z: SPEED };
    let contact = -1;
    for (let i = 0; i < TTL_STEPS; i++) {
      const s = stepMissile(pos, vel, target, DT, SPEED, TURN);
      pos = s.pos;
      vel = s.vel;
      if (vecLength(vecSub(target, pos)) < 5) {
        contact = i;
        break;
      }
    }
    expect(contact).toBeGreaterThan(-1);
    expect(contact * DT).toBeLessThan(MISSILE.ttl!); // well inside the 5 s ttl
  });

  it('a moving target that the missile can outrun on a straight is still hit', () => {
    // Target cruises away at 60 u/s (half missile speed): the missile
    // closes the initial 200 m gap in ≈ 4 s < the 5 s ttl.
    const speed = 60;
    let target: Vec3 = { x: 0, y: 0, z: 200 };
    let pos: Vec3 = { x: 0, y: 0, z: 0 };
    let vel: Vec3 = { x: 0, y: 0, z: SPEED };
    let gap = Infinity;
    let hitAtStep = -1;
    for (let i = 0; i < TTL_STEPS; i++) {
      const s = stepMissile(pos, vel, target, DT, SPEED, TURN);
      pos = s.pos;
      vel = s.vel;
      target = { x: 0, y: 0, z: target.z + speed * DT };
      gap = vecLength(vecSub(target, pos));
      if (gap < 5) {
        hitAtStep = i;
        break;
      }
    }
    expect(hitAtStep).toBeGreaterThan(-1);
    expect(hitAtStep * DT).toBeLessThan(MISSILE.ttl!);
  });

  it('evading target (turns faster than 1.5 rad/s + faster speed): never converges inside the ttl', () => {
    // The target circles its center at 3 rad/s (twice the missile cap) and
    // 240 u/s (double missile speed) — it can never be caught in 5 s.
    const center: Vec3 = { x: 0, y: 0, z: 300 };
    const radius = 100;
    const omega = 3;
    let target: Vec3 = { x: 0, y: 0, z: center.z - radius };
    let pos: Vec3 = { x: 0, y: 0, z: 0 };
    let vel: Vec3 = { x: 0, y: 0, z: SPEED };
    let closest = Infinity;
    for (let i = 0; i < TTL_STEPS; i++) {
      const t = (i + 1) * DT;
      target = {
        x: center.x + radius * Math.sin(omega * t),
        y: 0,
        z: center.z - radius * Math.cos(omega * t),
      };
      const s = stepMissile(pos, vel, target, DT, SPEED, TURN);
      pos = s.pos;
      vel = s.vel;
      closest = Math.min(closest, vecLength(vecSub(target, pos)));
    }
    expect(closest).toBeGreaterThan(5); // no contact — the shard will expire it
  });
});
