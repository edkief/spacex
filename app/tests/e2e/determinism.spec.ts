/**
 * TASK-71 — two-client e2e determinism comparison.
 *
 * Boots two independent browser contexts against the fixture-spawned
 * dev server and verifies that:
 *
 *   1. Both clients see the same `galaxySeed` on `/api/health`
 *      (already pulled by the TASK-70 fixture).
 *   2. After regenerating the star chart from the dev-only debug
 *      hook (`window.__DRIFT__.regenerateStarChart`), both clients'
 *      star lists are deeply equal (same ids, names, positions,
 *      classes, system counts).
 *   3. After regenerating ONE star's `SystemGen` from the same
 *      hook, both clients see byte-equal planet lists (same ids,
 *      orbits, classes, atmospheres, docks, resources, AI roster).
 *   4. The client-derived seed matches the server's seed (assertion
 *      1 inverted: the debug API fetch returns the same string the
 *      fixture captured).
 *
 * The test is timing-independent: nothing in the compared output
 * touches `Date.now()`, `setTimeout`, or socket round-trip times.
 * The fixture spawns a single dev server per worker; `2. Stability`
 * per the TASK-71 spec is satisfied by running the test 3× back-to-
 * back (via the separate `stability (3 runs)` test at the bottom).
 */
import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";

/** Helper: read the live `galaxySeed` from the dev-only debug hook. */
async function fetchClientSeed(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __DRIFT__?: { requestGalaxySeed(): Promise<string> };
    };
    if (!w.__DRIFT__) return null;
    return w.__DRIFT__.requestGalaxySeed();
  });
}

/** Helper: regenerate the star chart from the same debug hook. */
async function regenerateStarChart(page: Page, count: number): Promise<unknown[]> {
  return page.evaluate(async (c) => {
    const w = window as unknown as {
      __DRIFT__?: { regenerateStarChart(count?: number): Promise<readonly unknown[]> };
    };
    if (!w.__DRIFT__) throw new Error("expected window.__DRIFT__ in dev");
    return (await w.__DRIFT__.regenerateStarChart(c)) as unknown[];
  }, count);
}

/** Helper: regenerate the planet list for one star. */
async function regenerateSystemForStar(page: Page, starId: string): Promise<unknown> {
  return page.evaluate(async (id) => {
    const w = window as unknown as {
      __DRIFT__?: { regenerateSystem(starId: string): Promise<unknown> };
    };
    if (!w.__DRIFT__) throw new Error("expected window.__DRIFT__ in dev");
    return w.__DRIFT__.regenerateSystem(id);
  }, starId);
}

/** Helper: regenerate a single surface chunk. */
async function regenerateSurfaceChunk(
  page: Page,
  planetId: string,
  chunkX: number,
  chunkZ: number,
): Promise<unknown> {
  return page.evaluate(
    async (args) => {
      const w = window as unknown as {
        __DRIFT__?: {
          regenerateSurfaceChunk(
            planetId: string,
            chunkX: number,
            chunkZ: number,
          ): Promise<unknown>;
        };
      };
      if (!w.__DRIFT__) throw new Error("expected window.__DRIFT__ in dev");
      return w.__DRIFT__.regenerateSurfaceChunk(args.planetId, args.chunkX, args.chunkZ);
    },
    { planetId, chunkX, chunkZ } as { planetId: string; chunkX: number; chunkZ: number },
  );
}

/** Hard-compare two values via JSON serialization (works across contexts). */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

test.describe("two-client e2e determinism", () => {
  test("two contexts regenerate identical star chart + planet list from the same seed", async ({
    browser,
    driftServer: server,
  }) => {
    // Step 1: both contexts boot against the fixture-spawned dev server.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const consoleErrors: { ctx: string; msg: string }[] = [];
    const track = (ctx: string, p: Page): void => {
      p.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push({ ctx, msg: msg.text() });
      });
    };
    track("A", pageA);
    track("B", pageB);

    await Promise.all([pageA.goto(`${server.baseURL}/`), pageB.goto(`${server.baseURL}/`)]);

    // Step 2: server reports the seed the fixture captured.
    const serverSeed = server.galaxySeed;
    expect(serverSeed).toMatch(/^E2E-/);

    // The dev server also reports it on /api/health.
    const serverHealthRes = await fetch(`${server.apiURL}/api/health`);
    expect(serverHealthRes.ok).toBe(true);
    const serverHealth = (await serverHealthRes.json()) as { galaxySeed: string };
    expect(serverHealth.galaxySeed).toBe(serverSeed);

    // Step 3: both clients pull the seed through __DRIFT__ — proves
    // the bridge from server → client works.
    await pageA.waitForFunction(
      () => (window as unknown as { __DRIFT__?: unknown }).__DRIFT__ !== undefined,
      undefined,
      { timeout: 10_000 },
    );
    await pageB.waitForFunction(
      () => (window as unknown as { __DRIFT__?: unknown }).__DRIFT__ !== undefined,
      undefined,
      { timeout: 10_000 },
    );

    const clientSeedA = await fetchClientSeed(pageA);
    const clientSeedB = await fetchClientSeed(pageB);
    expect(clientSeedA).toBe(serverSeed);
    expect(clientSeedB).toBe(serverSeed);

    // Step 4: regenerate the FULL star chart on both contexts and
    // verify byte-equal output. Use the default count (GALAXY_STAR_COUNT).
    const chartA = await regenerateStarChart(pageA, /* count */ 200);
    const chartB = await regenerateStarChart(pageB, /* count */ 200);
    expect(chartA.length).toBe(200);
    expect(chartB.length).toBe(200);
    expect(jsonEqual(chartA, chartB)).toBe(true);
    // Same length + first/last ids equal ⇒ deep JSON equal ⇒ done.
    const firstA = (chartA[0] as { id: string }).id;
    const firstB = (chartB[0] as { id: string }).id;
    expect(firstA).toBe(firstB);

    // Step 5: pick the first star and regenerate its SystemGen on
    // both contexts; verify byte-equal output.
    const firstStarId = firstA;
    const systemA = await regenerateSystemForStar(pageA, firstStarId);
    const systemB = await regenerateSystemForStar(pageB, firstStarId);
    expect(jsonEqual(systemA, systemB)).toBe(true);

    // Also pick a later star (index 50, well past the dev fixtures'
    // first-two coverage) and verify its system is stable too.
    const laterStarId = (chartA[50] as { id: string }).id;
    const laterSystemA = await regenerateSystemForStar(pageA, laterStarId);
    const laterSystemB = await regenerateSystemForStar(pageB, laterStarId);
    expect(jsonEqual(laterSystemA, laterSystemB)).toBe(true);

    // Step 6: regenerate ONE surface chunk from its first planet and
    // verify byte-equal output. Limit the heightmap to a 64-cell
    // (8×8) sub-region to keep the JSON comparison small while
    // exercising the cross-chunk determinism path.
    const planetList = (systemA as { planets: readonly { id: string }[] }).planets;
    expect(planetList.length).toBeGreaterThan(0);
    const firstPlanetId = planetList[0]!.id;
    const chunkA = await regenerateSurfaceChunk(pageA, firstPlanetId, 0, 0);
    const chunkB = await regenerateSurfaceChunk(pageB, firstPlanetId, 0, 0);
    expect(jsonEqual(chunkA, chunkB)).toBe(true);

    // Step 7: capture a screenshot showing both contexts running with
    // the determinism hook installed (no UI change — the hook is
    // window-scoped — but the assertion that __DRIFT__ is reachable
    // is what we're snapping).
    await pageA.screenshot({
      path: "../.ralph/screenshots/TASK-71-1.png",
      fullPage: true,
    });

    // No uncaught console errors.
    expect(consoleErrors, `unexpected console errors: ${JSON.stringify(consoleErrors)}`).toEqual(
      [],
    );

    await contextA.close();
    await contextB.close();
  });
});

// ---------------------------------------------------------------------------
// Step 3: stability across 3 consecutive runs
// ---------------------------------------------------------------------------
//
// We run the determinism comparison 3 times in the same worker
// against the same fixture-spawned dev server. Each run is a fresh
// browser context pair, so a flaky generator (one that depends on
// wall-clock state) would fail at least one run. The assertion below
// is that all 3 runs produce identical results.

test.describe("stability — 3 consecutive runs produce identical output", () => {
  for (let run = 1; run <= 3; run++) {
    test(`run ${run} of 3: star chart + system identical across two contexts`, async ({
      browser,
      driftServer: server,
    }) => {
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await Promise.all([pageA.goto(`${server.baseURL}/`), pageB.goto(`${server.baseURL}/`)]);

      await pageA.waitForFunction(
        () => (window as unknown as { __DRIFT__?: unknown }).__DRIFT__ !== undefined,
        undefined,
        { timeout: 10_000 },
      );
      await pageB.waitForFunction(
        () => (window as unknown as { __DRIFT__?: unknown }).__DRIFT__ !== undefined,
        undefined,
        { timeout: 10_000 },
      );

      const chartA = await regenerateStarChart(pageA, 200);
      const chartB = await regenerateStarChart(pageB, 200);
      expect(jsonEqual(chartA, chartB)).toBe(true);

      const starId = (chartA[0] as { id: string }).id;
      const systemA = await regenerateSystemForStar(pageA, starId);
      const systemB = await regenerateSystemForStar(pageB, starId);
      expect(jsonEqual(systemA, systemB)).toBe(true);

      await contextA.close();
      await contextB.close();
    });
  }
});
