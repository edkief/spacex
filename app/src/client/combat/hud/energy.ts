/**
 * Weapon / energy readout math — TASK-50.
 *
 * The readout is bottom-center, above the prompt line. Three rules
 * drive its appearance:
 *
 *   - **Energy bar** — 100 max. Amber below 25 %, red below 10 %,
 *     and a `LOW ENERGY` badge below 10 %.
 *   - **Weapon selector** — `1` / `2` slots, showing the loadout
 *     counts (`2x` for dual lasers, `4` for the missile bay).
 *   - **Missile count** — live rounds left on the selected weapon
 *     (missiles only; the laser is unlimited).
 *
 * Everything here is pure so the component test and the e2e both
 * assert the same numbers the renderer draws.
 */

import { ENERGY_MAX, LOADOUTS, type WeaponId } from "@shared/weapons.js";
import type { ShipClassId } from "@shared/ships.js";

/** Energy drops below this ratio → amber bar. */
export const ENERGY_AMBER_RATIO = 0.25;

/** Energy drops below this ratio → red bar + `LOW ENERGY`. */
export const ENERGY_LOW_RATIO = 0.1;

/** UI text for the warning badge. */
export const LOW_ENERGY_LABEL = "LOW ENERGY";

/** Severity band for the energy bar. */
export type EnergyLevel = "ok" | "amber" | "red";

/** Colour per severity band (kept in one place for the tests). */
export const ENERGY_COLORS: Readonly<Record<EnergyLevel, string>> = {
  ok: "#6ee7a8",
  amber: "#f5b94d",
  red: "#d04848",
};

/** Everything the readout needs to draw the energy row. */
export interface EnergyBarState {
  /** Raw energy value (already clamped to `[0, ENERGY_MAX]`). */
  readonly energy: number;
  /** Fraction of the reservoir, `[0, 1]`. */
  readonly ratio: number;
  /** Severity band derived from the ratio thresholds. */
  readonly level: EnergyLevel;
  /** CSS colour for the bar fill. */
  readonly color: string;
  /** True when the `LOW ENERGY` badge should render. */
  readonly lowEnergy: boolean;
}

/**
 * Derive the energy-bar presentation from a raw energy value.
 * Values above `ENERGY_MAX` clamp down; NaN reads as empty.
 */
export function energyBarState(energy: number, max: number = ENERGY_MAX): EnergyBarState {
  const safe = Number.isFinite(energy) ? Math.max(0, Math.min(max, energy)) : 0;
  const ratio = max > 0 ? safe / max : 0;
  const level: EnergyLevel =
    ratio < ENERGY_LOW_RATIO ? "red" : ratio < ENERGY_AMBER_RATIO ? "amber" : "ok";
  return { energy: safe, ratio, level, color: ENERGY_COLORS[level], lowEnergy: level === "red" };
}

/** A single `1` / `2` slot in the weapon selector. */
export interface WeaponSlot {
  /** Slot index (1-based; matches the `1` / `2` keybinds). */
  readonly key: 1 | 2;
  /** Weapon id the slot selects. */
  readonly weapon: WeaponId;
  /** Human label (`LASER` / `MISSILE`). */
  readonly label: string;
  /** Loadout count for that weapon (`2x` for dual lasers). */
  readonly countLabel: string;
  /** False when the ship class doesn't carry the weapon. */
  readonly available: boolean;
}

/** Human label for a weapon id (the spec's LASER / MISSILE). */
export function weaponLabel(weapon: WeaponId): string {
  return weapon === "laser" ? "LASER" : "MISSILE";
}

/**
 * Loadout count label. Dual hardpoints render as `2x`, the missile
 * bay as the raw count, and an unarmed class renders `0`.
 */
export function loadoutCountLabel(weapon: WeaponId, classId: ShipClassId | null): string {
  if (classId === null) return weapon === "laser" ? "1" : "0";
  const loadout = LOADOUTS[classId];
  const count = weapon === "laser" ? (loadout?.laser ?? 0) : (loadout?.missiles ?? 0);
  if (count <= 0) return "0";
  return weapon === "laser" && count > 1 ? `${count}x` : `${count}`;
}

/**
 * Build the two selector slots for a loadout. Slot `1` is always
 * the laser, slot `2` the missile (matches the `1` / `2` keybinds
 * wired in `App.tsx`).
 */
export function weaponSlots(classId: ShipClassId | null): readonly WeaponSlot[] {
  const weapons: readonly WeaponId[] = ["laser", "missile"];
  return weapons.map((weapon, i) => {
    const countLabel = loadoutCountLabel(weapon, classId);
    return {
      key: (i + 1) as 1 | 2,
      weapon,
      label: weaponLabel(weapon),
      countLabel,
      available: classId === null ? true : countLabel !== "0",
    };
  });
}

/**
 * Missile count readout for the selector. Returns `null` when the
 * active weapon isn't the missile (the spec only shows the count
 * for the missile weapon), otherwise the clamped round count.
 */
export function missileCountFor(activeWeapon: WeaponId, rounds: number | null): number | null {
  if (activeWeapon !== "missile") return null;
  if (rounds === null || !Number.isFinite(rounds)) return 0;
  return Math.max(0, Math.round(rounds));
}
