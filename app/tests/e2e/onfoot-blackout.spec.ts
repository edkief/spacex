import path from 'node:path';
import { expect, test } from './fixtures';
import { canvasRegionStats, collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-88 — E2E: on-foot straight-line walking for 30 s NEVER goes all-black.
 *
 * The owner-reported bug: after disembarking and walking on a planet, the
 * 3D canvas went fully black within ~2-10 s (the DOM HUD kept drawing — the
 * TASK-75 signature). Root cause found in step 1: the local CharacterPredictor
 * ran on a FLAT pad plane while the server collided with seeded terrain — a
 * few seconds off the pad the predicted character (and the on-foot camera
 * tracking it) sank INSIDE the terrain mesh, which painted every view ray.
 *
 * Flow (the disembark.spec.ts pattern): claim → deterministic pad target →
 * raw-WS teleport into the pad disc → the pad machine docks the ship → the
 * browser re-authenticates on the same token → E disembarks → the on-foot
 * view renders (terrain + sky, not black) → hold W for 30 s sampling the
 * canvas every 1 s: at EVERY sample the whole-canvas mean luminance > 5 AND
 * the top band has >= 10 bright pixels (the TASK-75 "not black" thresholds),
 * including the reported 2-10 s window (t = 2 s and t = 8 s explicitly).
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}

interface PadTarget {
  systemId: string;
  planetId: string;
  padId: string;
  pad: { x: number; y: number; z: number };
}

interface EntityState {
  id: string;
  kind: string;
  pos: { x: number; y: number; z: number };
  regime: string;
  padId?: string;
  callsign?: string;
}

/** Whole canvas + top band in ONE pass (two GL reads, one frame apart). */
async function sample(
  page: import('@playwright/test').Page,
): Promise<{ wholeMean: number; topBright: number }> {
  const whole = await canvasRegionStats(page, { x0: 0, y0: 0, x1: 1, y1: 1 });
  const top = await canvasRegionStats(page, { x0: 0, y0: 0, x1: 1, y1: 0.3 });
  return { wholeMean: whole.mean, topBright: top.bright };
}

test('on-foot 30 s straight-line walk: never an all-black frame', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);
  const callsign = uniqueCallsign('onfoot');

  // (1) Claim — raw REST.
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const auth = { authorization: `Bearer ${session.token}` };

  // (2) The deterministic pad target.
  const targetRes = await fetch(`${baseURL}/api/dev/pad-target`, { headers: auth });
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as PadTarget;

  // (3) Join the home system over raw WS; warp to the pad's system if needed.
  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (target.systemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: target.systemId });
    const arrived = await client.next(
      (m) => m.type === 'warp_arrived',
      'warp_arrived (pad system)',
      10_000,
    );
    expect((arrived.payload as { systemId: string }).systemId).toBe(target.systemId);
  }

  // (4) Teleport INSIDE the pad's 20 m dock disc; the pad machine docks it.
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: target.pad.x, y: target.pad.y + 5, z: target.pad.z }),
  });
  expect(teleRes.status).toBe(200);

  // (5) SERVER-authoritative: docked regime + padId before the browser takes over.
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close();

  console.log(
    `[onfoot-blackout] callsign=${session.callsign} padSystem=${target.systemId} pad=(${target.pad.x},${target.pad.y},${target.pad.z})`,
  );

  // (6) Browser: same token → the docked ship renders the HUD stubs.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 10_000 });

  // (7) DISSEMBARK (E) → the on-foot view settles (the 600 ms handoff).
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  await page.waitForTimeout(1_500);

  // (a) The surface view is drawn right after disembark (terrain under,
  // sky/dome above — not a black frame).
  const t0 = await sample(page);
  expect(t0.wholeMean, 'on-foot view: whole-canvas mean luminance').toBeGreaterThan(5);
  expect(t0.topBright, 'on-foot view: top-band bright pixels').toBeGreaterThanOrEqual(10);

  // (b)-(c) HOLD W for 30 s of straight-line walking, sampling every 1 s.
  // At EVERY sample the canvas must not be all-black (TASK-75 thresholds):
  // whole-canvas mean luminance > 5 AND top-band bright pixels >= 10.
  // t = 2 s and t = 8 s sit inside the reported 2-10 s blackout window.
  await page.keyboard.down('w');
  const readings: Array<{ t: number; wholeMean: number; topBright: number }> = [];
  try {
    for (let t = 1; t <= 30; t++) {
      await page.waitForTimeout(1_000);
      const s = await sample(page);
      readings.push({ t, ...s });
      expect(s.wholeMean, `t=${t}s whole-canvas mean luminance (not black)`).toBeGreaterThan(5);
      expect(s.topBright, `t=${t}s top-band bright pixels (not black)`).toBeGreaterThanOrEqual(10);
      if (t === 15) {
        await page.screenshot({
          path: path.join(__dirname, '../../../.ralph/screenshots/TASK-88-1.png'),
        });
      }
    }
  } finally {
    await page.keyboard.up('w');
  }
  console.log(
    `[onfoot-blackout] min wholeMean=${Math.min(...readings.map((r) => r.wholeMean)).toFixed(1)} min topBright=${Math.min(...readings.map((r) => r.topBright))} over 30 samples`,
  );
  assertClean();
  await context.close();
});
