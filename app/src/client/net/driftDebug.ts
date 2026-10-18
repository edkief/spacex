/**
 * TASK-71 — dev-only debug seam (`window.__DRIFT__`).
 *
 * The TASK-71 two-client e2e needs a deterministic, *imperative* way
 * for each browser context to regenerate the same galaxy chart +
 * planet list as the server did. The simplest way to guarantee
 * equality is to use the same generation code the server uses
 * (`generateStars`, `generateSystem`), fed by the same seed the
 * server picked (`GALAXY_SEED`, surfaced via `/api/health`).
 *
 * Why a separate file?
 *   - Keeps the `import.meta.env.DEV` guard in one place so a future
 *     grep + delete would strip it cleanly.
 *   - Vite tree-shakes the entire module when `import.meta.env.DEV`
 *     is false (the production build), so the bundle never ships
 *     `generateStars`, `generateSystem`, or any of the fixtures.
 *
 * Why `window.__DRIFT__` and not `window.__driftClient`?
 *   - The existing client surface (`__driftClient`) drives live
 *     multiplayer state — joining, sending chat, claiming ships. The
 *     determinism surface (`__DRIFT__`) is a pure read-only
 *     re-derivation surface. Keeping them separate lets the
 *     production code path *import* `__driftClient` (test-only) but
 *     the determinism hook lives in its own slot.
 *
 * Why are there no wall-clock fields?
 *   - The TASK-71 acceptance criterion says the e2e must be
 *     timing-independent — no `Date.now()` or setTimeout-derived
 *     values in the compared output. We use pure pure functions
 *     seeded by the server's `galaxySeed`, so two contexts that
 *     read the same seed at different millisecond offsets still
 *     produce byte-equal output.
 */

import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystemFromStar } from "@shared/galaxy/system.js";
import { generateSurfaceChunk } from "@shared/galaxy/surface.js";
import type { HealthPayload } from "@shared/health.js";
import type { Star, SurfaceChunk, SystemGen } from "@shared/galaxy/types.js";

/**
 * Public shape of the `window.__DRIFT__` debug surface.
 *
 * - `requestGalaxySeed()` fetches the live `galaxySeed` from the
 *   server (cached after the first call so it's side-effect free
 *   on the second invocation).
 * - `regenerateStarChart(count?)` returns the deterministic star
 *   list for `galaxySeed`. Defaults to the server-configured count.
 * - `regenerateSystem(starId)` returns the deterministic planet
 *   list + system id for one star.
 * - `regenerateSurfaceChunk(planetId, chunkX, chunkZ)` returns the
 *   full deterministic `SurfaceChunk` for a planet + chunk.
 *
 * Each method is independent so the test can pull one piece at a
 * time without paying for the others.
 */
export interface DriftDebugAPI {
  requestGalaxySeed(): Promise<string>;
  regenerateStarChart(count?: number): Promise<readonly Star[]>;
  regenerateSystem(starId: string): Promise<SystemGen>;
  regenerateSurfaceChunk(planetId: string, chunkX: number, chunkZ: number): Promise<SurfaceChunk>;
}

/**
 * Cache key for the resolved galaxy seed; the live server is
 * guaranteed not to change seeds mid-session, so we read it once.
 */
const cachedSeed: { value: string | null } = { value: null };

/**
 * Fetch the server-side galaxy seed (sourced from
 * `GET /api/health`). Returns a plain string — never `null`.
 *
 * The seed is cached on first read because the server picks it at
 * boot time. Tests that need a *specific* seed can override the
 * cache via {@link overrideCachedGalaxySeed} (used by the fixture
 * to lock the e2e to the worker-scoped `driftServer.galaxySeed`).
 */
export async function fetchGalaxySeed(): Promise<string> {
  if (cachedSeed.value !== null) return cachedSeed.value;
  // Pick the most precise origin we have. In the browser, use
  // `window.location.origin` (always set, even on `about:blank`).
  // In Node, default to the same-origin path that the dev proxy
  // listens on so the test's `globalThis.fetch` mock can intercept
  // it.
  const base =
    typeof window !== "undefined" && typeof window.location?.origin === "string"
      ? window.location.origin
      : "";
  const url = `${base}/api/health`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  const body = (await res.json()) as HealthPayload;
  cachedSeed.value = body.galaxySeed;
  return body.galaxySeed;
}

/** Test-only seam: overwrite the cached galaxy seed. */
export function overrideCachedGalaxySeed(seed: string): void {
  cachedSeed.value = seed;
}

/** Test-only seam: reset the cache (so a new fixture gets a fresh fetch). */
export function resetCachedGalaxySeed(): void {
  cachedSeed.value = null;
}

// ---------------------------------------------------------------------------
// The dev-only API object wired onto `window.__DRIFT__`
// ---------------------------------------------------------------------------

/**
 * Construct the `window.__DRIFT__` API instance. Returns an object
 * whose methods can be called in any order; each method resolves the
 * galaxy seed lazily on first use and caches it.
 *
 * Exposed separately from `installDriftDebug` so tests can poke at
 * it without polluting `window`.
 */
export function makeDriftDebugAPI(): DriftDebugAPI {
  return {
    async requestGalaxySeed(): Promise<string> {
      return fetchGalaxySeed();
    },

    async regenerateStarChart(count?: number): Promise<readonly Star[]> {
      const seed = await fetchGalaxySeed();
      return generateStars(seed, count);
    },

    async regenerateSystem(starId: string): Promise<SystemGen> {
      const seed = await fetchGalaxySeed();
      const stars = generateStars(seed);
      const star = stars.find((s) => s.id === starId);
      if (!star) {
        throw new Error(`regenerateSystem: starId ${starId} not in galaxy (${stars.length} stars)`);
      }
      return generateSystemFromStar(seed, star);
    },

    async regenerateSurfaceChunk(
      planetId: string,
      chunkX: number,
      chunkZ: number,
    ): Promise<SurfaceChunk> {
      const seed = await fetchGalaxySeed();
      const stars = generateStars(seed);
      // Locate the planet across every star. The surface fixture
      // contract uses the planet id directly, so we walk the galaxy
      // until we find the matching planet (typically a small sweep).
      for (const star of stars) {
        const system = generateSystemFromStar(seed, star);
        const planet = system.planets.find((p) => p.id === planetId);
        if (planet) {
          return generateSurfaceChunk(seed, planet, chunkX, chunkZ);
        }
      }
      throw new Error(
        `regenerateSurfaceChunk: planetId ${planetId} not found in galaxy (${stars.length} stars)`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Window-side hook installation (dev only)
// ---------------------------------------------------------------------------

/**
 * Wire the debug API onto `window.__DRIFT__`. The `import.meta.env.DEV`
 * guard is *inside* the function body so Vite tree-shakes the entire
 * call site (and its static imports) when `DEV` is false — production
 * builds never include `generateStars`, `generateSystem`, or the
 * `window.__DRIFT__` symbol.
 *
 * Returns the installed API handle (or `null` when not in dev).
 */
export function installDriftDebug(): DriftDebugAPI | null {
  // Vite replaces `import.meta.env.DEV` at build time with `true`
  // for `vite dev` and `false` for `vite build`. The constant-folding
  // lets Vite drop the entire body below the `if` in production.
  if (!import.meta.env.DEV) return null;
  const api = makeDriftDebugAPI();
  (globalThis as { __DRIFT__?: DriftDebugAPI }).__DRIFT__ = api;
  return api;
}

/**
 * Type guard for the `window.__DRIFT__` debug surface.
 *
 * Useful in tests that read back the API handle.
 */
export function hasDriftDebug(): boolean {
  return (globalThis as { __DRIFT__?: DriftDebugAPI }).__DRIFT__ !== undefined;
}
