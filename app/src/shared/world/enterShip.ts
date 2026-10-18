/**
 * Re-entry tuning constants — TASK-35.
 *
 * The two numerical tunables the spec calls out, both exported so
 * the server validator, the client prompt, and the e2e tests share
 * a single source of truth:
 *
 *   - `ENTER_SHIP_RANGE_M = 5` — server-side prompt radius. The
 *     client's visual prompt uses the existing 3 m × 30° forward
 *     cone (TASK-33) for ergonomics; the wire validator enforces
 *     5 m regardless of cone because the spec calls for "within
 *     5 m of its hull" — the cone-raycast might fail to find a
 *     target on the back side of the ship, but the player should
 *     still be able to board from any approach within 5 m.
 *   - `ENTER_SHIP_MAX_VELOCITY_U_S = 1` — server-side velocity
 *     check. A ship moving faster than 1 u/s cannot be re-entered
 *     because the player would immediately integrate a moving
 *     aircraft. A drifting/idle ship (< 1 u/s on the magnitude
 *     metric used in `integrateShip`) can be claimed.
 *
 * The constants live in `src/shared` so both halves of the wire
 * agree and so a future task (TASK-36 multiplayer on-foot) can
 * reuse them for "boarding an ally's parked ship" or similar flows.
 */

/**
 * Max distance (m) between the character and the ship's hull that
 * the server accepts an `enter_ship` frame from. The pick-up
 * radius for the visual prompt is the existing 3 m × 30° forward
 * cone (TASK-33); this 5 m is the *server-side* validation
 * threshold — wider on purpose so the player can board from any
 * direction around the hull, not just within the camera cone.
 */
export const ENTER_SHIP_RANGE_M = 5;

/**
 * Squared copy of the above — exported so the hot loop on the
 * server doesn't pay the `sqrt` cost per check.
 */
export const ENTER_SHIP_RANGE_SQ_M = ENTER_SHIP_RANGE_M * ENTER_SHIP_RANGE_M;

/**
 * Max ship velocity (u/s) that the server accepts an `enter_ship`
 * frame from. The check is on the magnitude of the velocity
 * vector: |vel| < 1 m/s. A drifting ship (vel = 0, settled on a
 * pad or in deep space) can be re-claimed; a moving one cannot
 * (the spec's "drifting ship can be re-claimed, moving cannot"
 * rule).
 */
export const ENTER_SHIP_MAX_VELOCITY_U_S = 1;
