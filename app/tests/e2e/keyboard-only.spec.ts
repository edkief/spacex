import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { installMouseEventGuard, keyboardWarp, sweepUntil } from './keyboard-helpers';

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
 * Warp routing: the chart is a home-CENTRIC nearest-star graph (the
 * overview centered on X lists X + X's two nearest stars — adjacency is
 * asymmetric), and a player's home system is random, so the test scopes
 * the pad/terminal lookups to the home neighbors first (a single warp to
 * either is always legal) and the home system last, via the TASK-54
 * ?systemId= dev endpoint. If the pad ends up in the home system, the
 * loop does an out-and-back warp — but only through a neighbor whose own
 * chart still lists home (probed with one overview fetch each); a world
 * where no neighbor does simply runs the warp-free path.
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
  // Wait for the TASK-56 debounced availability probe: the submit button is
  // DISABLED until it lands, and Enter only submits once it is enabled.
  await page.fill('#callsign-input', callsign);
  await expect(page.locator('#claims-status')).toHaveText('available', { timeout: 10_000 });
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

  // The chart is a home-CENTRIC nearest-star graph (galaxyChart): the
  // overview centered on X lists X + X's two nearest stars, so adjacency is
  // NOT symmetric — warping to N does not guarantee home appears on N's
  // chart. An out-and-back via N is possible only when home is in N's own
  // overview, so probe each home neighbor (≤ 2 extra REST calls) and keep
  // the first one we can actually come home from.
  let returnVia: string | null = null;
  for (const n of neighbors) {
    const ov = (await rest(`/api/galaxy/overview?home=${n}`)) as Overview;
    if (ov.systems.some((s) => s.systemId === me.homeSystemId)) {
      returnVia = n;
      break;
    }
  }

  // (2) WHERE IS THE PAD? Neighbors first (a single warp to either is always
  // legal — home's chart lists both) and the home system last (needs the
  // out-and-back dance). Every candidate needs a pad AND a terminal.
  const candidates = [...neighbors, me.homeSystemId];
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
  // warp step is always exercised; otherwise warp straight to the pad. The
  // return leg only goes through a neighbor whose own chart still lists
  // home (see returnVia above) — the nearest-star graph is asymmetric, so
  // on a world where no neighbor does, the loop simply runs warp-free.
  if (pad!.systemId === me.homeSystemId) {
    if (returnVia) {
      await keyboardWarp(page, returnVia, me.homeSystemId);
      await keyboardWarp(page, me.homeSystemId, returnVia);
    }
  } else {
    await keyboardWarp(page, pad!.systemId, me.homeSystemId);
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
  // The 10 Hz raycast target can go stale between the prompt read and the
  // keydown (the E handler no-ops with no target), so re-press while the
  // prompt still offers it — the server's enter_ship is idempotent
  // ('already-in-ship' is a safe no-op), making the retry free.
  await sweepUntil(page, '[E] Enter ship');
  const promptText = async (): Promise<string | null> =>
    page
      .locator('#interact-prompt')
      .isVisible()
      .then((v) => (v ? page.locator('#interact-prompt').textContent() : null))
      .catch(() => null);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('e');
    await page.waitForTimeout(1_000);
    if (!(await weightBar.isVisible().catch(() => false))) break; // entered
    if ((await promptText()) !== '[E] Enter ship') break; // prompt gone — in flight
  }
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
  // Same stale-target retry as the re-enter above: the terminal prompt still
  // offering means the first E may have hit a null raycast target.
  const panel = page.locator('#dock-panel');
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('e');
    if (await panel.isVisible().catch(() => false)) break;
    await page.waitForTimeout(1_000);
    if ((await promptText()) !== '[E] Dock terminal') break;
  }
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
  const mouseLog = await page.evaluate(() => {
    const w = window as unknown as {
      __MOUSE_EVENTS__: number;
      __MOUSE_LOG__: Array<{ ev: string; t: number; target: string; detail: number }>;
    };
    return { n: w.__MOUSE_EVENTS__, log: w.__MOUSE_LOG__ };
  });
  expect(
    mouseLog.n,
    `keyboard-only loop must not dispatch mouse events (log: ${JSON.stringify(mouseLog.log)})`,
  ).toBe(0);

  assertClean();
  await context.close();
});
