import type { ApplyDamageResult, DamageSource } from '@shared/physics/damage';
import { vecLength, vecSub, type Vec3 } from '@shared/physics/vec';
import type { WeaponSpec } from '@shared/weapons';
import type { SimEntity } from './types';

/**
 * Server-side combat resolver (TASK-42): the single hit pipeline for
 * lasers, missiles, AI, and PvP (friendly fire is ON in v1 — one pipeline
 * for everything, no team flags).
 *
 * `resolveHit` validates a weapon contact before damage lands:
 * - self-target — a ship cannot fire at itself ({code:'self-target'});
 * - dead target — destroyed entities and wrecks are not targetable (TASK-23);
 * - range — the damage point must be within the weapon's range of the
 *   FIRING entity (the client never decides whether a shot lands; a claimed
 *   hit beyond range is rejected — the anti-cheat contract of TASK-67);
 * - line of sight — in surface combat the source→damagePoint ray is
 *   raycast against the firing planet's terrain heightfield (a ship behind
 *   a mountain is not hit). Space regime SKIPS LOS entirely.
 *
 * A validated hit applies the TASK-23 damage pipeline (shields first,
 * overflow to hull) via the shard's applyHit and lets it broadcast the
 * combat events ('hit' / 'destroyed' / 'kill'). Hit registration is
 * server-side only: fire INTENTS are the inbound combat traffic
 * (TASK-43); a client's "I hit" claim has no inbound message.
 */

/** The shard surface resolveHit needs (SystemShard satisfies it structurally). */
export interface CombatShard {
  entities: Map<string, SimEntity>;
  applyHit(
    targetId: string,
    amount: number,
    source: DamageSource,
    weaponId: string,
  ): ApplyDamageResult | undefined;
  /** Terrain height (m) at (x, z) on a planet — the LOS raycast sampler. */
  terrainHeightAt(planetId: string, x: number, z: number): number;
}

/**
 * LOS subsamples (endpoints included). A deliberate cheap approximation:
 * the terrain's max slope is 45° (TASK-5) and v1 weapons stay ≤ 2 km, so
 * 5 samples catch any occluding ridge a ship can actually sit behind.
 */
export const LOS_SAMPLES = 5;

/**
 * Ray (from → to) vs a heightfield: subsampled at `samples` points
 * (endpoints included); occluded when ANY sample sits BELOW terrain
 * (a ship resting exactly on the surface can still fire).
 */
export function lineOfSight(
  from: Vec3,
  to: Vec3,
  heightAt: (x: number, z: number) => number,
  samples: number = LOS_SAMPLES,
): boolean {
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    if (y < heightAt(x, z)) return false;
  }
  return true;
}

export interface ResolveHitArgs {
  weapon: WeaponSpec;
  /** The firing entity's id (a ship, an AI ship). */
  sourceId: string;
  /** The intended target entity id. */
  targetId: string;
  /** Where the projectile claims to have landed (range + LOS reference). */
  damagePoint: Vec3;
}

export type ResolveHitCode =
  | 'self-target'
  | 'unknown-source'
  | 'unknown-target'
  | 'dead-target' /**
   * TASK-49: a DOCKED ship is a safe zone — weapons pass over it, it is never
   * a valid target (the dock is invulnerable in v1). A docked ship is only
   * one its player has left (disembark freezes it on the pad), so this is the
   * guard that "a ship destroyed while the player is on foot" cannot happen.
   */
  | 'docked'
  | 'out-of-range'
  | 'no-line-of-sight';

export type ResolveHitOutcome =
  | { ok: true; shieldHit: number; hullHit: number; destroyed: boolean }
  | { ok: false; code: ResolveHitCode };

/** Attribution: player-owned entities attribute to their player, else AI. */
function damageSourceFor(entity: SimEntity): DamageSource {
  return entity.playerId ? { kind: 'player', id: entity.playerId } : { kind: 'ai', id: entity.id };
}

/** Surface combat: LOS applies when either side is not in open space. */
function requiresLos(source: SimEntity, target: SimEntity): boolean {
  return source.ship.regime !== 'space' || target.ship.regime !== 'space';
}

/**
 * Validate and apply one weapon contact (see module docs). The damage
 * result (or rejection code) comes back synchronously; the combat events
 * are already broadcast by the shard's applyHit / destroy path.
 */
export function resolveHit(shard: CombatShard, args: ResolveHitArgs): ResolveHitOutcome {
  const { weapon, sourceId, targetId, damagePoint } = args;
  if (sourceId === targetId) return { ok: false, code: 'self-target' };
  const source = shard.entities.get(sourceId);
  if (!source) return { ok: false, code: 'unknown-source' };
  const target = shard.entities.get(targetId);
  if (!target) return { ok: false, code: 'unknown-target' };
  if (target.kind === 'wreck' || target.destroyed) return { ok: false, code: 'dead-target' };
  // TASK-49: a docked ship is a safe zone — weapons pass over it (LOS
  // "passes over"), no damage, no event. This single gate covers every
  // damage path (laser/missile/AI all funnel through resolveHit → applyHit).
  if (target.docked) return { ok: false, code: 'docked' };

  // Range: the damage point must be within the weapon's reach of the firer.
  if (vecLength(vecSub(damagePoint, source.ship.pos)) > weapon.range) {
    return { ok: false, code: 'out-of-range' };
  }

  // LOS (surface combat only — space has no terrain): sampled against the
  // FIRING entity's planet heightfield (pad disc flattened — the same
  // surface the flight model clamps to).
  if (requiresLos(source, target)) {
    const planetId = source.planetId;
    if (planetId) {
      const clear = lineOfSight(source.ship.pos, damagePoint, (x, z) =>
        shard.terrainHeightAt(planetId, x, z),
      );
      if (!clear) return { ok: false, code: 'no-line-of-sight' };
    }
  }

  const result = shard.applyHit(targetId, weapon.damage, damageSourceFor(source), weapon.id);
  if (!result) return { ok: false, code: 'dead-target' };
  return {
    ok: true,
    shieldHit: result.shieldHit,
    hullHit: result.hullHit,
    destroyed: result.destroyed,
  };
}
