import { Shard } from './shard';
import { ServerShipState, DamageSource } from './types';
import { applyDamage } from '../../shared/physics/damage';

export const WRECK_TTL_S = 600;

/**
 * Applies combat damage to a target entity in a shard.
 * Handles shield/hull reduction, destruction, and wreck spawning.
 */
export function applyCombatDamage(
  shard: Shard,
  targetId: string,
  amount: number,
  source: DamageSource,
) {
  const entity = shard.entities.get(targetId);
  if (!entity || entity.kind === 'wreck' || entity.destroyed) return;

  const result = applyDamage(entity, amount, source);

  entity.shields -= result.shieldHit;
  entity.hull -= result.hullHit;

  if (result.destroyed) {
    entity.destroyed = true;

    // Broadcast destroyed event
    shard.broadcast('combat_event', {
      kind: 'destroyed',
      target: targetId,
      source: source,
    });

    // Spawn wreck
    const wreckId = `wreck_${targetId}_${Date.now()}`;
    shard.entities.set(wreckId, {
      ...entity,
      id: wreckId,
      kind: 'wreck',
      destroyed: false,
      wreckExpiresAt: Date.now() + WRECK_TTL_S * 1000,
    });
  } else {
    // Broadcast damaged event
    shard.broadcast('combat_event', {
      kind: 'damaged',
      target: targetId,
      source: source,
      amount,
      shieldHit: result.shieldHit,
      hullHit: result.hullHit,
    });
  }
}

/**
 * Removes wrecks that have exceeded their TTL.
 */
export function cleanupExpiredWrecks(shard: Shard) {
  const now = Date.now();
  for (const [id, entity] of shard.entities) {
    if (entity.kind === 'wreck' && entity.wreckExpiresAt && now > entity.wreckExpiresAt) {
      shard.entities.delete(id);
    }
  }
}
