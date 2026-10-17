/**
 * Shared galaxy/world types.
 *
 * These describe the *static, seed-derived* universe that every client and
 * the server agree on. Mutable runtime state (player ships, cargo, deposits,
 * node depletion timers, etc.) lives elsewhere — see TASK-63 (persistence
 * service) and TASK-24 (ship state). The split keeps the deterministic
 * galaxy geometry easy to reason about: if it is in here, every peer can
 * regenerate it from `GALAXY_SEED`.
 *
 * TASK-3 introduces `Star` (and the placeholder interfaces the spec asks
 * for so future tasks can extend them without breaking imports). Later
 * tasks will add to these definitions:
 *   - TASK-4: fills in `SystemSummary`, expands `Planet`.
 *   - TASK-5: expands `SurfaceChunk` and `LandingPad`.
 *   - TASK-45: adds AI roster per system.
 */

// ---------------------------------------------------------------------------
// Spectral classification
// ---------------------------------------------------------------------------

/**
 * The Harvard spectral classes used for star colour and rough mass/lifetime
 * proxies. We use the single-letter form (no decimal subclasses like
 * `B0V`) because all gameplay uses only the broad class — finer
 * distinctions would be wasted on a pixel-rendered point sprite.
 *
 * Mass / temperature / colour cheat-sheet for the game's UI:
 *   O — blue,   >30 000 K, very rare, very short-lived.
 *   B — blue-white, 10–30 k K, rare.
 *   A — white,   7.5–10 k K, young.
 *   F — yellow-white, 6–7.5 k K, sun-like neighbours.
 *   G — yellow,  5.2–6 k K, "sun-like" — home dock systems are G-class.
 *   K — orange,  3.7–5.2 k K, common, long-lived.
 *   M — red,    <3.7 k K, most common, very long-lived.
 */
export type SpectralClass = "O" | "B" | "A" | "F" | "G" | "K" | "M";

/** All spectral classes in canonical (hot → cold) order. */
export const SPECTRAL_CLASSES: readonly SpectralClass[] = [
  "O",
  "B",
  "A",
  "F",
  "G",
  "K",
  "M",
] as const;

// ---------------------------------------------------------------------------
// Star: the unit of TASK-3 and the key referenced everywhere downstream
// ---------------------------------------------------------------------------

/**
 * A single star in the galaxy.
 *
 * `id` is the stable key — it is the hex of the star's sub-seed and is
 * referenced by:
 *   - system generation (TASK-4): `SystemSummary.starId === Star.id`
 *   - the DB `system_registry` table (`system_id` column, TASK-62)
 *   - client routing keys (TASK-11 galaxy router)
 * It MUST be stable across runs and clients, hence the deterministic
 * derivation from the galaxy seed.
 *
 * `name` is unique within the galaxy; the generator guarantees uniqueness
 * by retrying the prefix/root/suffix combination until it lands on a name
 * no previous star has used. See `stars.ts` for the retry loop.
 *
 * Coordinates are in **galactic units** (1 gu = 1 kpc, by convention —
 * the unit is intentionally dimensionless in code; everything downstream
 * rescales to its own unit system). The distribution is a thin disk:
 *   - x, y are uniformly placed on a 2-D disk of log-normal radius
 *     (so most stars cluster near the centre, a few are flung to the rim).
 *   - z is a thin Gaussian (height << radius), producing the iconic
 *     spiral-arm-thin Milky-Way-like shape.
 */
export interface Star {
  /** Deterministic 16-hex-char id, stable across runs and clients. */
  id: string;
  /** Unique display name drawn from prefix+root+suffix word lists. */
  name: string;
  /** Spectral class (O/B/A/F/G/K/M). Drives colour and dock rarity. */
  class: SpectralClass;
  /** Galactic x in game units (≈ kpc). */
  x: number;
  /** Galactic y in game units. */
  y: number;
  /** Galactic z in game units — thin disk, |z| < radius/20 typical. */
  z: number;
  /** Number of star systems orbiting this star (2..8). */
  systemCount: number;
}

// ---------------------------------------------------------------------------
// Downstream placeholders (TASK-4 / TASK-5 extend these — kept minimal
// here so that the import graph is stable and TypeScript can resolve the
// shared types end-to-end before their generators exist).
// ---------------------------------------------------------------------------

/**
 * A star system orbiting a `Star`. The full definition (planets, AI
 * roster, faction ownership) is owned by TASK-4. We declare the field
 * shape here so `Star` and `SystemSummary` can reference each other
 * without a cyclic-import dance once TASK-4 lands.
 */
export interface SystemSummary {
  /** Stable system id; equal to its parent star's `id`. */
  starId: string;
  /** Parent star snapshot — handy for the UI without re-deriving. */
  star: Star;
}

/** A single planet. Placeholder; TASK-4 fills in the body. */
export interface Planet {
  /** Stable planet id (hex of star-id + orbit-index). */
  id: string;
  /** Display name, unique within the parent system. */
  name: string;
  /** Orbit slot index (0 = innermost). */
  orbitIndex: number;
}

/**
 * A surface chunk of a planet. Placeholder; TASK-5 owns the full schema
 * (terrain tiles, resource nodes, landing pads, biome). The interface
 * exists here so `Planet` can carry an optional list of chunks without
 * forward-reference gymnastics.
 */
export interface SurfaceChunk {
  /** Stable chunk id (hex of planet-id + chunk-index). */
  id: string;
  /** Chunk coordinates in the planet's local grid. */
  cx: number;
  cy: number;
}
