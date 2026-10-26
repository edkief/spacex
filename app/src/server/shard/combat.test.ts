import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Shard } from './shard';
import { applyCombatDamage, cleanupExpiredWrecks, WRECK_TTL_S } from './combat';
import { ServerShipState } from './types';

describe('Combat Damage Model', () => {
  let shard: Shard;
  let shipId: string;
  let entity: ServerShipState;

  beforeEach(() => {
    shard = new Shard('cfd49a34bb6baf64', 'DRIFT-SEED-0001');
    shipId = 'ship-1';
    entity = {
      id: shipId,
      kind: 'ship',
      classId: 'scout',
      hull: 100,
      shields: 50,
      destroyed: false,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    shard.entities.set(shipId, entity);
  });

  it('shields absorb damage first', () => {
    applyCombatDamage(shard, shipId, 30, { kind: 'player', id: 'attacker' });
    expect(entity.shields).toBe(20);
    expect(entity.hull).toBe(100);
    expect(entity.destroyed).toBe(false);
  });

  it('damage overflows to hull when shields are depleted', () => {
    applyCombatDamage(shard, shipId, 60, { kind: 'player', id: 'attacker' });
    expect(entity.shields).toBe(0);
    expect(entity.hull).toBe(90);
    expect(entity.destroyed).toBe(false);
  });

  it('hull depletion marks entity as destroyed', () => {
    applyCombatDamage(shard, shipId, 160, { kind: 'player', id: 'attacker' });
    expect(entity.shields).toBe(0);
    expect(entity.hull).toBe(0);
    expect(entity.destroyed).toBe(true);
  });

  it('destroyed ships spawn a wreck', () => {
    applyCombatDamage(shard, shipId, 200, { kind: 'player', id: 'attacker' });

    const wrecks = Array.from(shard.entities.values()).filter((e) => e.kind === 'wreck');
    expect(wrecks).toHaveLength(1);
    expect(wrecks[0].wreckExpiresAt).toBeGreaterThan(Date.now());
  });

  it('destroyed ships ignore further damage', () => {
    applyCombatDamage(shard, shipId, 200, { kind: 'player', id: 'attacker' });
    const hullBefore = entity.hull;

    applyCombatDamage(shard, shipId, 10, { kind: 'player', id: 'attacker' });
    expect(entity.hull).toBe(hullBefore);
  });

  it('cleanupExpiredWrecks removes old wrecks', async () => {
    const wreckId = 'wreck-1';
    shard.entities.set(wreckId, {
      id: wreckId,
      kind: 'wreck',
      classId: 'scout',
      hull: 10,
      shields: 0,
      destroyed: false,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      wreckExpiresAt: Date.now() - 1000, // Expired
    });

    cleanupExpiredWrecks(shard);
    expect(shard.entities.has(wreckId)).toBe(false);
  });

  it('cleanupExpiredWrecks keeps recent wrecks', () => {
    const wreckId = 'wreck-1';
    shard.entities.set(wreckId, {
      id: wreckId,
      kind: 'wreck',
      classId: 'scout',
      hull: 10,
      shields: 0,
      destroyed: false,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      wreckExpiresAt: Date.now() + 1000, // Not expired
    });

    cleanupExpiredWrecks(shard);
    expect(shard.entities.has(wreckId)).toBe(true);
  });
});
