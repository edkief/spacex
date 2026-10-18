/**
 * Shared regime state machine — TASK-25.
 *
 * The regime manager owns the canonical answer to "which flight
 * regime is the ship in right now?". Every other layer (server
 * integration, client prediction, controls remap, persistence,
 * HUD) consumes the result. Putting the math in a single shared
 * module means client and server cannot disagree except by drift
 * — which the divergence detector (TASK-25 AC #4) catches after
 * 500 ms.
 *
 * ## The three regimes
 *
 *   - `'space'`       — above any atmosphere. Full 6-DOF-ish flight:
 *                       thrust / yaw / pitch / roll. No drag, no
 *                       surface collision. VTOL is ignored.
 *   - `'atmosphere'`  — inside the planet's atmosphere but above
 *                       the surface. Same controls as space plus
 *                       the VTOL key. Drag ramps linearly from
 *                       full (at the surface) to zero (at the
 *                       top of the boundary band).
 *   - `'surface'`     — landed. The ship is within `SURFACE_PROXIMITY_M`
 *                       of the planet's terrain AND descending
 *                       slowly enough to count as "stopped".
 *                       Above the surface the VTOL key lifts the
 *                       ship off; once vertical speed exceeds
 *                       `SURFACE_MAX_VERTICAL_SPEED` the regime
 *                       transitions back to `'atmosphere'`.
 *
 * ## Hysteresis (the anti-flap mechanism)
 *
 * Without hysteresis a ship idling at the boundary would flip
 * regimes every tick because the integrator rounds differently on
 * the way out and on the way back. The manager applies two
 * separate radii:
 *
 *   - `enter radius` = `planet.radius + planet.atmosphereHeight`
 *     (top of the atmosphere band).
 *   - `exit radius`  = `enter radius × HYSTERESIS_FACTOR`
 *     (`HYSTERESIS_FACTOR = 1.05` per spec → 5% wider band on
 *     the way out).
 *
 * Going `'space'` → `'atmosphere'` requires the ship to be
 * strictly inside the `enter radius`; going `'atmosphere'` →
 * `'space'` only fires once the ship is outside the `exit
 * radius`. Between the two radii the regime does not flip — the
 * ship can drift across the boundary without any visible
 * regime change.
 *
 * For `'surface'` the hysteresis is gated on vertical speed
 * instead of position: `'atmosphere'` → `'surface'` requires
 * `|vel.y| ≤ SURFACE_MAX_VERTICAL_SPEED`; `'surface'` →
 * `'atmosphere'` requires `|vel.y| > SURFACE_MAX_VERTICAL_SPEED`.
 * The position check uses the same `exit radius` so the band is
 * the same width on the way up as on the way down.
 *
 * ## Forbidden transitions
 *
 * The spec calls out "no direct space → surface transition".
 * Going from orbit straight to the ground would skip the drag
 * band and the controls remap; the result would feel like a
 * teleport. The state machine therefore routes every transition
 * through `'atmosphere'` first:
 *
 *   `'space'` → `'surface'`           — forbidden, snap to `'atmosphere'`.
 *   `'surface'` → `'space'`           — forbidden, snap to `'atmosphere'`.
 *   `'surface'` → `'atmosphere'`      — allowed only when
 *                                        `|vel.y| > SURFACE_MAX_VERTICAL_SPEED`.
 *   `'atmosphere'` → `'surface'`      — allowed only when ship
 *                                        is within `SURFACE_PROXIMITY_M`
 *                                        of the terrain AND
 *                                        `|vel.y| ≤ SURFACE_MAX_VERTICAL_SPEED`.
 *   `'space'` → `'atmosphere'`        — allowed when inside enter radius.
 *   `'atmosphere'` → `'space'`        — allowed when outside exit radius.
 *
 * ## Determinism
 *
 * The function is pure (no `Math.random`, no `Date.now`). Same
 * inputs (position, planet list, current regime, velocity)
 * always produce the same `{regime, planetId}` pair. This
 * matters because the server's authoritative regime must agree
 * with the client's predicted regime for at least 500 ms before
 * the divergence detector fires (TASK-25 AC #4).
 *
 * @see ./physics/atmosphere.ts for the drag / boundary math that
 *      uses the same radii.
 * @see ./physics/flight.ts for the integrator that takes the
 *      resolved regime as input.
 * @see ../../server/shard/sim.ts for the server tick that calls
 *      `regimeFor` before `integrateShip`.
 * @see ../../client/input/controls.ts for the controls remap that
 *      fires when `regime` changes.
 */

import {
  BOUNDARY_RAMP_WIDTH_M,
  DEFAULT_ATMOSPHERE_HEIGHT_M,
  type PlanetAtmosphere,
} from "./physics/atmosphere.js";
import type { Vec3 } from "./physics/vec.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The three flight regimes the state machine can produce. Wire-stable:
 * the string values are sent verbatim in `entity_update.regime`
 * (TASK-13). The protocol's `RegimeSchema` is a superset
 * (`'space' | 'orbit' | 'atmosphere' | 'surface'`); TASK-25 only ever
 * produces the three values here, never `'orbit'` — see `RegimeSchema`
 * for the rationale (clients older than TASK-25 may still observe an
 * `'orbit'` value from a pre-upgrade server).
 */
export type Regime = "space" | "atmosphere" | "surface";

/**
 * The minimal planet context the regime manager needs. Same shape
 * regardless of caller — the server builds one of these per planet
 * in the shard's `ShardSystemContext`, the client builds the same
 * from its cached `SystemGen` snapshot. The `heightAt(x, z)` callback
 * resolves a world-local (x, z) on the planet's surface to a
 * terrain altitude (metres above `radius`). Without terrain info we
 * cannot detect the `'atmosphere'` → `'surface'` transition (the
 * threshold is "within 2 m of the ground").
 *
 * The shape is intentionally a strict subset of `PlanetAtmosphere`
 * (see `@shared/physics/atmosphere`); a planet context always
 * satisfies `PlanetAtmosphere` and may be passed directly to
 * `integrateShip`.
 */
export interface RegimePlanetContext {
  /** Stable planet id (matches `Planet.id` from TASK-4). */
  readonly id: string;
  /** World position of the planet centre (game units ≈ metres). */
  readonly center: Vec3;
  /** Surface radius in game units (= `Planet.radiusKm × 1000`). */
  readonly radius: number;
  /** Total atmospheric thickness in metres above the surface. */
  readonly atmosphereHeight: number;
  /** Whether the planet retains an atmosphere at all. */
  readonly hasAtmosphere: boolean;
  /**
   * Terrain altitude (metres above `radius`) at the given world-local
   * `(x, z)`. Returns 0 for a flat test planet. Production wires
   * the deterministic heightmap from TASK-5.
   */
  readonly heightAt: (x: number, z: number) => number;
}

/**
 * The result of `regimeFor`. `planetId` is the id of the planet
 * whose atmosphere the ship is currently inside (or `'null'` when
 * in pure `'space'` mode). Consumers use the planetId to drive
 * `PlanetAtmosphere` lookups for the integrator and the VTOL
 * landing detection (TASK-29).
 */
export interface RegimeResolution {
  readonly regime: Regime;
  readonly planetId: string | null;
}

// ---------------------------------------------------------------------------
// Tunable constants — exported so tests can pin them and callers can
// reference them in their own documentation.
// ---------------------------------------------------------------------------

/**
 * Exit-radius multiplier: `exit radius = enter radius × HYSTERESIS_FACTOR`.
 *
 * The 5% band means a ship idling at the boundary has to travel 5% of
 * its atmosphere radius back the way it came before the regime flips.
 * For a 10 km atmosphere that's 500 m; for a thinner band (e.g. a
 * 50 m radius toy planet) it's only 2.5 m. Small but enough to absorb
 * one tick of integrator drift at 20 Hz × 100 u/s.
 */
export const HYSTERESIS_FACTOR = 1.05;

/**
 * Maximum descent speed (m/s) for a ship to count as "slow enough"
 * to transition `'atmosphere'` → `'surface'`. Matches the
 * `PAD_VERTICAL_SPEED_THRESHOLD` from `@shared/physics/flight` so a
 * ship that integrates with VTOL lift (which zero-clamps `vel.y` on
 * touchdown) is consistently detected as landing.
 */
export const SURFACE_MAX_VERTICAL_SPEED = 2;

/**
 * Proximity margin (metres) for the ship to be considered "at" the
 * surface. `'atmosphere'` → `'surface'` fires when the ship is within
 * `(planet.radius + terrain + SURFACE_PROXIMITY_M)` of the planet
 * centre. The 2 m buffer matches the spec's "below terrain height +
 * 2 u while slow" rule.
 */
export const SURFACE_PROXIMITY_M = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Distance from a world position to a planet centre.
 * (Squared for the hot path — callers can `sqrt` if they need it.)
 */
function distSq(pos: Vec3, center: Vec3): number {
  const dx = pos.x - center.x;
  const dy = pos.y - center.y;
  const dz = pos.z - center.z;
  return dx * dx + dy * dy + dz * dz;
}

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
void length; // retained for future use; not referenced by current logic.

/**
 * The `(enter radius, exit radius)` pair for a planet. Centralised
 * so every code path (test, server, client prediction) computes
 * exactly the same numbers from the same inputs.
 */
function atmosphereRadii(planet: RegimePlanetContext): { enter: number; exit: number } {
  const enter = planet.radius + planet.atmosphereHeight;
  const exit = enter * HYSTERESIS_FACTOR;
  return { enter, exit };
}

/**
 * Distance from a world position to the closest atmosphere-bearing
 * planet, along with that planet's id. Returns `{ dist: Infinity,
 * planetId: null }` if the list contains no atmosphere-bearing
 * planet — every ship in that case is unconditionally `'space'`.
 *
 * Squared distance is returned so the hot path can short-circuit
 * with a single compare; the caller only `sqrt`s when it needs
 * the actual number.
 */
function nearestAtmospherePlanet(
  pos: Vec3,
  planets: readonly RegimePlanetContext[],
): { planet: RegimePlanetContext; dist: number } | null {
  let best: { planet: RegimePlanetContext; dist: number } | null = null;
  for (const planet of planets) {
    if (!planet.hasAtmosphere) continue;
    const d = Math.sqrt(distSq(pos, planet.center));
    if (best === null || d < best.dist) {
      best = { planet, dist: d };
    }
  }
  return best;
}

/**
 * Distance from a world position to the closest planet's surface
 * (terrain-aware), again along with the planet id. Used for the
 * `'atmosphere'` → `'surface'` transition, which needs to know how
 * close the ship is to the ground at the (x, z) it is over right
 * now — not just to the planet centre.
 *
 * Returns `null` if no planet exists in the list (every ship stays
 * in space / atmosphere).
 */
function distanceToSurface(
  pos: Vec3,
  planets: readonly RegimePlanetContext[],
): { planet: RegimePlanetContext; distToSurface: number } | null {
  let best: { planet: RegimePlanetContext; distToSurface: number } | null = null;
  for (const planet of planets) {
    // Treat y == radius as the planet's local surface; with the
    // (x, z) — local to the planet — projected to the world origin
    // for heightAt, the surface altitude is `radius + heightAt(0,0)`
    // at the sub-point directly under the ship.
    const localX = pos.x - planet.center.x;
    const localZ = pos.z - planet.center.z;
    const terrain = planet.heightAt(localX, localZ);
    const surfaceY = planet.center.y + planet.radius + terrain;
    const distToSurface = pos.y - surfaceY;
    if (best === null || distToSurface < best.distToSurface) {
      best = { planet, distToSurface };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical regime for `pos` against the planet list.
 *
 * Algorithm (matches the transition table in the module header):
 *
 *   1. Find the nearest atmosphere-bearing planet. If none exists,
 *      the answer is unconditionally `'space'`.
 *   2. Compute `enter` (atmosphere top) and `exit` (5% wider) for
 *      that planet.
 *   3. If the ship is *inside* the enter radius → candidate
 *      `'atmosphere'`.
 *      If the ship is *outside* the exit radius → candidate
 *      `'space'`.
 *      Otherwise → candidate stays at `current` (hysteresis hold).
 *   4. Apply the surface check: if `current` or the candidate is
 *      `'surface'`, the surface transition rule applies
 *      (proximity + slow vertical speed).
 *   5. Snap any forbidden `'space'` ↔ `'surface'` direct transition
 *      through `'atmosphere'` first.
 *
 * @param pos        Ship world position (game units ≈ metres).
 * @param planets    Planets the regime manager considers. Order is
 *                   irrelevant; the nearest wins.
 * @param current    Currently-active regime. Optional; defaults to
 *                   `'space'`. Used to gate the hysteresis band and
 *                   the forbidden-transition snap.
 * @param velocity   Ship velocity (game units / s). Optional; only
 *                   consulted when the answer might be `'surface'`
 *                   (otherwise omitted).
 * @returns          `{ regime, planetId }`. `planetId` is `null` in
 *                   pure space and the nearest atmosphere planet's
 *                   id otherwise.
 */
export function regimeFor(
  pos: Vec3,
  planets: readonly RegimePlanetContext[],
  current: Regime = "space",
  velocity?: Vec3,
): RegimeResolution {
  const nearest = nearestAtmospherePlanet(pos, planets);
  if (nearest === null) {
    // No atmosphere-bearing planet anywhere → permanently space.
    return { regime: "space", planetId: null };
  }

  const { planet, dist } = nearest;
  const { enter, exit } = atmosphereRadii(planet);

  // Step 1: hysteresis-gated space/atmosphere candidate.
  let candidate: Regime;
  if (dist < enter) {
    candidate = "atmosphere";
  } else if (dist > exit) {
    candidate = "space";
  } else {
    // Inside the hysteresis band — hold the current regime.
    candidate = current === "surface" ? "atmosphere" : current;
  }

  // Step 2: surface detection. The "near surface" predicate fires when
  // the ship is over a planet (any planet, atmosphere-bearing or not)
  // AND within `SURFACE_PROXIMITY_M` of the terrain at the ship's
  // local (x, z) AND moving slowly enough to count as "stationary".
  //
  // "Lifted off" is the complementary predicate — the ship has moved
  // away from the surface OR is moving fast enough to count as "in
  // flight". Either condition transitions `surface → atmosphere`.
  const vy = velocity?.y ?? 0;
  const surfaceInfo = distanceToSurface(pos, planets);
  const nearSurface =
    surfaceInfo !== null &&
    Math.abs(surfaceInfo.distToSurface) <= SURFACE_PROXIMITY_M &&
    Math.abs(vy) <= SURFACE_MAX_VERTICAL_SPEED;
  const liftedOff =
    surfaceInfo !== null &&
    (Math.abs(surfaceInfo.distToSurface) > SURFACE_PROXIMITY_M ||
      Math.abs(vy) > SURFACE_MAX_VERTICAL_SPEED);

  // Step 3: apply transition rules.
  let regime: Regime = candidate;

  if (current === "surface") {
    if (nearSurface) {
      // Still right above the ground and slow — stay landed.
      regime = "surface";
    } else if (liftedOff) {
      // Lifted off (or drifted out of the proximity band) — promote
      // to atmosphere. We never go straight to space from surface
      // (forbidden transition); the hysteresis hold on the
      // atmosphere/space boundary kicks in on the next tick.
      regime = candidate === "space" ? "atmosphere" : candidate;
    } else {
      // No clear signal (e.g. surfaceInfo === null because the
      // planet list is empty). Hold the surface regime defensively
      // so we don't drop out of surface into a stale 'space' that
      // would later be flagged by the forbidden-transition guard.
      regime = "surface";
    }
  } else if (candidate === "atmosphere" && nearSurface) {
    // Coming in from above: the ship has descended to within
    // `SURFACE_PROXIMITY_M` of the terrain AND has slowed to
    // landing speed. Transition to surface.
    regime = "surface";
  }

  // Step 4: forbid direct space ↔ surface transitions. The state
  // machine never produces these — if the caller asked for one
  // (e.g. jumped `current` from `'space'` to `'surface'` by hand),
  // snap to `'atmosphere'` so the simulation stays continuous.
  if (current === "space" && regime === "surface") {
    regime = "atmosphere";
  } else if (current === "surface" && regime === "space") {
    regime = "atmosphere";
  }

  return {
    regime,
    planetId: regime === "space" ? null : planet.id,
  };
}

// ---------------------------------------------------------------------------
// Convenience builders
// ---------------------------------------------------------------------------

/**
 * Build a `RegimePlanetContext` from the shared `PlanetAtmosphere`
 * shape (used by `integrateShip`) plus a deterministic world
 * position. Centralised so the server and the client agree on the
 * planet centre for every `(systemId, planetId)` pair.
 *
 * The atmosphere height defaults to `DEFAULT_ATMOSPHERE_HEIGHT_M`
 * (10 km) — matches the server's `sim.ts` constant and is the
 * only height value the seed-driven galaxy generator currently
 * emits (TASK-4 doesn't pin per-planet heights, so the constant
 * is the universal default).
 *
 * @see ../../server/galaxy/system-data.ts for the position resolver.
 */
export function makeRegimePlanetContext(args: {
  id: string;
  center: Vec3;
  radius: number;
  hasAtmosphere: boolean;
  heightAt: (x: number, z: number) => number;
  atmosphereHeight?: number;
}): RegimePlanetContext {
  return {
    id: args.id,
    center: { x: args.center.x, y: args.center.y, z: args.center.z },
    radius: args.radius,
    hasAtmosphere: args.hasAtmosphere,
    heightAt: args.heightAt,
    atmosphereHeight: args.atmosphereHeight ?? DEFAULT_ATMOSPHERE_HEIGHT_M,
  };
}

/**
 * Drop-in adapter: turn a `PlanetAtmosphere` into a
 * `RegimePlanetContext`. The `PlanetAtmosphere` shape already has
 * every field `regimeFor` needs except `center` (the integrator
 * uses planet-local coords; the regime manager uses world coords),
 * so the caller still has to supply one. Use this when you have a
 * `PlanetAtmosphere` handy and don't want to retype the field
 * mapping.
 */
export function planetAtmosphereToRegimeContext(
  planet: PlanetAtmosphere,
  center: Vec3,
): RegimePlanetContext {
  return makeRegimePlanetContext({
    id: planet.id,
    center,
    radius: planet.radius,
    hasAtmosphere: planet.hasAtmosphere,
    heightAt: planet.heightAt,
    atmosphereHeight: planet.atmosphereHeight,
  });
}

/**
 * Re-export so downstream consumers don't have to reach into
 * `@shared/physics/atmosphere` for the boundary constant.
 */
export { BOUNDARY_RAMP_WIDTH_M };
