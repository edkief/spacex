import { test, expect, type Page } from './fixtures';
import { uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { generateStars } from '../../src/shared/galaxy/stars';
import { systemForId } from '../../src/shared/galaxy/system';
import { homeSystemIdForPlayer } from '../../src/shared/galaxy/home';
import { planetAnchor, planetAtmosphereRadius } from '../../src/shared/galaxy/planets';

const SEED = 'DRIFT-SEED-0001';
interface Vec3 { x: number; y: number; z: number; }
interface Tap { pos: Vec3; vel: Vec3; flightRegime: string; t: number; }

function tapShipUpdates(callsign: string): void {
  const w = window as unknown as { __t87?: Tap[] };
  w.__t87 = [];
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...args: ConstructorParameters<typeof Orig>) {
      super(...args);
      this.addEventListener('message', (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as {
            type?: string;
            payload?: { entities?: Array<{ id: string; kind: string; pos: Vec3; vel?: Vec3; flightRegime?: string; callsign?: string }> };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find((t) => t.kind === 'ship' && t.callsign === callsign);
          if (e) w.__t87?.push({ pos: e.pos, vel: e.vel ?? { x: 0, y: 0, z: 0 }, flightRegime: e.flightRegime ?? 'space', t: Date.now() });
        } catch { /* never break the page */ }
      });
    }
  };
}

const yawError = (page: Page): Promise<number | null> =>
  page.evaluate((anchor: Vec3) => {
    const p = window.__SELF_SHIP__?.probe();
    if (!p?.pos || !p.rot) return null;
    const { x, y, z, w } = p.rot;
    const nose = { x: 2 * (x * z + w * y), z: 1 - 2 * (x * x + y * y) };
    const tx = anchor.x - p.pos.x;
    const tz = anchor.z - p.pos.z;
    if (nose.x * nose.x + nose.z * nose.z < 1e-6) return null;
    return Math.atan2(nose.z * tx - nose.x * tz, nose.x * tx + nose.z * tz);
  }, ANCHOR);

let ANCHOR: Vec3 = { x: 10_000, y: 0, z: 0 };
const TURN_RATE = 0.8;
async function faceAnchor(page: Page): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const err = await yawError(page);
    if (err !== null && Math.abs(err) < 0.12) return;
    if (Date.now() - t0 > 15_000) throw new Error(`never faced the anchor (err=${err})`);
    if (err === null) { await page.waitForTimeout(250); continue; }
    const key = err > 0 ? 'a' : 'd';
    const pressS = Math.max(0.1, Math.abs(err) / TURN_RATE - 0.2);
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.ceil(pressS * 1000));
    await page.keyboard.up(key);
    await page.waitForTimeout(400);
  }
}
async function teleport(page: Page, baseURL: string, to: Vec3) {
  const token = await page.evaluate(() => localStorage.getItem('drift.token'));
  const res = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: to,
  });
  expect(res.status()).toBe(200);
  await expect
    .poll(() => page.evaluate((t: Vec3) => { const p = window.__SELF_SHIP__?.probe()?.pos; return p ? Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) : 1e9; }, to), { timeout: 20_000 })
    .toBeLessThan(50);
}

test('REPRO T87: approach a planet, log the wire flight regime', async ({ browser, e2eServer }) => {
  test.setTimeout(120_000);
  const { baseURL } = e2eServer;
  const callsign = uniqueCallsign('t87r');

  const context = await browser.newContext();
  await context.addInitScript(tapShipUpdates, callsign);
  const page = await context.newPage();
  const claim = new ClaimPage(page, baseURL);
  await claim.claim(callsign);

  const token = await page.evaluate(() => localStorage.getItem('drift.token'));
  const session = await (await fetch(`${baseURL}/api/session`, { headers: { authorization: `Bearer ${token}` } })).json();
  const playerId: string = session.playerId;
  const systemId = homeSystemIdForPlayer(SEED, playerId);
  const system = systemForId(SEED, systemId);
  expect(system, 'home system exists').toBeTruthy();
  const idx = system!.planets.findIndex((p) => p.landable && p.hasAtmosphere);
  expect(idx, 'home system has a landable atmo planet').toBeGreaterThanOrEqual(0);
  ANCHOR = planetAnchor(idx);
  const atmoR = planetAtmosphereRadius(system!.planets[idx]);
  console.log(`[T87] player=${playerId} sys=${systemId} planet idx=${idx} anchor=${JSON.stringify(ANCHOR)} atmoR=${atmoR}`);

  await expect.poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), { timeout: 20_000 }).toBe(true);

  // Approach from a HIGH ALTITUDE outside the atmosphere (thin air = less
  // drag). Teleport to atmoR + 500 out, at altitude 900 (near the top of the
  // 1 km band → boundaryFactor ≈ 0.1 → little drag to slow the ship).
  await page.keyboard.press('w'); // undock
  const highStart = { x: ANCHOR.x + atmoR + 500, y: 900, z: 0 };
  await teleport(page, baseURL, highStart);
  await faceAnchor(page);

  // Hold W toward the planet (no cruise — isolate the altitude/drag effect)
  // and observe the wire flight regime.
  await page.keyboard.down('w');
  const t0 = Date.now();
  const seen: string[] = [];
  let minDist = Infinity;
  let lastSample: Tap | null = null;
  while (Date.now() - t0 < 70_000) {
    const taps = await page.evaluate(() => (window as unknown as { __t87?: Tap[] }).__t87 ?? []);
    lastSample = taps[taps.length - 1] ?? null;
    if (lastSample) {
      const d = Math.hypot(lastSample.pos.x - ANCHOR.x, lastSample.pos.y - ANCHOR.y, lastSample.pos.z - ANCHOR.z);
      minDist = Math.min(minDist, d);
      const r = lastSample.flightRegime;
      if (seen[seen.length - 1] !== r) seen.push(r);
      // Passed beyond the anchor (overshot past the +X side): tunnel-through.
      if (lastSample.pos.x > ANCHOR.x + atmoR && minDist < atmoR + 500) break;
    }
    await page.waitForTimeout(200);
    if (lastSample && lastSample.flightRegime === 'surface') {
      await page.waitForTimeout(1000);
      const taps2 = await page.evaluate(() => (window as unknown as { __t87?: Tap[] }).__t87 ?? []);
      lastSample = taps2[taps2.length - 1] ?? lastSample;
      break;
    }
  }
  await page.keyboard.up('w');
  console.log('[T87] flight regime sequence:', seen.join(' -> '));
  console.log('[T87] min dist to anchor:', minDist.toFixed(1), 'u');
  console.log('[T87] last sample:', JSON.stringify(lastSample));
  await context.close();
});
