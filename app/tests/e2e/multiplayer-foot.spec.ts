import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-36 — E2E: two real clients on the same surface see each other.
 *
 * Step 1 (server-side, raw REST + WS — the disembark.spec.ts pattern): BOTH
 * players claim → pad target → join/warp → dev-teleport into the dock disc →
 * the pad machine docks each ship → close the raw client (the ships idle at
 * the pad, state kept).
 *
 * Step 2 (two browser contexts, the REAL client path): each loads
 * `?sys=<padSystem>` with its own localStorage session, sees the docked
 * HUD, and presses E to disembark. Both characters then ride the shared
 * 10 Hz snapshots to the OTHER client: the remote capsule renders (200 ms
 * interpolation) with a callsign DOM label in #remote-labels, and the
 * player list shows two on-foot rows (data-mode="foot": self + peer).
 * Screenshots: A sees B / B sees A. Console stays clean on both.
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
  regime: string;
  padId?: string;
  callsign?: string;
}

async function claim(baseURL: string, callsign: string): Promise<ClaimResponse> {
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  return (await claimRes.json()) as ClaimResponse;
}

/** Dock one (already claimed) player's ship at the pad, server-authoritatively. */
async function dockPlayer(
  baseURL: string,
  apiPort: number,
  target: PadTarget,
  session: ClaimResponse,
): Promise<void> {
  const auth = { authorization: `Bearer ${session.token}` };

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
    await client.next((m) => m.type === 'warp_arrived', 'warp_arrived (pad system)', 10_000);
  }

  // Inside the pad's 20 m dock disc → the pad machine docks the ship.
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: target.pad.x, y: target.pad.y + 5, z: target.pad.z }),
  });
  expect(teleRes.status).toBe(200);
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close(); // the ship idles at the pad (state kept) while the browser takes over
}

test('two players on foot on the same pad see each other (labels + presence)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);

  const aCallsign = uniqueCallsign('foot-a');
  const bCallsign = uniqueCallsign('foot-b');
  const a = await claim(baseURL, aCallsign);
  // pad-target is an authenticated dev route — claim first, then fetch.
  const targetRes = await fetch(`${baseURL}/api/dev/pad-target`, {
    headers: { authorization: `Bearer ${a.token}` },
  });
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as PadTarget;
  const b = await claim(baseURL, bCallsign);
  await dockPlayer(baseURL, apiPort, target, a);
  await dockPlayer(baseURL, apiPort, target, b);
  console.log(`[multiplayer-foot] A=${a.callsign} B=${b.callsign} padSystem=${target.systemId}`);

  const players: Array<{ page: import('@playwright/test').Page; peer: string; shot: string }> = [];
  const contexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];
  const assertCleans: Array<() => void> = [];
  for (const [i, session] of [a, b].entries()) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    assertCleans.push(collectErrors(page).assertClean);
    await page.goto(baseURL);
    await page.evaluate(
      (s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)),
      session,
    );
    await page.goto(`${baseURL}/?sys=${target.systemId}`);
    await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 10_000 });
    players.push({
      page,
      peer: i === 0 ? b.callsign : a.callsign,
      shot: i === 0 ? 'TASK-36-1.png' : 'TASK-36-2.png',
    });
  }

  // Both press E — the REAL client disembark path on each context.
  for (const p of players) {
    await p.page.keyboard.press('e');
  }
  for (const p of players) {
    await expect(p.page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
    await expect(p.page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  }

  // Each page now sees the PEER's character: a callsign label in
  // #remote-labels (screen-space DOM, data-callsign attr) and two on-foot
  // rows in the player list (self + peer).
  for (const p of players) {
    await expect(
      p.page.locator(`#remote-labels [data-callsign="${p.peer}"]`),
      `${p.peer}'s label must be visible`,
    ).toBeVisible({ timeout: 15_000 });
    const footRows = p.page.locator('#player-list [data-mode="foot"]');
    await expect.poll(async () => footRows.count(), { timeout: 15_000 }).toBe(2);
    await p.page.waitForTimeout(500); // let the label transform settle for the shot
    await p.page.screenshot({
      path: path.join(__dirname, '../../../.ralph/screenshots', p.shot),
    });
  }

  for (const assertClean of assertCleans) assertClean();
  for (const c of contexts) await c.close();
});
