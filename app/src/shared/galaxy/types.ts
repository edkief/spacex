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
 * The full deterministic output of `generateSystem(seed, starId)`.
 *
 * This is what the star chart UI displays (planet count per system),
 * what the AI roster code consumes (placement), what the surface
 * generator downstream consumes (per-planet RNG), and what the
 * persistence layer records in `system_registry` (`id` and `name`).
 *
 * `star` is a *snapshot* of the input `Star`, not a reference — this
 * makes the type self-contained and serialisable without a join.
 */
export interface SystemGen {
  /** Stable 16-hex-char system id (hex of `hash2(seedFromString(seed), starId)`). */
  systemId: string;
  /** Display name (e.g. `Ilmamnya system` or `DR-042`). */
  name: string;
  /** Parent star snapshot — handy for the UI without re-deriving. */
  star: Star;
  /** Planet list, ordered by `orbitIndex` ascending (innermost first). */
  planets: readonly Planet[];
}

/**
 * Lightweight pointer that the galaxy chart uses to look up full
 * system data via the runtime registry. Equal to `SystemGen.starId`.
 */
export interface SystemSummary {
  /** Stable system id; equal to its parent star's `id`. */
  starId: string;
  /** Parent star snapshot — handy for the UI without re-deriving. */
  star: Star;
}

/**
 * A single planet orbiting a star.
 *
 * Filled in by TASK-4. The shape is the canonical contract between the
 * system generator, the eventual surface generator (TASK-5), the AI
 * roster code (TASK-45), and the UI (TASK-7). Once committed, treat the
 * field set as a stable wire type — TASK-71 will snapshot it.
 */
export interface Planet {
  /** Stable planet id (hex of (starId, orbitIndex)). */
  id: string;
  /** Display name, unique within the parent system. */
  name: string;
  /** Orbit slot index (0 = innermost). */
  orbitIndex: number;
  /** Planet class — drives radius range, atmosphere probability, landability. */
  class: PlanetClass;
  /** Equatorial radius in kilometres. Gas giants: 20_000..60_000; others: 2_000..8_000. */
  radiusKm: number;
  /** Whether the planet retains a meaningful atmosphere. */
  hasAtmosphere: boolean;
  /** Whether the player can land on the surface. Gas giants are never landable. */
  landable: boolean;
  /** Number of docks on the planet; 0 for non-landable, 1..3 for landable. */
  dockCount: number;
  /** Which resource *fields* exist on the planet (1..3 picks from the canonical resource list). */
  resourceTypes: readonly ResourceType[];
  /** Rogue-AI roster stationed at this planet (TASK-45 populates behaviour; here we just place counts). */
  aiRoster: AIRoster;
}

/** Allowed planet classes. Ordered roughly by density / formation order. */
export type PlanetClass = "rocky" | "terran" | "ocean" | "gas" | "ice";

/** Canonical list of planet classes in display order. */
export const PLANET_CLASSES: readonly PlanetClass[] = [
  "rocky",
  "terran",
  "ocean",
  "gas",
  "ice",
] as const;

/** Resource type strings — also the wire identifiers used by TASK-37+. */
export type ResourceType =
  "iron" | "copper" | "silicon" | "rare-earths" | "water" | "gas-compounds";

/** Canonical list of resource types (kept here so every consumer agrees). */
export const RESOURCE_TYPES: readonly ResourceType[] = [
  "iron",
  "copper",
  "silicon",
  "rare-earths",
  "water",
  "gas-compounds",
] as const;

/** Ship class ids. Must match TASK-19 ('scout'|'freighter'|'interceptor'). */
export type ShipClassId = "scout" | "freighter" | "interceptor";

/** Allowed ship class ids in display order. */
export const SHIP_CLASS_IDS: readonly ShipClassId[] = [
  "scout",
  "freighter",
  "interceptor",
] as const;

/** Distribution of rogue-AI ships per planet (TASK-45 turns the count into behaviour). */
export interface AIRoster {
  /** Number of AI ships (2..5). */
  count: number;
  /** Class ids of the ships; length === count. Stable per (seed, starId, orbitIndex). */
  classes: readonly ShipClassId[];
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
