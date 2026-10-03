import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { RawWsClient } from './raw-ws';

/**
 * TASK-47 — E2E: player A lasers player B to the kill, and BOTH pages see
 * the kill feed entry 'A ▸ laser ▸ B' (pvp → white). The e2eServer fixture
 * boots the real dev server itself (random ports, tmp sqlite) — never run
 * alongside npm run dev.
 *
 * Positioning (the landing.spec.ts order): B's ship must PHYSICALLY be in
 * A's system — join_system only moves presence, only a WARP moves the ship
 * row — so B warps over via raw WS first (ship lands at A's spawn gate),
 * then BOTH ships are dev-teleported to the 60 km space anchor, 60 m apart
 * on +x (the same anchor shard.pvp.ws.test.ts uses — no terrain, no LOS).
 * Only then do the two browser contexts join A's system.
 *
 * Scouts carry the laser only (8 dmg, 3/s server rate), so the REAL client
 * path fires: A LMB-clicks the canvas 22 times at ~350 ms spacing; the
 * client's aim assist (nearest ship ≤ 800 m) targets B and the server's
 * targetId path re-derives the hit (range 400 m ≫ 60 m, LOS clear). A scout
 * (50 shields + 100 hull) dies on the 19th hit — the killing hit broadcasts
 * {kind:'kill', killer, victim, weapon} to the whole shard, and both pages
 * push the feed entry.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Session {
  token: string;
  callsign: string;
  homeSystemId: string;
}

/** The claim flow stores the session under this key (main.tsx). */
async function sessionOf(page: import('@playwright/test').Page): Promise<Session> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('drift.session.v1');
    if (!raw) throw new Error('no session in localStorage');
    return JSON.parse(raw) as Session;
  });
}

/** Raw REST claim (the shape the browser claim flow stores). */
async function claim(baseURL: string, callsign: string): Promise<Session> {
  const res = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Session;
}

/**
 * Warp the caller's ship to `targetSystemId` via raw WS (join home → warp →
 * warp_arrived), then close — the ship ROW stays in the target system while
 * the browser takes over (the landing.spec.ts pattern).
 */
async function warpShip(apiPort: number, session: Session, targetSystemId: string): Promise<void> {
  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (targetSystemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: targetSystemId });
    await client.next(
      (m) =>
        m.type === 'warp_arrived' &&
        (m.payload as { systemId: string }).systemId === targetSystemId,
      `warp_arrived (${targetSystemId})`,
      10_000,
    );
  }
  client.close();
}

/** The dev-teleport assist (shard.teleportForTesting — e2e-only surface). */
async function teleport(
  baseURL: string,
  token: string,
  x: number,
  y: number,
  z: number,
): Promise<void> {
  const res = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ x, y, z }),
  });
  expect(res.status).toBe(200);
}

test('A lasers B to the kill: both kill feeds show the white pvp entry', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);

  // (1) A claims in the BROWSER (joins its home system — the fight's system);
  //     B claims raw REST (its browser joins AFTER the warp).
  const aCallsign = uniqueCallsign('pvp-a');
  const bCallsign = uniqueCallsign('pvp-b');
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const { assertClean: assertCleanA } = collectErrors(pageA);
  const claimA = new ClaimPage(pageA, baseURL);
  await claimA.claim(aCallsign);
  const sysId = await claimA.systemId();

  const b = await claim(baseURL, bCallsign);
  console.log(`[pvp-kill] A=${aCallsign} B=${bCallsign} system=${sysId} Bhome=${b.homeSystemId}`);

  // (2) Warp B's ship into A's system (ship row + entity move; the raw conn
  //     closes — B's ship idles at the spawn gate until the browser joins).
  await warpShip(apiPort, b, sysId);

  // (3) Dev-teleport BOTH ships to the 60 km space anchor, 60 m apart on +x
  //     (A at the anchor, B ahead of it) — deep space, no terrain, no pads.
  const a = await sessionOf(pageA);
  await teleport(baseURL, a.token, 60000, 60000, 0);
  await teleport(baseURL, b.token, 60060, 60000, 0);

  // (4) B's browser joins A's system with the SAME token — B's ship entity
  //     is adopted from the shard (now in space).
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const { assertClean: assertCleanB } = collectErrors(pageB);
  await pageB.goto(baseURL);
  await pageB.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), b);
  await pageB.goto(`${baseURL}/?sys=${sysId}`);
  await expect(pageB.locator('#sys-id')).toBeVisible({ timeout: 20_000 });
  // Regime machine re-resolves to space + the 10 Hz batches refresh each
  // client's remote-ship list (the aim assist's candidate set).
  await pageA.waitForTimeout(1500);

  // (5) A fires the REAL client path: LMB on the canvas. Each mousedown sends
  //     a 'fire' frame with the aim-assist targetId (B, the only other ship).
  //     22 clicks at 350 ms covers the 19-hit kill (50/8 shields + 100/8
  //     hull) with margin for the first few unsynced clicks.
  const box = await pageA.locator('#game-canvas').boundingBox();
  if (!box) throw new Error('no bounding box for #game-canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < 22; i++) {
    await pageA.mouse.click(cx, cy);
    await pageA.waitForTimeout(350);
  }

  // (6) The 'kill' event broadcast reaches BOTH pages → the feed entry
  //     'A ▸ laser ▸ B' (pvp → white). It lives 10 s, so screenshot soon.
  const entryText = `${aCallsign} ▸ laser ▸ ${bCallsign}`;
  await expect(pageA.locator('#kill-feed')).toContainText(entryText, { timeout: 20_000 });
  await expect(pageB.locator('#kill-feed')).toContainText(entryText, { timeout: 20_000 });

  // pvp (victim kind 'ship', not 'ai-ship') renders white, not grey.
  const color = await pageA
    .locator('#kill-feed div')
    .last()
    .evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe('rgb(255, 255, 255)');

  await pageA.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-47-1.png'),
  });

  assertCleanA();
  assertCleanB();
  await contextA.close();
  await contextB.close();
});
