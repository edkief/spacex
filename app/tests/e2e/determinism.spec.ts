import { test, expect } from './fixtures';

test.describe('Galaxy Determinism E2E', () => {
  test('two independent clients should see identical galaxy data', async ({
    page: page1,
    browser,
    gameServer,
  }) => {
    // 1. Create second context and page
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    // 2. Navigate both to app
    await page1.goto(gameServer.baseUrl);
    await page2.goto(gameServer.baseUrl);

    // 3. Fetch galaxy seed from server via debug hook
    const serverSeed = await page1.evaluate(() => (window as any).__DRIFT__.requestGalaxySeed());

    // 4. Verify both clients can get the same seed
    const seed1 = await page1.evaluate(() => (window as any).__DRIFT__.requestGalaxySeed());
    const seed2 = await page2.evaluate(() => (window as any).__DRIFT__.requestGalaxySeed());

    expect(seed1).toBe(serverSeed);
    expect(seed2).toBe(serverSeed);

    // 5. Compare star charts
    const chart1 = await page1.evaluate(
      (seed) => (window as any).__DRIFT__.regenerateStarChart(seed),
      seed1,
    );
    const chart2 = await page2.evaluate(
      (seed) => (window as any).__DRIFT__.regenerateStarChart(seed),
      seed2,
    );

    expect(chart1).toEqual(chart2);

    // 6. Pick a fixed system (e.g., the first star in the chart)
    const starId = chart1[0].id;

    // 7. Compare system planet lists
    const system1 = await page1.evaluate(
      ({ seed, starId }) => (window as any).__DRIFT__.regenerateSystem(seed, starId),
      { seed: seed1, starId },
    );
    const system2 = await page2.evaluate(
      ({ seed, starId }) => (window as any).__DRIFT__.regenerateSystem(seed, starId),
      { seed: seed2, starId },
    );

    expect(system1).toEqual(system2);

    // 8. Pick a fixed planet and chunk
    const planet = system1.planets[0];
    const cx = 0;
    const cz = 0;

    // 9. Compare surface chunks
    const chunk1 = await page1.evaluate(
      ({ seed, planet, cx, cz }) =>
        (window as any).__DRIFT__.regenerateSurfaceChunk(seed, planet, cx, cz),
      { seed: seed1, planet, cx, cz },
    );
    const chunk2 = await page2.evaluate(
      ({ seed, planet, cx, cz }) =>
        (window as any).__DRIFT__.regenerateSurfaceChunk(seed, planet, cx, cz),
      { seed: seed2, planet, cx, cz },
    );

    expect(chunk1).toEqual(chunk2);

    await context2.close();
  });
});
