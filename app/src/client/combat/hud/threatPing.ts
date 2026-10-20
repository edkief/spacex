/**
 * Threat-ping geometry — TASK-50.
 *
 * The threat ping is a **screen-edge** indicator (not a
 * world-anchored marker): a red arc pointing at the bearing of the
 * last attacker, fading over 3 s (`THREAT_PING_TTL_MS` from
 * `@shared/targeting`).
 *
 * The wedge is a DOM element painted with a `conic-gradient`; this
 * module owns the two numbers the renderer needs — the rotation
 * that aims the wedge and the opacity that fades it — so the
 * geometry is unit-testable without a browser.
 */

import { THREAT_PING_TTL_MS } from "@shared/targeting.js";

/** Arc width in degrees. Wide enough to read at a glance. */
export const THREAT_WEDGE_ARC_DEG = 42;

/** Peak opacity of the arc at age 0. */
export const THREAT_WEDGE_MAX_OPACITY = 0.95;

/** Presentation state for one threat ping. */
export interface ThreatWedgeState {
  /** CSS `rotate(<deg>deg)` angle for the wedge. */
  readonly rotationDeg: number;
  /** Linear fade opacity in `[0, 1]`. */
  readonly opacity: number;
  /** True when the ping is still within its TTL. */
  readonly live: boolean;
}

/**
 * Aim + fade a threat wedge.
 *
 * `bearing` follows the `@shared/targeting` convention (degrees
 * from the ship's nose; positive = right of forward). Screen
 * bearings run clockwise from "up" on a screen edge, so the wedge
 * rotation is `90 - bearing` — an attacker dead ahead (bearing 0)
 * lands at the top of the screen.
 *
 * `ageMs` is the wall-clock age of the ping; anything at or past
 * `THREAT_PING_TTL_MS` is dead (`opacity: 0`, `live: false`).
 */
export function threatWedgeState(
  bearing: number,
  ageMs: number,
  ttlMs: number = THREAT_PING_TTL_MS,
): ThreatWedgeState {
  const safeBearing = Number.isFinite(bearing) ? bearing : 0;
  const rotationDeg = 90 - safeBearing;
  const safeAge = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  const live = ttlMs > 0 && safeAge < ttlMs;
  if (!live) return { rotationDeg, opacity: 0, live: false };
  return {
    rotationDeg,
    opacity: THREAT_WEDGE_MAX_OPACITY * (1 - safeAge / ttlMs),
    live: true,
  };
}

/**
 * CSS `conic-gradient` body for the wedge. The arc is centred on
 * the gradient's origin angle (0 %) so a pure `rotate()` aims it.
 *
 * @param arcDeg  — total arc width in degrees.
 * @param color   — CSS colour of the arc.
 * @param opacity — peak opacity for the arc (0 hides it).
 */
export function threatWedgeGradient(
  arcDeg: number = THREAT_WEDGE_ARC_DEG,
  color = "#ff3b30",
  opacity: number = THREAT_WEDGE_MAX_OPACITY,
): string {
  const half = Math.max(0, arcDeg) / 2;
  const peak = Math.max(0, Math.min(1, opacity));
  const rgb = `${color === "#ff3b30" ? "255,59,48" : color}`;
  const solid = `rgba(${rgb},${peak.toFixed(3)})`;
  const clear = `rgba(${rgb},0)`;
  return (
    `conic-gradient(from ${-half}deg, ` +
    `${clear} 0deg, ` +
    `${solid} ${half * 0.55}deg, ` +
    `${solid} ${half}deg, ` +
    `${clear} ${half * 2}deg)`
  );
}
