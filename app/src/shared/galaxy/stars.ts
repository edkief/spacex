/**
 * Star generator — produces the galaxy's star list from a seed.
 *
 * This is the keystone of the deterministic universe (PRD SC-2):
 * `generateStars(seed)` must return *bit-identical* output on every
 * client, every server, every test run. All randomness flows through
 * `Rng` from `../random.js`, so as long as that module is pure (TASK-2
 * guarantees it), determinism here is mechanical.
 *
 * Algorithm (per star at index `i`):
 *   1. `subSeed = hash2(masterSeed, BigInt(i))` — independent of all
 *      other stars. This is the star's stable identity, the seed for
 *      its `Rng`, and the source of its `id`.
 *   2. Pick a spectral class via `weightedClassPicked` (uses the
 *      master RNG so the *sequence* of classes is fixed even before
 *      the per-star sub-seeds kick in).
 *   3. Position: draw `(radius, theta)` and `z`. Radius is log-normal
 *      via the master RNG so the *galactic centre* density is high but
 *      a few stars get flung to the rim — that's what makes the chart
 *      look like a galaxy rather than a uniform disk. The exact
 *      `(x, y, z)` triple is rounded to a stable precision so two
 *      clients rendering with slightly different float math (some
 *      browsers use x87 for `Math.exp`) still produce identical strings.
 *   4. Name: `prefix + root + suffix` drawn from the seeded word lists.
 *      On collision with an earlier name, retry the suffix (then root,
 *      then prefix) until unique. The retry loop is bounded; if it
 *      ever exhausts, the test suite would scream (we test the
 *      no-collision property with 5 different seeds).
 *   5. `systemCount`: 2..8 drawn from the star's own sub-Rng, so it is
 *      stable across runs and not affected by class or position draws.
 *
 * @see ./config.ts for tunables and word lists.
 */

import { Rng, hash2, seedFromString } from "../random.js";
import {
  GALAXY_DISK_RADIUS_MAX,
  GALAXY_DISK_RADIUS_MEAN,
  GALAXY_DISK_RADIUS_SD,
  GALAXY_DISK_HEIGHT_SD,
  GALAXY_STAR_COUNT,
  NAME_PREFIXES,
  NAME_ROOTS,
  NAME_SUFFIXES,
  SPECTRAL_WEIGHTS,
  SYSTEM_COUNT_MAX,
  SYSTEM_COUNT_MIN,
} from "./config.js";
import { SPECTRAL_CLASSES, type SpectralClass, type Star } from "./types.js";

// ---------------------------------------------------------------------------
// Tunable precision for coordinates. Two floats that differ only in the
// last bit would yield different JSON strings and break the checksum,
// so we round to a fixed decimal precision that comfortably exceeds any
// plausible downstream consumer's tolerance but keeps cross-platform
// stability (we've seen JS engines differ at ULP ~2^-52 for Math.exp
// near the disk edge, so 6 decimals = 1e-6 gu ≈ 1e-3 pc is plenty).
// ---------------------------------------------------------------------------

const COORD_PRECISION = 6;
const ID_HEX_CHARS = 16; // 64 bits → 16 hex chars
/** Cap on name-collision retries to keep generation finite. */
const MAX_NAME_RETRIES = 64;

// ---------------------------------------------------------------------------
// Stable round helper (string-based to dodge float-to-string drift).
// ---------------------------------------------------------------------------

/**
 * Round `n` to `COORD_PRECISION` decimal places and return the result
 * as a Number (so the JSON serialiser still emits a sane float, not a
 * string). `toFixed` is locale-independent for the characters we use
 * ("0"–"9" and "-"), so this is safe across platforms.
 */
function roundCoord(n: number): number {
  return Number(n.toFixed(COORD_PRECISION));
}

/**
 * Render a BigInt as a fixed-width, lowercase hex string (zero-padded).
 * BigInt.prototype.toString(16) already uses lowercase hex and never
 * emits a sign for non-negative BigInts, so this is a one-liner — but
 * the wrapper documents the contract for the test suite.
 */
function bigintToHex(value: bigint, width = ID_HEX_CHARS): string {
  const hex = value.toString(16);
  return hex.length >= width ? hex : "0".repeat(width - hex.length) + hex;
}

// ---------------------------------------------------------------------------
// Weighted pick for spectral class (deterministic, no Math.random).
// ---------------------------------------------------------------------------

/**
 * Picks a spectral class by sampling `rng.nextF64()` once and walking
 * the cumulative weight table. Complexity is O(N) over 7 classes — a
 * precomputed alias table would be overkill for 200 stars.
 */
function pickSpectralClass(rng: Rng): SpectralClass {
  const u = rng.nextF64();
  let acc = 0;
  for (const cls of SPECTRAL_CLASSES) {
    acc += SPECTRAL_WEIGHTS[cls];
    if (u < acc) return cls;
  }
  // Floating-point tail (u very close to 1.0): the last class wins.
  return SPECTRAL_CLASSES[SPECTRAL_CLASSES.length - 1];
}

// ---------------------------------------------------------------------------
// Name generation with collision retry.
// ---------------------------------------------------------------------------

/**
 * Draws `prefix + root + suffix` from the word lists. Collisions with
 * an existing name cause a *bounded* retry that re-picks the suffix
 * (cheapest variation); if suffixes are exhausted, re-pick the root;
 * if roots are exhausted, re-pick the prefix. The deepest retry layer
 * never reaches the third one for a 200-star galaxy (chance < 1e-12),
 * but we still wire the fallback for correctness.
 *
 * Returns the assembled name. The caller owns the uniqueness check
 * because it owns the `Set<string>` of used names.
 */
function generateUniqueName(rng: Rng, used: Set<string>): { name: string; retried: number } {
  let prefix = rng.pick(NAME_PREFIXES);
  let root = rng.pick(NAME_ROOTS);
  let suffix = rng.pick(NAME_SUFFIXES);
  let candidate = prefix + root + suffix;
  let retries = 0;
  while (used.has(candidate)) {
    retries++;
    if (retries > MAX_NAME_RETRIES) {
      // Should never happen for 200 stars + 50×50×50 list space; if
      // it does, the test suite's uniqueness assertion will fire and
      // tell us to bump the lists.
      throw new Error(
        `star name collision retry budget exceeded (tried ${MAX_NAME_RETRIES} suffixes)`,
      );
    }
    // Suffix re-roll; if the suffix list happens to be small enough
    // that we cycle back, swap to a new root; in the extraordinarily
    // unlikely event of still colliding, swap prefix.
    if (retries % 3 === 1) suffix = rng.pick(NAME_SUFFIXES);
    else if (retries % 3 === 2) {
      root = rng.pick(NAME_ROOTS);
      suffix = rng.pick(NAME_SUFFIXES);
    } else {
      prefix = rng.pick(NAME_PREFIXES);
      root = rng.pick(NAME_ROOTS);
      suffix = rng.pick(NAME_SUFFIXES);
    }
    candidate = prefix + root + suffix;
  }
  return { name: candidate, retried: retries };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates the galaxy's star list deterministically from `seed`.
 *
 * @param seed  A human-readable seed (e.g. `"DRIFT-SEED-0001"`). Hashed
 *              via FNV-1a 64-bit to a master numeric seed; identical
 *              strings yield identical galaxies everywhere.
 * @param count How many stars to generate. Defaults to `GALAXY_STAR_COUNT`
 *              (200). The spec requires the default to be 200 — any other
 *              value changes the checksum and would only be used by tests
 *              (TASK-6 determinism fixture uses a smaller count).
 * @returns An array of `Star` of length `count`. Order is deterministic:
 *          star at index `i` is keyed by `hash2(masterSeed, BigInt(i))`,
 *          so callers can rely on the order being stable across runs.
 *          The order is *not* sorted by distance/class — render code
 *          sorts on the fly if it cares.
 */
export function generateStars(seed: string, count: number = GALAXY_STAR_COUNT): Star[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`generateStars: count must be a non-negative integer, got ${count}`);
  }
  if (count === 0) return [];

  const masterSeed = seedFromString(seed);
  const rng = new Rng(masterSeed);

  const stars: Star[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < count; i++) {
    // Per-star sub-seed. Independent of the master RNG's current state,
    // so a future code change that adds an extra `rng.next*()` call for
    // (say) the spectral class cannot leak into this star's id.
    const subSeed = hash2(masterSeed, BigInt(i));
    const subRng = new Rng(subSeed);

    const starClass = pickSpectralClass(rng);

    // Position: log-normal radius (so density falls off with r), uniform
    // angle, thin Gaussian z. Each star's polar coordinate is independent
    // of its sub-seed so a developer reading the code can reason about
    // the disk shape from the master RNG alone.
    const radiusRaw = Math.exp(rng.nextGauss(GALAXY_DISK_RADIUS_MEAN, GALAXY_DISK_RADIUS_SD));
    const radius = Math.min(radiusRaw, GALAXY_DISK_RADIUS_MAX);
    const theta = rng.nextRange(0, 2 * Math.PI);
    const z = rng.nextGauss(0, GALAXY_DISK_HEIGHT_SD);
    const x = roundCoord(radius * Math.cos(theta));
    const y = roundCoord(radius * Math.sin(theta));
    const zRounded = roundCoord(z);

    // Name uses the sub-Rng so renaming a star is independent of where
    // it sits on the disk — handy for tests that only want to assert
    // name uniqueness without position determinism.
    const { name } = generateUniqueName(subRng, usedNames);
    usedNames.add(name);

    // systemCount is purely a function of the sub-seed (and the
    // SYSTEM_COUNT_MIN/MAX constants); changing the constants breaks
    // the golden fixture, which is the correct outcome.
    const systemCount = SYSTEM_COUNT_MIN + subRng.nextInt(SYSTEM_COUNT_MAX - SYSTEM_COUNT_MIN + 1);

    stars.push({
      id: bigintToHex(subSeed),
      name,
      class: starClass,
      x,
      y,
      z: zRounded,
      systemCount,
    });
  }

  return stars;
}
