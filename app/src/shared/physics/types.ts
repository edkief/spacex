/**
 * Shared physics types — used by `atmosphere.ts`, `flight.ts`, and
 * downstream consumers (TASK-28 visual boundary, TASK-29 pad
 * detection, TASK-13 server sim).
 *
 * Kept in its own file to avoid circular imports: `atmosphere.ts`
 * (boundary function, shared with TASK-28) needs to reference
 * `FlightPad` via the `PlanetAtmosphere.pads` field, while
 * `flight.ts` (the integrator) needs the same type for its
 * integration inputs. Putting the type in a leaf module lets both
 * consumers depend on it without a cycle.
 */

/**
 * A landing pad reachable from atmosphere / surface regimes. Sourced
 * from the deterministic placement pass (TASK-5) on the server and
 * cached on the client; see TASK-29 for the pad registry.
 *
 * `radius` is the **entry** radius — a non-docked ship within
 * `radius` metres of the pad centre AND on the ground AND slow
 * enough vertically will dock. `exitRadius` (≥ radius) is the
 * **hysteresis** radius — an already-docked ship can drift up to
 * `exitRadius` metres from the pad centre without un-docking, so
 * jitter at the boundary doesn't bounce the state.
 */
export interface FlightPad {
  /** Stable id (matches `LandingPad.id` from the surface chunk). */
  id: string;
  /** World-local x (metres). */
  x: number;
  /** World-local z (metres). */
  z: number;
  /** Pad top altitude (metres above planet radius). */
  height: number;
  /** Pad entry detection radius in metres (non-docked ship docks inside). */
  radius: number;
  /**
   * Pad exit hysteresis radius in metres (≥ `radius`). A docked ship
   * stays docked while within `exitRadius`; the integrator reads it
   * to avoid hysteresis flapping at the 20 m boundary.
   */
  exitRadius?: number;
}
