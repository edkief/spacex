import path from 'node:path';
import type { Page } from '@playwright/test';
import type { Star, SystemGen } from '../../src/shared/galaxy/types.js';
import { expect, test } from './fixtures';
import { collectErrors } from './helpers';

/**
 * TASK-71: two-client determinism (SC-2).
 *
 * Two INDEPENDENT browser contexts load the app against the fixture's real
 * server. Neither is signed in — the __DRIFT__ dev hook is seeded purely by
 * /api/health, so both clients derive the galaxy from the SERVER-provided
 * seed. The test pulls the star chart + one system's planet list from each
 * page and deep-compares the datasets for equality, and asserts the
 * client-side seed matches the server's GALAXY_SEED.
 *
 * Timing-independent by construction: the compared data is a pure function
 * of the seed (no wall-clock values anywhere in it), so the comparison can
 * never flake on load order or latency.
 */

/** How many stars the clients pull (small: the compare is the point). */
const CHART_SIZE = 8;

interface DriftData {
  seed: string | null;
  ready: boolean;
  chart: Star[];
  system: SystemGen;
}

/** Wait for the server seed to arrive, then pull chart + planet list. */
async function pullDriftData(page: Page): Promise<DriftData> {
  await page.waitForFunction(() => window.__DRIFT__?.ready === true, undefined, {
    timeout: 15_000,
  });
  return page.evaluate((size: number) => {
    const d = window.__DRIFT__;
    if (!d) throw new Error('window.__DRIFT__ missing');
    const starId = d.starChart(size)[0].id;
    return {
      seed: d.seed,
      ready: d.ready,
      chart: d.starChart(size),
      system: d.planetList(starId),
    };
  }, CHART_SIZE);
}

test('two independent clients derive identical galaxy data (SC-2)', async ({
  browser,
  e2eServer,
}) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [pageA, pageB] = await Promise.all([contexts[0].newPage(), contexts[1].newPage()]);
    const errsA = collectErrors(pageA);
    const errsB = collectErrors(pageB);

    await Promise.all([pageA.goto(e2eServer.baseURL), pageB.goto(e2eServer.baseURL)]);
    const dataA = await pullDriftData(pageA);
    const dataB = await pullDriftData(pageB);

    // Client seed must equal the server-exposed GALAXY_SEED (both clients).
    const health = (await (await fetch(`${e2eServer.baseURL}/api/health`)).json()) as {
      ok: boolean;
      galaxySeed: string;
    };
    expect(health.ok).toBe(true);
    expect(dataA.seed).toBe(health.galaxySeed);
    expect(dataB.seed).toBe(health.galaxySeed);

    // Deep equality of the two datasets (structural + insertion-order).
    expect(dataA.chart).toEqual(dataB.chart);
    expect(dataA.system).toEqual(dataB.system);
    expect(JSON.stringify(dataA.chart)).toBe(JSON.stringify(dataB.chart));
    expect(JSON.stringify(dataA.system)).toBe(JSON.stringify(dataB.system));

    // Sanity: the chart actually has content (empty-equals-empty is a lie).
    expect(dataA.chart.length).toBe(CHART_SIZE);
    expect(dataA.system.planets.length).toBeGreaterThan(0);

    await pageA.screenshot({
      path: path.join(__dirname, '../../../.ralph/screenshots/TASK-71-1.png'),
    });

    errsA.assertClean();
    errsB.assertClean();
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
