export interface DamageSource {
  kind: 'player' | 'ai';
  id: string;
}

export interface Damageable {
  hull: number;
  shields: number;
}

export interface DamageResult {
  shieldHit: number;
  hullHit: number;
  destroyed: boolean;
}

/**
 * Calculates damage application to an entity.
 * Shields absorb damage first, then overflow to hull.
 * Hull <= 0 marks the entity as destroyed.
 *
 * This is a pure function and does not mutate the entity.
 */
export function applyDamage(
  entity: Damageable,
  amount: number,
  source: DamageSource,
): DamageResult {
  let remaining = amount;

  const shieldHit = Math.max(0, Math.min(entity.shields, remaining));
  remaining -= shieldHit;

  const hullHit = Math.max(0, Math.min(entity.hull, remaining));

  const destroyed = entity.hull - hullHit <= 0;

  return {
    shieldHit,
    hullHit,
    destroyed,
  };
}
