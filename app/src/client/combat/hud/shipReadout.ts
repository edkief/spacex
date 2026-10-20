/**
 * Ship-HUD readouts — TASK-51.
 *
 * Pure formatters for the speed / altitude / regime displays. The
 * regime comes from the server's authoritative state (TASK-25), so
 * every branch reads the **same** literal the renderer reads — a
 * single source of truth across the HUD and the unit suite.
 *
 * Conventions:
 *   - **Speed** in m/s with one decimal place (spec: "speed in m/s
 *     (1 decimal)").
 *   - **Altitude** in metres (integer) when on a planet; the literal
 *     em-dash when the ship is in space (spec: "ALT 1234 m in
 *     atmosphere/surface regimes; '—' in space").
 *   - **Regime tag** is the uppercase enum literal:
 *     `"SPACE" | "ATMOS" | "SURFACE"`. The wire-level regime
 *     `orbit` is collapsed to `SPACE` (a ship in the orbit band is
 *     spaceflight for the HUD's purposes — there is no altitude).
 *
 * The arrow vector in the speed bar is a 1-D thrust indicator;
 * positive throttle bar above the baseline, negative (reverse)
 * below. Always 1 unit high, — see `thrustArrowLength` below.
 */

import type { Vec3Like } from "../../camera/types.js";

/** The three regime labels the HUD surfaces. */
export type ShipHudRegime = "SPACE" | "ATMOS" | "SURFACE";

/**
 * Convert the wire-level `regime` to the HUD's three-letter tag.
 * The server's `orbit` band is treated as `SPACE` because the
 * altitude readout is meaningless there.
 *
 * Falls back to `SPACE` for unknown values so a malformed server
 * frame can never brick the HUD.
 */
export function regimeTagFor(regime: string | null | undefined): ShipHudRegime {
  switch (regime) {
    case "space":
    case "orbit":
      return "SPACE";
    case "atmosphere":
      return "ATMOS";
    case "surface":
      return "SURFACE";
    default:
      return "SPACE";
  }
}

/**
 * Format the speed readout. Always one decimal place in m/s. The
 * HUD spec is strict: 1 decimal, no unit abbreviation (the layout
 * shows "SPD 12.4" — the unit lives on a separate label).
 *
 * Negative speeds don't exist for the ship model but the formatter
 * is defensive: a NaN / non-finite input becomes `0.0` so the bar
 * never reads "NaN m/s".
 */
export function formatSpeed(metersPerSecond: number): string {
  if (!Number.isFinite(metersPerSecond)) return "0.0";
  if (metersPerSecond < 0) return "0.0";
  return metersPerSecond.toFixed(1);
}

/**
 * Format the altitude readout. Behaviour:
 *
 *   - **space / orbit** → `"—"` (spec: "altitude is meaningless
 *     there").
 *   - **atmosphere / surface** → `"ALT 1234 m"` (integer metres).
 *   - **unknown / null** → `"—"` so the HUD shows a placeholder
 *     instead of a stale value.
 *
 * The label is the spec's exact casing: `ALT ` with a trailing
 * space, integer metres, ` m` suffix.
 */
export function formatAltitude(
  regime: string | null | undefined,
  altitudeM: number | null | undefined,
): string {
  const tag = regimeTagFor(regime);
  if (tag === "SPACE") return "—";
  if (altitudeM === null || altitudeM === undefined || !Number.isFinite(altitudeM)) {
    return "ALT — m";
  }
  const metres = Math.max(0, Math.round(altitudeM));
  return `ALT ${metres} m`;
}

/**
 * Compute the ship-relative surface altitude (m) for the HUD.
 *
 * The server reports the planet's `radiusKm` (from the seeded
 * system) and the ship's `pos.y` is the world-space height above
 * the system origin. The relative altitude is `pos.y − radius` (in
 * metres) when `radiusKm` is known; `null` otherwise.
 *
 * `null` callers (e.g. spaceflight) read as the em-dash — the spec
 * gate on regime, not altitude.
 */
export function surfaceAltitudeM(
  pos: Vec3Like | null | undefined,
  planetRadiusM: number | null | undefined,
): number | null {
  if (pos === null || pos === undefined) return null;
  if (planetRadiusM === null || planetRadiusM === undefined) return null;
  if (!Number.isFinite(pos.y) || !Number.isFinite(planetRadiusM)) return null;
  const rel = pos.y - planetRadiusM;
  if (!Number.isFinite(rel)) return null;
  return Math.max(0, rel);
}

/**
 * Thrust indicator size — a 1-D bar centred on the speed readout.
 * `throttle` is clamped to `[-1, 1]`; the rendered length is
 * `(throttle / FULL_THROTTLE) * MAX_BAR_PX` capped at the same.
 *
 * Positive thrust renders above the baseline; reverse renders
 * below. The indicator is **always shown** so the HUD never
 * appears broken mid-flight — a `0` throttle becomes a tiny stub
 * at the centre.
 */
export const MAX_THROTTLE_BAR_PX = 60;
export const FULL_THROTTLE = 1;

export interface ThrustIndicator {
  /** Signed pixel offset above (+) or below (−) the baseline. */
  readonly offsetPx: number;
  /** Length of the rendered indicator in pixels (always ≥ 1). */
  readonly lengthPx: number;
}

/**
 * Project a normalised throttle value (`[-1, 1]`) onto the HUD's
 * 1-D bar geometry.
 *
 * Non-finite / out-of-range inputs collapse to a centred stub.
 */
export function thrustIndicatorFor(throttle: number | null | undefined): ThrustIndicator {
  if (throttle === null || throttle === undefined || !Number.isFinite(throttle)) {
    return { offsetPx: 0, lengthPx: 1 };
  }
  const clamped = throttle > 1 ? 1 : throttle < -1 ? -1 : throttle;
  const lengthPx = Math.max(1, Math.round(Math.abs(clamped) * MAX_THROTTLE_BAR_PX));
  const offsetPx = clamped >= 0 ? 0 : -lengthPx;
  return { offsetPx, lengthPx };
}
