/**
 * Hover altitude-hold controller (TASK-106) — shared flight model.
 *
 * The PD controller behind the VTOL hover toggle: while a ship's input
 * carries `hover: 1`, `integrateShip` REPLACES the held-key VTOL lift with
 * this deterministic altitude-hold targeting {@link HOVER_ALT_M} above the
 * local terrain (the `heightAt` seam, re-sampled at every substep, so sloped
 * terrain is tracked).
 *
 * The controller is a NEW branch gated on `input.hover`: the held-key 'vtol'
 * path, the VTOL_LIFT / VTOL_HORIZONAL_LIMIT constants and the pad docking
 * logic all keep working exactly as before (the legacy gate stays with the
 * legacy path — hover is an explicit altitude-hold toggle, and its lift is
 * bounded by VTOL_LIFT anyway, so it is safe at any horizontal speed). Lift
 * is bounded by VTOL_LIFT (1.35·g), so a spammed 'hover' tag is harmless: the
 * server re-derives lift from authoritative state (no extra authority for
 * the client).
 *
 * ORDERING NOTE: the lift reads the PRE-gravity velocity of the substep and
 * is applied BEFORE the gravity add (the inverse of the legacy VTOL path).
 * Reading the post-gravity velocity would leak a dt·KD·g bias into the rest
 * point (at the server dt of 0.05 s the ship settles ~1.9 m ABOVE the target,
 * while a 60 fps client predictor would settle ~0.3 m above — a systematic
 * prediction/authority offset). Applied pre-gravity, the rest point is
 * exactly the target at every dt.
 *
 * Stability at dt = 0.05 s: the linearized closed loop (no drag) is
 * alt″ + KD·alt′ + KP·(alt−target) = 0 with roots −2 ± √2 (both real and
 * negative — overdamped, no oscillation); the discrete poles e^{λ·dt} ≈
 * {0.97, 0.84} are well inside the unit circle.
 */

/** Hover altitude (u) above the local terrain. */
export const HOVER_ALT_M = 10;
/** Proportional gain (1/s) on the altitude error above the target. */
export const HOVER_KP = 2;
/** Derivative gain (1/s) on the vertical velocity (up positive). */
export const HOVER_KD = 4;

/**
 * The hover lift for one substep (u/s²):
 * `lift = clamp(GRAVITY + KP·(target − alt) − KD·velY, 0, vtolLift)`.
 *
 * Pure: same (alt, velY, gravity, vtolLift) → same lift. GRAVITY is
 * cancelled exactly at the target with zero vertical velocity, so the target
 * is the rest point. `gravity`/`vtolLift` are passed in (not imported) to
 * keep this module free of a flight.ts dependency (no import cycle).
 */
export function hoverLift(alt: number, velY: number, gravity: number, vtolLift: number): number {
  const lift = gravity + HOVER_KP * (HOVER_ALT_M - alt) - HOVER_KD * velY;
  return lift < 0 ? 0 : lift > vtolLift ? vtolLift : lift;
}
