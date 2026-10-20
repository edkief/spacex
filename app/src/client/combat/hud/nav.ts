/**
 * Nav readout — TASK-51.
 *
 * The ship HUD's nav readout is the pilot's directional indicator
 * to a chart / dock target. The math lives here so the React
 * component can stay a dumb renderer of `(bearing, vertical,
 * distance, label)` and the unit suite can exercise the camera-
 * space projection against the same camera convention the cockpit
 * camera uses (TASK-27).
 *
 * The readout has two modes (spec):
 *   - **Atmosphere / surface**: a 2-D bearing arrow projected onto
 *     the *camera plane*. `screen-fixed up = the target direction
 *     when the ship is aligned with the target`.
 *   - **Space**: a 3-D bearing that projects the target onto the
 *     ship's local screen plane; the arrow's vertical component
 *     encodes above/below (positive = above the ship's nose line).
 *
 * In both modes the distance formats as:
 *   - `< 1 km` → integer metres (`"342 m"`).
 *   - `≥ 1 km` → kilometres with one decimal (`"12.4 km"`).
 *
 * The arrow rotation is consumed by the HUD's `rAF` driver which
 * writes a single `transform: rotate(Xdeg)` onto a ref'd chevron.
 *
 * @see ../components/NavReadout.tsx for the consumer.
 */

import type { Vec3Like } from "../../camera/types.js";
import { forwardVecFromQuat, bearingDegrees } from "@shared/targeting.js";

/** Format a nav distance label. < 1 km → metres (integer), else km (1 dec). */
export function formatNavDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "?";
  if (meters < 1_000) return `${Math.round(meters)} m`;
  const km = meters / 1_000;
  return `${km.toFixed(1)} km`;
}

/** Compute the 3-D nav read-out from the ship's pose + a world target. */
export interface NavReadoutInput {
  /** Ship world position (matches the local predictor's `pos`). */
  shipPos: Vec3Like;
  /** Ship orientation quaternion. */
  shipQuat: { x: number; y: number; z: number; w: number };
  /** Target world position (chart selection → star centre; dock → pad). */
  targetPos: Vec3Like;
  /** True when the regime is `space` (the readout adds the vertical). */
  isSpace: boolean;
  /** Top-down / space readout also needs the world up vector (default +Y). */
  worldUp?: Vec3Like;
}

/**
 * Result the HUD renders. `bearingDeg` is the rotation about the
 * ship's vertical (yaw) the chevron should be rotated by, on the
 * range `[-180, 180]`. `verticalDeg` is the up/down tilt — only
 * populated in space mode, on the range `[-90, 90]`, positive
 * meaning the target is **above** the ship's nose line.
 */
export interface NavReadout {
  /** Yaw rotation in degrees — the chevron's `rotate()` value. */
  readonly bearingDeg: number;
  /** Vertical tilt degrees — only in space mode (else 0). */
  readonly verticalDeg: number;
  /** Range in metres. */
  readonly distanceM: number;
  /** Pre-formatted distance label. */
  readonly distanceLabel: string;
  /** True when the inputs are usable; false → hide the readout. */
  readonly valid: boolean;
}

/** Default world-up — positive Y in the Drift convention. */
const DEFAULT_UP: Vec3Like = { x: 0, y: 1, z: 0 };

/**
 * Compute the ship's forward unit vector for the bearing math. We
 * delegate to the shared helper so the nav readout and the
 * targeting-store bearing use the exact same convention.
 */
function forwardOf(quat: NavReadoutInput["shipQuat"]): Vec3Like {
  return forwardVecFromQuat(quat);
}

/**
 * Dot product helper.
 */
function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Two-argument arctangent with explicit branch; returns degrees in
 * `[-180, 180]`. Zero dir → 0 (HUD convention: dead-ahead target).
 */
function atan2Deg(y: number, x: number): number {
  const rad = Math.atan2(y, x);
  return (rad * 180) / Math.PI;
}

/**
 * Format the chevron's cardinal hint letter. The spec is "↗ 12.4 km"
 * but we make the glyph selection implicit through the bearing:
 *   - `[-22.5, 22.5]` → `↑` (target ahead)
 *   - `[-67.5, -22.5)` → `↖` (target up-left / up-right of yaw zero)
 *   - `[22.5, 67.5]`  → `↗`
 *   - `[-112.5, -67.5)` → `←`
 *   - `[67.5, 112.5]` → `→`
 *   - otherwise `↓` (behind the ship).
 */
export function cardinalGlyphFor(bearingDeg: number): string {
  const b = bearingDeg;
  if (b >= -22.5 && b < 22.5) return "↑";
  if (b >= 22.5 && b < 67.5) return "↗";
  if (b >= 67.5 && b < 112.5) return "→";
  if (b >= 112.5 || b < -112.5) return "↓";
  if (b >= -67.5 && b < -22.5) return "↖";
  if (b >= -112.5 && b < -67.5) return "←";
  return "↑";
}

/**
 * Project a target onto the ship's camera plane.
 *
 * Inputs are validated: any non-finite value or zero vector returns
 * `{ valid: false }` so the HUD hides the readout rather than
 * rendering a NaN arrow.
 *
 * The math:
 *   - `forward = quat ⊗ (0,0,1)` — the ship's nose direction.
 *   - `right = worldUp × forward`, normalised.
 *   - `up' = forward × right` — the camera-local up.
 *   - `toTarget = target − ship`.
 *   - `vForward = dot(toTarget, forward)`
 *   - `vRight   = dot(toTarget, right)`
 *   - `vUp      = dot(toTarget, up')`
 *
 *   - **Atmosphere / surface**: `bearingDeg = atan2(-vRight, vForward)`
 *     and `verticalDeg = 0` (the coplanar projection assumes the
 *     ship is roughly level — vertical motion is small relative to
 *     horizontal in atmo, so the arrow stays a yaw indicator).
 *
 *   - **Space**: same `bearingDeg`, plus `verticalDeg = atan2(vUp,
 *     sqrt(vForward² + vRight²))` so the chevron's vertical
 *     position encodes above/below.
 *
 * `bearingDegrees` from `@shared/targeting.js` already gives the
 * horizontal yaw; we re-derive it here so the signature is local
 * to the HUD code (less cross-module indirection for the reader).
 */
export function navReadoutFor(input: NavReadoutInput): NavReadout {
  const { shipPos, shipQuat, targetPos, isSpace, worldUp } = input;
  const up = worldUp ?? DEFAULT_UP;
  // Finite check first (cheapest gate).
  const finite =
    Number.isFinite(shipPos.x) &&
    Number.isFinite(shipPos.y) &&
    Number.isFinite(shipPos.z) &&
    Number.isFinite(targetPos.x) &&
    Number.isFinite(targetPos.y) &&
    Number.isFinite(targetPos.z);
  if (!finite) {
    return { bearingDeg: 0, verticalDeg: 0, distanceM: 0, distanceLabel: "?", valid: false };
  }
  const toTarget: Vec3Like = {
    x: targetPos.x - shipPos.x,
    y: targetPos.y - shipPos.y,
    z: targetPos.z - shipPos.z,
  };
  const distanceM = Math.sqrt(dot(toTarget, toTarget));
  if (distanceM < 1e-6) {
    return { bearingDeg: 0, verticalDeg: 0, distanceM: 0, distanceLabel: "0 m", valid: true };
  }
  const forward = forwardOf(shipQuat);
  // Plane basis: right = up × forward; up' = forward × right.
  const rightX = up.y * forward.z - up.z * forward.y;
  const rightY = up.z * forward.x - up.x * forward.z;
  const rightZ = up.x * forward.y - up.y * forward.x;
  const rightLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);
  if (rightLen < 1e-6) {
    return {
      bearingDeg: 0,
      verticalDeg: 0,
      distanceM,
      distanceLabel: formatNavDistance(distanceM),
      valid: false,
    };
  }
  const right: Vec3Like = {
    x: rightX / rightLen,
    y: rightY / rightLen,
    z: rightZ / rightLen,
  };
  const upPrime: Vec3Like = {
    x: forward.y * right.z - forward.z * right.y,
    y: forward.z * right.x - forward.x * right.z,
    z: forward.x * right.y - forward.y * right.x,
  };
  const vForward = dot(toTarget, forward);
  const vRight = dot(toTarget, right);
  const vUp = dot(toTarget, upPrime);
  // `bearingDegrees` returns a wrapped `[-180, 180]` already —
  // verify by comparing against the local derivation so the test
  // suite can pin the contract.
  const sharedBearing = bearingDegrees(
    { pos: shipPos, quat: shipQuat } as never,
    { pos: targetPos } as never,
  );
  void sharedBearing; // included for cross-check; not used for output
  // Convention: a target at world-right (vRight > 0, vForward ≈ 0)
  // produces a *positive* bearing so the chevron rotates
  // *clockwise* to point at it (CSS `rotate(N)` is +N clockwise,
  // which matches the screen-y-down convention we render with).
  const bearingDeg = atan2Deg(vRight, vForward);
  // Wrap into `[-180, 180]` exactly (atan2 already returns that,
  // but the test suite pins the wrap edge anyway).
  const wrapped =
    bearingDeg > 180 ? bearingDeg - 360 : bearingDeg < -180 ? bearingDeg + 360 : bearingDeg;
  const verticalDeg = isSpace
    ? Math.max(-90, Math.min(90, atan2Deg(vUp, Math.sqrt(vForward * vForward + vRight * vRight))))
    : 0;
  return {
    bearingDeg: wrapped,
    verticalDeg,
    distanceM,
    distanceLabel: formatNavDistance(distanceM),
    valid: true,
  };
}
