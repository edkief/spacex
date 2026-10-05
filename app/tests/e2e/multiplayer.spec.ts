import path from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { GamePage } from './pages/game';
import { RawWsClient } from './raw-ws';

/**
 * TASK-70 two-client tests: two independent browser contexts (two players,
 * two storage states) share one system on the fixture's server.
 * TASK-74 adds the remote-ship render test (client A sees client B's ship
 * projected through the chase camera via the __REMOTE_SHIPS__ probe).
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface RawSession {
  token: string;
  callsign: string;
  homeSystemId: string;
}

/** Raw REST claim (the shape the browser claim flow stores). */
async function rawClaim(baseURL: string, callsign: string): Promise<RawSession> {
  const res = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as RawSession;
}

/**
 * Warp the caller's ship into `targetSystemId` via raw WS, then close — the
 * ship ROW stays in the target system while the browser takes over
 * (the pvp-kill.spec.ts pattern; join_system alone never moves the ship).
 */
async function warpShipInto(
  apiPort: number,
  session: RawSession,
  targetSystemId: string,
): Promise<void> {
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
      'warp_arrived',
      10_000,
    );
  }
  client.close();
}

interface Client {
  callsign: string;
  context: BrowserContext;
  page: Page;
  claim: ClaimPage;
  game: GamePage;
  assertClean: () => void;
}

/** Claim A on its home system, then B in A's system (?sys= override). */
async function openPair(
  browser: Browser,
  base: string,
  callsignA: string,
  callsignB: string,
): Promise<[Client, Client]> {
  const make = async (callsign: string, sysId?: string): Promise<Client> => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { assertClean } = collectErrors(page);
    const claim = new ClaimPage(page, base);
    const game = new GamePage(page, base);
    await claim.claim(callsign, sysId);
    return { callsign, context, page, claim, game, assertClean };
  };
  const a = await make(callsignA);
  const sysId = await a.claim.systemId();
  const b = await make(callsignB, sysId);
  return [a, b];
}

test('two contexts in one system see each other in the presence list', async ({
  browser,
  e2eServer,
}) => {
  const [a, b] = await openPair(
    browser,
    e2eServer.baseURL,
    uniqueCallsign('dr1'),
    uniqueCallsign('dr2'),
  );
  try {
    // Each list shows BOTH callsigns, with its own "(you)" marker.
    await expect(a.game.playerList).toContainText(`${a.callsign} (you)`);
    await expect(a.game.playerList).toContainText(b.callsign);
    await expect(b.game.playerList).toContainText(a.callsign);
    await expect(b.game.playerList).toContainText(`${b.callsign} (you)`);

    await a.page.screenshot({
      path: path.join(__dirname, '../../../.ralph/screenshots/TASK-70-2.png'),
    });
    a.assertClean();
    b.assertClean();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('chat: message from A appears in B within 2 s', async ({ browser, e2eServer }) => {
  const [a, b] = await openPair(
    browser,
    e2eServer.baseURL,
    uniqueCallsign('dr3'),
    uniqueCallsign('dr4'),
  );
  try {
    await a.game.sendChat('e2e ping');

    // Server-assigned ts → B's log must show it within 2 s. Measured from
    // AFTER A's local send (delivery only, typing not included).
    const t0 = Date.now();
    await b.page.waitForFunction(
      (text: string) => document.querySelector('#chat-log')?.textContent?.includes(text) ?? false,
      `${a.callsign}: e2e ping`,
      { timeout: 2_000, polling: 50 },
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    await expect(a.game.chatLog).toContainText(`${a.callsign}: e2e ping`);

    await b.page.screenshot({
      path: path.join(__dirname, '../../../.ralph/screenshots/TASK-70-3.png'),
    });
    a.assertClean();
    b.assertClean();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

/**
 * TASK-74 — E2E: client A sees client B's SHIP on screen. Before this task
 * the remote layer only rendered characters + ground items, so a peer's ship
 * was invisible. B's ship must PHYSICALLY be in A's system (raw warp —
 * join alone never moves the ship row), then the dev-teleport parks B 30 m
 * dead ahead of A's nose (A's live pose comes from the __SELF_SHIP__ probe,
 * so the dock facing never matters). The 10 Hz snapshot brings B's entity
 * to A; the remote layer builds B's class mesh 200 ms behind, and the
 * __REMOTE_SHIPS__ probe asserts B projects inside A's viewport.
 * Screenshot: .ralph/screenshots/TASK-74-1.png (A's view, B's ship ahead).
 */
test("client A sees client B's ship projected through the chase camera", async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);

  const aCallsign = uniqueCallsign('rs-a');
  const bCallsign = uniqueCallsign('rs-b');

  // A claims in the browser (joins its home system S); B claims raw, warps
  // its ship into S, then joins S from its own context.
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const { assertClean: assertCleanA } = collectErrors(pageA);
  const claimA = new ClaimPage(pageA, baseURL);
  await claimA.claim(aCallsign);
  const sysId = await claimA.systemId();

  const bSession = await rawClaim(baseURL, bCallsign);
  await warpShipInto(apiPort, bSession, sysId);

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const { assertClean: assertCleanB } = collectErrors(pageB);
  await pageB.goto(baseURL);
  await pageB.evaluate(
    (s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)),
    bSession,
  );
  await pageB.goto(`${baseURL}/?sys=${sysId}`);
  await expect(pageB.locator('#sys-id')).toBeVisible({ timeout: 20_000 });
  await expect(pageA.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });

  // A's live ship pose (world position + orientation) from the dev probe —
  // the chase camera sits behind the nose, so "dead ahead" is the nose axis.
  const poseHandle = await pageA.waitForFunction(
    () => {
      const p = window.__SELF_SHIP__?.probe() ?? null;
      return p && p.pos && p.rot ? { pos: p.pos, rot: p.rot } : null;
    },
    undefined,
    { timeout: 20_000 },
  );
  const pose = (await poseHandle.jsonValue()) as {
    pos: { x: number; y: number; z: number };
    rot: { x: number; y: number; z: number; w: number };
  };
  // Quaternion → world +Z axis (the ship nose).
  const q = pose.rot;
  const forward = {
    x: 2 * (q.x * q.w + q.y * q.z),
    y: 2 * (q.y * q.w - q.x * q.z),
    z: 1 - 2 * (q.x * q.x + q.y * q.y),
  };
  const AHEAD_M = 30;
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bSession.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      x: pose.pos.x + AHEAD_M * forward.x,
      y: pose.pos.y + AHEAD_M * forward.y,
      z: pose.pos.z + AHEAD_M * forward.z,
    }),
  });
  expect(teleRes.status).toBe(200);

  // Poll A's remote-ship probe until B's ship projects in front of A's
  // camera (screen != null = not behind the near plane).
  const probeB = async (): Promise<{
    kind: string;
    classId: string | null;
    x: number;
    y: number;
    dist: number;
    w: number;
    h: number;
  } | null> => {
    // Everything window-touching runs INSIDE evaluate (node has no window).
    return await pageA.evaluate((target: string) => {
      const ships = window.__REMOTE_SHIPS__?.probe() ?? [];
      const bShip = ships.find((s) => s.callsign === target);
      if (!bShip || !bShip.screen) return null;
      return {
        kind: bShip.kind,
        classId: bShip.classId,
        x: bShip.screen.x,
        y: bShip.screen.y,
        dist: bShip.screen.dist,
        w: window.innerWidth,
        h: window.innerHeight,
      };
    }, bCallsign);
  };
  await expect
    .poll(() => probeB(), {
      timeout: 15_000,
      message: "client B's ship never projected in front of A",
    })
    .not.toBeNull();
  const s = (await probeB())!;
  expect(s.kind).toBe('ship');
  expect(s.classId).toBe('scout'); // a freshly claimed peer docks the scout
  expect(s.x).toBeGreaterThanOrEqual(0);
  expect(s.x).toBeLessThanOrEqual(s.w);
  expect(s.y).toBeGreaterThanOrEqual(0);
  expect(s.y).toBeLessThanOrEqual(s.h);
  // ~AHEAD_M + the chase offset (14 u) — B is close, never the spectator range.
  expect(s.dist).toBeGreaterThan(0);
  expect(s.dist).toBeLessThan(80);

  console.log(
    `[TASK-74] A sees B's ship: kind=${s.kind} class=${s.classId} ` +
      `screen=(${s.x.toFixed(0)}, ${s.y.toFixed(0)}) of ${s.w}x${s.h} dist=${s.dist.toFixed(1)} u`,
  );

  await pageA.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-74-1.png'),
  });

  assertCleanA();
  assertCleanB();
  await contextA.close();
  await contextB.close();
});
