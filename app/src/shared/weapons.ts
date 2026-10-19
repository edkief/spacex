/**
 * Weapon catalog — TASK-43 keystone.
 *
 * The two v1 weapon systems:
 *
 *   - **Laser** (instant hit, infinite turn rate on the shot's own
 *     axis — no leading required): a ray from the ship's nose to
 *     the resolved impact point. Resolved by TASK-42's
 *     `resolveHit` at the first valid target inside `range`.
 *   - **Missile** (arcing homing): a moving projectile entity that
 *     turns toward the locked target each tick. On contact
 *     (range + 5 m splash) the warhead detonates and applies
 *     splash damage. If the target evades faster than the
 *     missile can track within the 5 s life, the missile
 *     expires without effect.
 *
 * Both weapons are server-authoritative. The client sends a
 * `fire` intent; the server re-derives rate, energy, range, LOS,
 * and target validity. A client claiming a hit gains nothing
 * (the protocol has no `i_hit` frame; the only "hit" event is
 * the server's `combat_event { kind: 'hit' }`).
 *
 * The module is intentionally pure-data + a couple of pure
 * helpers (`loadoutFor`, `weaponStats`, `cycleWeapon`) so the
 * catalog + loadout table can be re-imported by the server (for
 * rate / energy gating) and the client (for HUD readout) from
 * the same source.
 *
 * @see TASK-43 for the full acceptance criteria (weapons,
 *      per-class loadouts, rate / energy / lock).
 * @see ./ships.ts for the ship-class catalog this module reads.
 */

import type { ShipClassId } from "./ships.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All weapon ids the v1 spec recognises. */
export type WeaponId = "laser" | "missile";

/** All weapon ids in HUD iteration order. */
export const WEAPON_IDS: readonly WeaponId[] = ["laser", "missile"] as const;

/** Energy reservoir max HP. Regenerates at `ENERGY_REGEN_PER_SECOND`. */
export const ENERGY_MAX = 100;

/** Per-second energy regen (10/s → 100 max in 10 s of idle). */
export const ENERGY_REGEN_PER_SECOND = 10;

/**
 * Anti-spam gate (TASK-43 acceptance): a client that fires more
 * than this many shots in any 1-second window gets the weapon
 * lockout for `WEAPON_LOCK_DURATION_MS` and the lockout surfaces
 * to the wire as `{ code: 'weapon-locked' }`.
 */
export const WEAPON_LOCK_THRESHOLD_PER_SECOND = 30;

/** Lockout duration in milliseconds (5 s). */
export const WEAPON_LOCK_DURATION_MS = 5_000;

/** Missile life in seconds — evader expires within this window. */
export const MISSILE_TTL_S = 5;

/** Missile life expressed in milliseconds (sim tick granularity). */
export const MISSILE_TTL_MS = MISSILE_TTL_S * 1_000;

/** Maximum number of concurrent missiles per shard (entity budget). */
export const MAX_MISSILES_PER_SHARD = 16;

// ---------------------------------------------------------------------------
// Weapon stat shapes
// ---------------------------------------------------------------------------

/**
 * Per-shot stats for a single weapon.
 *
 * Each weapon carries:
 *   - `damage`   — base damage on a direct hit (overflowing the
 *                  shields and chipping the hull per TASK-23).
 *   - `splashDamage` — splash damage dealt to *other* entities
 *                  inside the splash radius (a direct hit takes
 *                  `damage`, others take `splashDamage`).
 *                  Only missiles have splash.
 *   - `splashRadius` — metres. Anything within this radius of
 *                  the impact point takes splash damage.
 *   - `range`    — maximum engagement range in metres. Beyond
 *                  this the weapon has no effect.
 *   - `rate`     — shots-per-second cap. The server enforces an
 *                  exact per-weapon cooldown (`1 / rate` seconds)
 *                  so a client claiming more rate gains nothing.
 *   - `energy`   — energy cost per shot. Deducted on accepted
 *                  fire only — denied fires (rate, energy, range,
 *                  LOS, weapon-locked) cost no energy.
 *   - `speed`    — projectile speed in u/s. Lasers are instant
 *                  (`Infinity` / a sentinel). Missiles use the
 *                  documented 120 u/s.
 *   - `turnRate` — homing turn rate in rad/s. Lasers don't turn
 *                  (`0`). Missiles use the documented 1.5 rad/s.
 */
export interface WeaponStats {
  readonly id: WeaponId;
  readonly displayName: string;
  readonly damage: number;
  readonly splashDamage: number;
  readonly splashRadius: number;
  readonly range: number;
  readonly rate: number;
  readonly energy: number;
  readonly speed: number;
  readonly turnRate: number;
}

// ---------------------------------------------------------------------------
// Data — the two v1 weapons
// ---------------------------------------------------------------------------

/**
 * Laser — instant-hit ray weapon (TASK-43 spec).
 *
 *   damage 8, range 400, rate 3/s (cooldown 333.33 ms),
 *   energy 2, speed Instant, turn 0.
 *
 * Damage math runs through `@shared/physics/damage#applyDamage`
 * (shield-first) — the laser number is the per-hit `amount`.
 * The single-mount scout / freighter fire one laser at a time
 * (rate-limited at 3/s); the interceptor's twin-linked mounts
 * (TASK-19) are abstracted as `weaponMounts.laser === 2` and
 * produce 2 × 8 = 16 damage per shot on accept (the spec calls
 * this out as "twin-linked for the interceptor — a single fire
 * key fires both simultaneously, doubling DPS").
 */
export const LASER_STATS: WeaponStats = {
  id: "laser",
  displayName: "Pulse Laser",
  damage: 8,
  splashDamage: 0,
  splashRadius: 0,
  range: 400,
  rate: 3,
  energy: 2,
  // Sentinel: instant hit (the resolver resolves at the first
  // entity inside `range`, no projectile integration required).
  speed: Number.POSITIVE_INFINITY,
  turnRate: 0,
};

/**
 * Missile — homing projectile weapon (TASK-43 spec).
 *
 *   damage 25, splash 12 (others in 5 m radius), radius 5,
 *   range 800, speed 120, turn 1.5 rad/s, rate 0.5/s
 *   (cooldown 2000 ms), energy 10.
 *
 * Friendly fire is ON (TASK-47 PvP parity); splash damages
 * both allies and hostiles equally. The interceptor carries
 * 4 missiles per loadout (TASK-19).
 */
export const MISSILE_STATS: WeaponStats = {
  id: "missile",
  displayName: "Guided Missile",
  damage: 25,
  splashDamage: 12,
  splashRadius: 5,
  range: 800,
  rate: 0.5,
  energy: 10,
  speed: 120,
  turnRate: 1.5,
};

/** Catalog keyed by weapon id. Insertion order matches `WEAPON_IDS`. */
export const WEAPON_STATS: Readonly<Record<WeaponId, WeaponStats>> = {
  laser: LASER_STATS,
  missile: MISSILE_STATS,
} as const;

// ---------------------------------------------------------------------------
// Loadouts
// ---------------------------------------------------------------------------

/**
 * A single weapon hardpoint.
 *
 * The interceptor has `laser: 2` — twin-linked, fired
 * simultaneously, dealing 2 × laser damage on accept.
 * `missile: 4` is the number of missiles the bay carries (an
 * interceptor has 4 missiles to spend before rearm).
 *
 * The scout and freighter have `laser: 1` and `missile: 0` —
 * no missile bays on those ships.
 */
export interface Loadout {
  /** Number of laser hardpoints: 1 or 2. */
  laser: 1 | 2;
  /** Number of missile bays: 0 or 4. */
  missiles: 0 | 4;
}

/**
 * Per-class loadout table (TASK-43 acceptance + TASK-19 numbers).
 *
 *   scout       → { laser: 1, missiles: 0 }
 *   freighter   → { laser: 1, missiles: 0 }
 *   interceptor → { laser: 2, missiles: 4 }
 */
const SCOUT_LOADOUT: Loadout = { laser: 1, missiles: 0 };
const FREIGHTER_LOADOUT: Loadout = { laser: 1, missiles: 0 };
const INTERCEPTOR_LOADOUT: Loadout = { laser: 2, missiles: 4 };

/** Full per-class loadout table. Keyed by `ShipClassId`. */
export const LOADOUTS: Readonly<Record<ShipClassId, Loadout>> = {
  scout: SCOUT_LOADOUT,
  freighter: FREIGHTER_LOADOUT,
  interceptor: INTERCEPTOR_LOADOUT,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a class's loadout. Throws on an unknown class id so
 * server-side callers fail loudly instead of silently using
 * `undefined`. The HUD also calls this for the weapon-availability
 * readout (TASK-50 will inherit the table).
 */
export function loadoutFor(classId: ShipClassId): Loadout {
  const entry = LOADOUTS[classId];
  if (!entry) {
    throw new Error(`loadoutFor: unknown ship class id "${classId}"`);
  }
  return entry;
}

/**
 * Look up weapon stats by id. Throws on an unknown id so the
 * server fire handler / client HUD both fail loudly.
 */
export function weaponStats(id: WeaponId): WeaponStats {
  const entry = WEAPON_STATS[id];
  if (!entry) {
    throw new Error(`weaponStats: unknown weapon id "${id}"`);
  }
  return entry;
}

/**
 * The per-weapon cooldown in milliseconds. `1 / rate` converted
 * to ms and rounded so the server's cooldown check matches the
 * spec exactly.
 *
 * For 3/s lasers: 333.33 ms → the resolver rounds down to 333 ms
 * (the fire rate test asserts `≥ 3 fires/s are rejected` — a
 * 333 ms floor is consistent with the spec's "fire rate 3/s"
 * reading).
 *
 * For 0.5/s missiles: 2000 ms.
 */
export function cooldownMs(id: WeaponId): number {
  const stats = weaponStats(id);
  // Floor so the cadence is `>= rate` rather than `>= rate + ε`.
  return Math.floor(1000 / stats.rate);
}

/**
 * Cycle to the next selectable weapon. v1 has two weapons so
 * this just flips between `laser` and `missile`. Used by the
 * `1`/`2` keybinds (TASK-43 spec: "weapon selection (1/2 keys)
 * switches active weapon").
 *
 * Returns the next weapon even when the current one isn't in the
 * loadout (e.g. a scout player typing `2` lands on `missile` —
 * the resulting fire is rejected by the server's loadout check).
 * Keeping the cycle unconditional makes the keystroke always
 * surface feedback ("missile not equipped").
 */
export function cycleWeapon(current: WeaponId, direction: "next" | "prev" = "next"): WeaponId {
  const idx = WEAPON_IDS.indexOf(current);
  const nextIdx =
    direction === "next"
      ? (idx + 1) % WEAPON_IDS.length
      : (idx - 1 + WEAPON_IDS.length) % WEAPON_IDS.length;
  return WEAPON_IDS[nextIdx] ?? "laser";
}

/**
 * Whether a class can fire a given weapon. The scout and
 * freighter have `missiles === 0` so they can't fire missiles;
 * every class can fire lasers (1 or 2 hardpoints).
 */
export function canFireWeapon(classId: ShipClassId, weapon: WeaponId): boolean {
  const loadout = loadoutFor(classId);
  if (weapon === "laser") return loadout.laser >= 1;
  if (weapon === "missile") return loadout.missiles >= 1;
  return false;
}