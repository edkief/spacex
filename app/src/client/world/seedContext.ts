/**
 * Galaxy seed context — TASK-76.
 *
 * The client needs the *server's* galaxy seed to regenerate the
 * star it is currently orbiting and that star's planet list. The
 * server publishes it on the public, unauthenticated
 * `GET /api/health` (`{ ok, galaxySeed }` — see
 * `src/server/server.ts`), so the client can read it once at
 * session start and derive the whole system locally: no extra
 * round-trips per warp, and the seed-determinism promise (PRD
 * SC-2) is visible in-world.
 *
 * Why not `@client/net/driftDebug.ts`? That module's
 * `installDriftDebug()` body is guarded by `import.meta.env.DEV`,
 * so the whole surface — including `fetchGalaxySeed` — is
 * tree-shaken out of a production bundle. The world renderer
 * cannot depend on a dev-only seam. This module has **no** build
 * guard: it is a two-field cache plus one `fetch`.
 *
 * Shape:
 *   - `ensureGalaxySeed()` — idempotent, de-duplicated fetch.
 *     Concurrent callers share the in-flight promise.
 *   - `getGalaxySeed()` — synchronous read (null until loaded).
 *   - `subscribeGalaxySeed(fn)` — push update for late arrivals
 *     (the seed almost always lands *after* the first frames).
 *   - `resetGalaxySeedCache()` — test seam.
 */

import type { HealthPayload } from "@shared/health.js";

/** Options for {@link ensureGalaxySeed}. All are test seams. */
export interface EnsureGalaxySeedOptions {
  /** Injected fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Absolute origin to prefix `/api/health` with. Defaults to
   *  `window.location.origin` in the browser, `""` elsewhere. */
  baseUrl?: string;
}

/** State of the one-shot seed cache. */
interface SeedState {
  seed: string | null;
  inFlight: Promise<string | null> | null;
  error: string | null;
}

const state: SeedState = { seed: null, inFlight: null, error: null };

/** Subscribers notified whenever the cached seed changes. */
const listeners = new Set<(seed: string | null) => void>();

/**
 * The galaxy seed, or `null` when it has not loaded yet (or the
 * fetch failed). Callers must handle `null` — rendering simply
 * skips the body layer until the seed lands.
 */
export function getGalaxySeed(): string | null {
  return state.seed;
}

/** Last fetch error message, or `null` when the last attempt
 *  succeeded / never ran. Diagnostics for the debug overlay. */
export function getGalaxySeedError(): string | null {
  return state.error;
}

/** True once a fetch has resolved (success *or* failure). */
export function isGalaxySeedLoaded(): boolean {
  return state.seed !== null || state.error !== null;
}

/**
 * Subscribe to seed resolution. Fires immediately with the
 * current value (so a late subscriber is not left waiting), then
 * again whenever the value changes. Returns an unsubscribe fn.
 */
export function subscribeGalaxySeed(listener: (seed: string | null) => void): () => void {
  listeners.add(listener);
  try {
    listener(state.seed);
  } catch {
    // Same contract as `emit` — a bad subscriber never throws here.
  }
  return (): void => {
    listeners.delete(listener);
  };
}

/** Notify every subscriber. Wrapped so a throwing listener can
 *  never take down the caller (the frame loop). */
function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener(state.seed);
    } catch {
      // A misbehaving subscriber must not break the seed cache.
    }
  }
}

/**
 * Fetch `/api/health` once and cache the seed. Repeat calls after
 * a success return the cached value without touching the network;
 * concurrent calls share the in-flight promise. A failed fetch
 * resolves to `null` (never rejects) and leaves the cache retryable
 * so the next session start tries again.
 */
export function ensureGalaxySeed(options: EnsureGalaxySeedOptions = {}): Promise<string | null> {
  if (state.seed !== null) return Promise.resolve(state.seed);
  if (state.inFlight !== null) return state.inFlight;

  const doFetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (doFetch === undefined) {
    state.error = "no fetch implementation available";
    return Promise.resolve(null);
  }

  const base =
    options.baseUrl ??
    (typeof window !== "undefined" && typeof window.location?.origin === "string"
      ? window.location.origin
      : "");
  const url = `${base}/api/health`;

  const pending = (async (): Promise<string | null> => {
    try {
      const res = await doFetch(url);
      if (!res.ok) {
        state.error = `${url} returned ${res.status}`;
        emit();
        return null;
      }
      const body = (await res.json()) as Partial<HealthPayload>;
      if (typeof body.galaxySeed !== "string" || body.galaxySeed.length === 0) {
        state.error = `${url} returned no galaxySeed`;
        emit();
        return null;
      }
      state.seed = body.galaxySeed;
      state.error = null;
      emit();
      return state.seed;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      emit();
      return null;
    } finally {
      state.inFlight = null;
    }
  })();

  state.inFlight = pending;
  return pending;
}

/**
 * Test seam — drop the cache, in-flight promise and subscribers.
 * Production never calls this (the seed is stable for the life of
 * the server process).
 */
export function resetGalaxySeedCache(): void {
  state.seed = null;
  state.inFlight = null;
  state.error = null;
  listeners.clear();
}
