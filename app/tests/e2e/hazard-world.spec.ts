import path from 'node:path';
import { expect, test } from './fixtures';
import { canvasLuminanceVariance, collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-48.3 smoke (the 3D hazard slice). The 3D itself is verified visually
 * in TASK-48.4's e2e; here the smoke proves the WorldManager's hazard world
 * is WIRED and the frame loop runs without console errors:
 *
 * 1. the app boots in-system and the dev-only `window.__HAZARD_DISCS__`
 *    probe is live with a non-null systemId;
 * 2. hazard DISCS are derived from the shared `hazardsFor` (the home system
 *    carries hazards) — every disc is a 'storm' or 'radzone' with a 100-400 m
 *    radius and a finite world position (drone cells never become discs);
 * 3. hostile DRONES stream and render as entity meshes — every drone id is a
 *    `drone:` entity with a finite position;
 * 4. the canvas rendered (non-uniform) and the console stayed clean.
 *
 * The e2e fixture runs a single-system galaxy with the default GALAXY_SEED,
 * so the home system is deterministic and is known to carry hazards + a
 * drone cell — both assertions are safe (non-empty), never exact counts.
 */
test('hazard discs derived + drones render, world boots clean', async ({
  browser,
  e2eServer,
}) => {
  const callsign = uniqueCallsign('hzd');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);

  // REST claim (bypasses the form so we can steer the join target).
  const claim = await page.request.post(`${e2eServer.baseURL}/api/callsigns`, {
    data: { callsign },
  });
  expect(claim.status()).toBe(201);
  const session = (await claim.json()) as {
    token: string;
    playerId: string;
    callsign: string;
    homeSystemId: string;
  };

  // Boot the app straight into the home system with a pre-seeded session.
  await page.goto(`${e2eServer.baseURL}/`);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.reload();
  const claimPage = new ClaimPage(page, e2eServer.baseURL);
  await expect(claimPage.playerList).toContainText(`${callsign} (you)`);

  // The dev hook is LIVE with a rendered system.
  await page.waitForFunction(() => window.__HAZARD_DISCS__?.probe().systemId !== null, undefined, {
    timeout: 10_000,
  });

  const world = await page.evaluate(() => {
    const d = window.__HAZARD_DISCS__?.probe();
    if (!d) throw new Error('window.__HAZARD_DISCS__ missing');
    return d;
  });
  expect(world.systemId).toBeTruthy();

  // (2) Hazard discs: derived, non-empty, well-formed. Drone cells are NOT
  // discs (the drones themselves are the marker).
  expect(world.discs.length).toBeGreaterThan(0);
  for (const d of world.discs) {
    expect(['storm', 'radzone']).toContain(d.kind);
    expect(d.hazardId).toMatch(/:hz:\d+$/);
    expect(d.radius).toBeGreaterThanOrEqual(100);
    expect(d.radius).toBeLessThanOrEqual(400);
    for (const c of [d.pos.x, d.pos.y, d.pos.z]) {
      expect(Number.isFinite(c)).toBe(true);
    }
  }

  // (3) Drones: streamed + rendered, non-empty, well-formed entity ids.
  expect(world.drones.length).toBeGreaterThan(0);
  for (const dr of world.drones) {
    expect(dr.id).toMatch(/^drone:/);
    for (const c of [dr.pos.x, dr.pos.y, dr.pos.z]) {
      expect(Number.isFinite(c)).toBe(true);
    }
    expect(typeof dr.visible).toBe('boolean');
  }

  // (4) The world rendered (non-uniform) — the hazard meshes live in the
  // per-system group and the frame loop culls/spins them without error.
  expect(await canvasLuminanceVariance(page)).toBeGreaterThan(0);

  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-48.3-1.png'),
  });
  assertClean();
  await context.close();
});
