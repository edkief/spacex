import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-54 — the headline a11y test: the FULL game loop on KEYBOARD ALONE.
 *
 * claim → join → open chart → warp → dock → disembark → mine → re-enter →
 * sell — with ZERO mouse events in the browser. A capture-phase guard
 * listener counts pointer/mouse events and the end-of-test assertion
 * proves the loop never needed one. Every UI action is executed with
 * scripted keys (Tab/Enter/E/M/ESC/arrows/WASD) or a programmatic focus +
 * key (focus is not an input event — it carries no mouse or keyboard
 * action). The world is prepared server-side where the loop would
 * otherwise require hours of flight (the dev-teleport/dump endpoints —
 * the established e2e-assist pattern of mining.spec.ts / sell.spec.ts);
 * every in-browser action is a real client code path driven by keys.
 *
 * Warp routing: the chart only exposes a system's neighbors (ring
 * topology), and a player's home system is random, so the test scopes
 * the pad/terminal lookups to the home system (or a neighbor, via the
 * TASK-54 ?systemId= dev endpoint) and warps to it through the chart —
 * if the pad sits in the home system the loop does an out-and-back warp
 * so the warp step is always exercised.
 */

interface Session {
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

interface TerminalTarget {
  systemId: string;
  terminalId: string;
  pos: { x: number; y: number; z: number };
}

interface Overview {
  seed: string;
  systems: Array<{ systemId: string; neighbors: Array<{ to: string }> }>;
}

/**
 * Count mouse/pointer events on the page (capture phase, before any
 * app handler). The test proves "no mouse events at all" by asserting
 * the counter is still zero at the end of the loop.
 */
async function installMouseEventGuard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __MOUSE_EVENTS__: number }).__MOUSE_EVENTS__ = 0;
    const count = (): void => {
      const w = window as unknown as { __MOUSE_EVENTS__: number };
      w.__MOUSE_EVENTS__ += 1;
    };
    for (const ev of [
      'mousemove',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'pointerdown',
      'pointerup',
      'pointermove',
    ]) {
      window.addEventListener(ev, count, { capture: true, passive: true });
    }
  });
}

/** Select the chart node + fire the warp, all with keys. Returns on detach. */
async function keyboardWarp(
  page: import('@playwright/test').Page,
  toSystemId: string,
): Promise<void> {
  await page.keyboard.press('m');
  await expect(page.locator('#star-chart')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#star-chart-loading')).toBeHidden({ timeout: 15_000 });
  // The chart's error state looks like 'loaded' to the loading-hidden assert
  // (the map never renders) — fail with its text instead of a bare count 0.
  const chartError = page.locator('#star-chart-error');
  if (await chartError.isVisible().catch(() => false)) {
    throw new Error(`star chart errored: ${await chartError.textContent()}`);
  }
  const node = page.locator(`[data-testid="star-chart-node"][data-system-id="${toSystemId}"]`);
  if ((await node.count()) === 0) {
    const rendered = await page.$$eval(
      '[data-testid="star-chart-node"]',
      (els) => els.map((el) => el.getAttribute('data-system-id')),
    );
    throw new Error(
      `warp target ${toSystemId} is not a node in the chart (rendered: ${rendered.join(', ')})`,
    );
  }
  await expect(node).toHaveCount(1, { timeout: 5_000 });
  await node.focus(); // programmatic focus — NOT a mouse event
  await page.keyboard.press('Enter'); // select the node (chart-map onKeyDown)
  const warpButton = page.locator('#warp-button');
  await expect(warpButton).toBeEnabled({ timeout: 5_000 });
  await warpButton.focus();
  await page.keyboard.press('Enter'); // fire the warp
  await expect(warpButton).toBeDisabled();
  await expect(warpButton).toHaveText('WARPING…');
  // The transition is 3–6 s total (2 s in + network + 2 s out).
  await expect(page.locator('#warp-overlay')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#sys-id')).toContainText(`sys ${toSystemId}`, { timeout: 15_000 });
  // The chart rides the menu stack — ESC pops it (keyboard).
  await page.keyboard.press('Escape');
  await expect(page.locator('#star-chart')).toBeHidden({ timeout: 5_000 });
}

/**
 * Burst-turn sweep (the enter-ship.spec.ts pattern — a held key's release
 * can lag and overshoot the cone, so 100 ms bursts + a 400 ms rest read
 * the prompt AT REST): 24 × ~21° covers a full revolution.
 */
async function sweepUntil(
  page: import('@playwright/test').Page,
  promptText: string,
): Promise<void> {
  const prompt = page.locator('#interact-prompt');
  const read = async (): Promise<string | null> =>
    prompt
      .isVisible()
      .then((v) => (v ? prompt.textContent() : null))
      .catch(() => null);
  for (const key of ['d', 'a'] as const) {
    for (let i = 0; i < 24; i++) {
      await page.keyboard.down(key);
      await page.waitForTimeout(100);
      await page.keyboard.up(key);
      await page.waitForTimeout(400);
      if ((await read()) === promptText) return;
    }
  }
  throw new Error(`sweep could not face the target (wanted prompt '${promptText}')`);
}

test('keyboard only: claim → warp → dock → disembark → mine → re-enter → sell', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(240_000);
  const callsign = uniqueCallsign('kb');
  void apiPort; // all server prep goes through the proxied REST origin

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await installMouseEventGuard(page);
  await page.goto(baseURL);

  // (1) CLAIM — form + Enter (the submit button is type=submit in-form).
  await page.fill('#callsign-input', callsign);
  await page.keyboard.press('Enter');
  await expect(page.locator('#player-list')).toContainText(`${callsign} (you)`, {
    timeout: 15_000,
  });
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 15_000 });

  // The session the app stored (localStorage) drives the server-side prep.
  const session = await page.evaluate(
    () => JSON.parse(localStorage.getItem('drift.session.v1') ?? 'null') as Session | null,
  );
  expect(session?.token, 'session stored by the claim flow').toBeTruthy();
  const auth = { authorization: `Bearer ${session!.token}` };
  const rest = (url: string, init?: RequestInit): Promise<unknown> =>
    fetch(baseURL + url, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } }).then((res) =>
      res.json(),
    );

  const me = (await rest('/api/players/me')) as { homeSystemId: string };
  const overview = (await rest(`/api/galaxy/overview?home=${me.homeSystemId}`)) as Overview;
  const neighbors = overview.systems
    .find((s) => s.systemId === me.homeSystemId)!
    .neighbors.map((n) => n.to);

  // (2) WHERE IS THE PAD? Home first (out-and-back warp), then the
  // neighbors (single warp). Every candidate needs a pad AND a terminal.
  const candidates = [me.homeSystemId, ...neighbors];
  let pad: PadTarget | null = null;
  let term: TerminalTarget | null = null;
  for (const sys of candidates) {
    const [p, t] = (await Promise.all([
      rest(`/api/dev/pad-target?systemId=${sys}`),
      rest(`/api/dev/terminal-target?systemId=${sys}`),
    ])) as [unknown, unknown];
    const isPad = (x: unknown): x is PadTarget =>
      typeof x === 'object' && x !== null && 'pad' in (x as Record<string, unknown>);
    const isTerm = (x: unknown): x is TerminalTarget =>
      typeof x === 'object' && x !== null && 'terminalId' in (x as Record<string, unknown>);
    if (isPad(p) && isTerm(t)) {
      pad = p;
      term = t;
      break;
    }
  }
  expect(pad, 'no system in {home, neighbors} has a landable atmospheric pad').not.toBeNull();
  expect(term, 'the pad system has no station terminal').not.toBeNull();

  // (3) WARP — chart (M) → node (focus + Enter) → WARP (focus + Enter) →
  // ESC. If the pad is in the HOME system, do an out-and-back warp so the
  // warp step is always exercised; otherwise warp straight to the pad.
  if (pad!.systemId === me.homeSystemId) {
    await keyboardWarp(page, neighbors[0]);
    await keyboardWarp(page, me.homeSystemId);
  } else {
    await keyboardWarp(page, pad!.systemId);
  }
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-54-1.png'),
  });

  // (4) DOCK — the dev-teleport parks the ship in the pad's 20 m disc;
  // the pad machine docks it (server authority) and the client shows the
  // docked indicator + the 'E — LEAVE SHIP' prompt.
  const tele = (await rest('/api/dev/teleport', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: pad!.pad.x, y: pad!.pad.y + 5, z: pad!.pad.z }),
  })) as { ok?: boolean };
  expect(tele.ok).toBe(true);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 20_000 });

  // (5) DISSEMBARK — E (the 'exit_ship' frame).
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 20_000 });
  const weightBar = page.locator('#weight-bar');
  await expect(weightBar).toBeVisible({ timeout: 20_000 }); // on foot now
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 20_000 });

  // (6) MINE — a dev deposit 1.5 m ahead (inside the 3 m cone), then HOLD
  // E: two 1.5 s server ticks award 2 iron (2/40u on the weight bar).
  const charPos = (await page
    .waitForFunction(() => window.__CHAR__?.pos ?? null, null, {
      timeout: 20_000,
    })
    .then(() =>
      page.evaluate(() => (window as { __CHAR__?: { pos: unknown } }).__CHAR__?.pos),
    )) as {
    x: number;
    y: number;
    z: number;
  };
  const dep = (await rest('/api/dev/deposit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: charPos.x, y: charPos.y, z: charPos.z + 1.5, quantity: 5 }),
  })) as { ok: boolean };
  expect(dep.ok).toBe(true);
  const prompt = page.locator('#interact-prompt');
  await expect(prompt).toContainText('Hold [E] to mine iron', { timeout: 20_000 });
  await page.keyboard.down('e');
  await expect(page.locator('#mining-hud')).toBeVisible({ timeout: 10_000 });
  await expect(weightBar).toHaveText(/2\/40u/, { timeout: 20_000 });
  await page.keyboard.up('e');
  await expect(page.locator('#mining-hud')).toBeHidden({ timeout: 10_000 });
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-54-2.png'),
  });

  // (7) RE-ENTER — sweep the facing until '[E] Enter ship' (≤ 3 m, in the
  // 30° cone), then E (the 'enter_ship' frame). The on-foot HUD comes down.
  await sweepUntil(page, '[E] Enter ship');
  await page.keyboard.press('e');
  await expect(weightBar).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });

  // (8) DISSEMBARK AGAIN — the sell terminal is an on-foot surface (the
  // ship stays docked at the pad; the terminal sits 15 m off it).
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('e');
  await expect(weightBar).toBeVisible({ timeout: 20_000 });

  // (9) SELL — park the character 1.5 m from the terminal, face it, E
  // opens the dock panel (server 'ui-open' frame), then focus + Enter on
  // the SELL button. 500 cr + 2 × 5 cr = 510 cr.
  const tp = (await rest('/api/dev/teleport-char', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: term!.pos.x + 1.5, y: term!.pos.y, z: term!.pos.z }),
  })) as { ok?: boolean };
  expect(tp.ok).toBe(true);
  await sweepUntil(page, '[E] Dock terminal');
  await page.keyboard.press('e');
  const panel = page.locator('#dock-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel).toContainText('STATION DOCK');
  await expect(panel).toContainText('hold 0 · inv 2'); // the 2 mined iron
  const counter = page.locator('#credits-counter');
  await expect(counter).toHaveText('500 cr', { timeout: 15_000 });
  const sellButton = page.locator('button[aria-label="sell all iron inv"]');
  await sellButton.focus(); // programmatic focus — NOT a mouse event
  await page.keyboard.press('Enter');
  await expect(counter).toHaveText('510 cr', { timeout: 15_000 });
  await expect(panel).toContainText('Nothing to sell');
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-54-3.png'),
  });

  // THE PROOF: the whole loop ran without a single mouse/pointer event.
  const mouseEvents = await page.evaluate(
    () => (window as unknown as { __MOUSE_EVENTS__: number }).__MOUSE_EVENTS__,
  );
  expect(mouseEvents, 'keyboard-only loop must not dispatch mouse events').toBe(0);

  assertClean();
  await context.close();
});
