/**
 * TASK-71 — unit tests for the dev-only drift debug surface.
 *
 * The full integration test lives in `tests/e2e/determinism.spec.ts`
 * (two contexts, real browser). This file covers the helpers in
 * isolation: the cache lifecycle, the override seam, and the
 * install/uninstall of the `window.__DRIFT__` hook.
 *
 * The module guards itself with `import.meta.env.DEV` so a production
 * build never installs `window.__DRIFT__`. We don't try to flip that
 * flag in this test — Vitest runs in dev (the default). The companion
 * production-build check is `tsc`'s type check + the tree-shake
 * assertion we made in the module's preamble.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fetchGalaxySeed,
  hasDriftDebug,
  installDriftDebug,
  makeDriftDebugAPI,
  overrideCachedGalaxySeed,
  resetCachedGalaxySeed,
} from "./driftDebug.js";
import type { DriftDebugAPI } from "./driftDebug.js";
import type { SurfaceChunk } from "@shared/galaxy/types.js";

/** Helper: build a stub `fetch` that returns the requested body. */
function stubFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: number } {
  const calls = { value: 0 };
  const stub = (async (input: RequestInfo | URL) => {
    calls.value++;
    const url = typeof input === "string" ? input : input.toString();
    void url;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    fetch: stub,
    get calls() {
      return calls.value;
    },
  } as { fetch: typeof fetch; calls: number };
}

describe("driftDebug — cache lifecycle", () => {
  afterEach(() => {
    resetCachedGalaxySeed();
    // Clean up any window.__DRIFT__ we installed in a test.
    Reflect.deleteProperty(globalThis as object, "__DRIFT__");
  });

  it("installDriftDebug installs window.__DRIFT__ (dev only)", () => {
    expect(hasDriftDebug()).toBe(false);
    const api = installDriftDebug();
    expect(api).not.toBeNull();
    expect(hasDriftDebug()).toBe(true);
    expect(installDriftDebug()).not.toBeNull();
  });

  it("overrideCachedGalaxySeed then fetchGalaxySeed returns the override", async () => {
    overrideCachedGalaxySeed("DRIFT-TEST-OVERRIDE-001");
    const seed = await fetchGalaxySeed();
    expect(seed).toBe("DRIFT-TEST-OVERRIDE-001");
  });

  it("resetCachedGalaxySeed forces the next fetch to hit the network", async () => {
    const stub = stubFetch({ ok: true, galaxySeed: "DRIFT-TEST-FRESH" }, 200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub.fetch as typeof fetch;
    try {
      overrideCachedGalaxySeed("DRIFT-CACHED-VALUE");
      expect(await fetchGalaxySeed()).toBe("DRIFT-CACHED-VALUE");
      resetCachedGalaxySeed();
      expect(await fetchGalaxySeed()).toBe("DRIFT-TEST-FRESH");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetchGalaxySeed returns the cached value without re-fetching", async () => {
    overrideCachedGalaxySeed("DRIFT-CACHED-FOREVER");
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true, galaxySeed: "DRIFT-NETWORK" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      // First read — cached.
      expect(await fetchGalaxySeed()).toBe("DRIFT-CACHED-FOREVER");
      // Second read — still cached, no fetch call.
      expect(await fetchGalaxySeed()).toBe("DRIFT-CACHED-FOREVER");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("driftDebug — API surface (uses @shared/galaxy directly)", () => {
  // Seed the cache so the API doesn't try to hit `/api/health` in
  // Node (where `fetch` rejects relative URLs). The cache is reset
  // to this same default in `afterEach`.
  beforeEach(() => {
    overrideCachedGalaxySeed("drift-dev-seed-001");
  });

  afterEach(() => {
    overrideCachedGalaxySeed("drift-dev-seed-001");
    Reflect.deleteProperty(globalThis as object, "__DRIFT__");
  });

  it("makeDriftDebugAPI regenerates the same star chart two independent ways", async () => {
    const api: DriftDebugAPI = makeDriftDebugAPI();
    const a = await api.regenerateStarChart(32);
    const b = await api.regenerateStarChart(32);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("regenerateSystem picks the requested star and returns a deterministic SystemGen", async () => {
    const api: DriftDebugAPI = makeDriftDebugAPI();
    const chart = await api.regenerateStarChart(8);
    const star = chart[3];
    if (!star) throw new Error("expected seed to yield ≥ 4 stars");
    const system = await api.regenerateSystem(star.id);
    // The Star snapshot inside SystemGen uses the requested star's id.
    expect(system.star.id).toBe(star.id);
    // The SystemGen.systemId is derived independently (hash2 of the
    // seed + star id) and is NOT the same as the star id — locking
    // this invariant surfaces any accidental future rename.
    expect(system.systemId).not.toBe(star.id);
    expect(system.systemId).toMatch(/^[0-9a-f]{16}$/);
    // Same inputs produce identical output across two calls.
    const systemB = await api.regenerateSystem(star.id);
    expect(JSON.stringify(system)).toBe(JSON.stringify(systemB));
  });

  it("regenerateSystem throws a clear error for an unknown starId", async () => {
    const api: DriftDebugAPI = makeDriftDebugAPI();
    await expect(api.regenerateSystem("0000000000000000")).rejects.toThrow(/not in galaxy/iu);
  });

  it("regenerateSurfaceChunk returns the same chunk shape across two calls", async () => {
    const api: DriftDebugAPI = makeDriftDebugAPI();
    const chart = await api.regenerateStarChart(4);
    const star = chart[0];
    if (!star) throw new Error("expected at least one star");
    const system = await api.regenerateSystem(star.id);
    const planet = system.planets[0];
    if (!planet) throw new Error("expected at least one planet");
    const a = await api.regenerateSurfaceChunk(planet.id, 0, 0);
    const b = await api.regenerateSurfaceChunk(planet.id, 0, 0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Sanity: the chunk carries the expected identity fields.
    const aChunk = a as SurfaceChunk;
    const bChunk = b as SurfaceChunk;
    expect(aChunk.chunkX).toBe(0);
    expect(aChunk.chunkZ).toBe(0);
    expect(aChunk.heightmap.length).toBe(4096);
    expect(bChunk.heightmap.length).toBe(4096);
  });

  it("regenerateSurfaceChunk throws a clear error for an unknown planetId", async () => {
    const api: DriftDebugAPI = makeDriftDebugAPI();
    await expect(api.regenerateSurfaceChunk("nope", 0, 0)).rejects.toThrow(/not found in galaxy/iu);
  });
});
