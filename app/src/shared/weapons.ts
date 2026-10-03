/**
 * Weapon contract (TASK-42) — the data-driven weapon descriptor the
 * server-side combat core validates hits against. TASK-43 supplies the
 * concrete v1 weapons (laser: instant ray, missile: homing entity); this
 * module fixes the shape so the resolver, the fire-intent messages and the
 * client HUD (TASK-50) all key off the same fields.
 *
 * Units: `damage` is ABSOLUTE points (the same space the shared damage
 * model in @shared/physics/damage works in — scout 100/50, freighter 200/80,
 * interceptor 80/40); `range` is METRES (a hit claimed beyond it is
 * rejected server-side: the client never decides whether a shot lands).
 */

export interface WeaponSpec {
  /** Stable wire id ('laser' / 'missile' in v1) — rides every combat event. */
  id: string;
  /** Damage in ABSOLUTE points (shield-first through the shared model). */
  damage: number;
  /** Max engagement range in METRES (firing entity → damage point). */
  range: number;
}
