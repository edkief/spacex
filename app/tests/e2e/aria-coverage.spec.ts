import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-54 — a11y proof #2: aria-label coverage across EVERY screen state.
 *
 * The walker asserts that no VISIBLE interactive element lacks an
 * accessible name (aria-label, aria-labelledby, placeholder/name for
 * inputs, or its own text content) on: the claim screen, the in-ship HUD,
 * the ESC menu (+ the expanded settings view with the reduced-motion
 * toggle), the star chart, the shared ship panel, the on-foot HUD, and
 * the dock panel. It also asserts the canvas is a labeled role="img" and
 * that the 1 Hz live region is mounted in the game states.
 *
 * Every navigation action is keyboard-only (the same scripted keys as
 * keyboard-only.spec.ts); the world is prepared server-side with the
 * established dev-assist pattern (teleport onto the pad — the pad machine
 * docks the ship).
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

/**
 * Every element a screen reader can TAB to (or activate): native controls
 * + role/tabindex affordances (the chart nodes are SVG g[role=button]).
 */
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';

/**
 * Walk the current DOM: every VISIBLE interactive element must carry an
 * accessible name. aria-hidden elements are excluded (decorative).
 */
async function assertAllInteractiveLabeled(page: Page, stateName: string): Promise<void> {
  const unlabeled = await page.$$eval(INTERACTIVE_SELECTOR, (els) =>
    els
      .filter((el) => el.getClientRects().length > 0) // visible
      .filter((el) => {
        if (el.hasAttribute('aria-hidden')) return false;
        const name =
          el.getAttribute('aria-label')?.trim() ||
          el.getAttribute('aria-labelledby')?.trim() ||
          (el instanceof HTMLInputElement &&
            (el.getAttribute('placeholder')?.trim() || el.name || el.id)) ||
          (el.textContent ?? '').trim();
        return name === '';
      })
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`),
  );
  expect(unlabeled, `unlabeled interactive elements on the '${stateName}' screen`).toEqual([]);
}

/** The canvas is a screen-reader image + the 1 Hz live region is mounted. */
async function assertA11yScaffolding(page: Page): Promise<void> {
  await expect(page.locator('#game-canvas')).toHaveAttribute('role', 'img');
  await expect(page.locator('#game-canvas')).toHaveAttribute('aria-label', /^.+/);
  await expect(page.locator('#live-region')).toHaveAttribute('aria-live', 'polite');
}

/** Select the chart node + fire the warp, all with keys (keyboard-only.spec.ts). */
async function keyboardWarp(page: Page, toSystemId: string): Promise<void> {
  await page.keyboard.press('m');
  await expect(page.locator('#star-chart')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#star-chart-loading')).toBeHidden({ timeout: 15_000 });
  const node = page.locator(`[data-testid="star-chart-node"][data-system-id="${toSystemId}"]`);
  await expect(node).toHaveCount(1, { timeout: 15_000 });
  await node.focus(); // programmatic focus — NOT a mouse event
  await page.keyboard.press('Enter'); // select the node (chart-map onKeyDown)
  const warpButton = page.locator('#warp-button');
  await expect(warpButton).toBeEnabled({ timeout: 5_000 });
  await warpButton.focus();
  await page.keyboard.press('Enter'); // fire the warp
  await expect(warpButton).toBeDisabled();
  await expect(warpButton).toHaveText('WARPING…');
  await expect(page.locator('#warp-overlay')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#sys-id')).toContainText(`sys ${toSystemId}`, { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#star-chart')).toBeHidden({ timeout: 5_000 });
}

/** Turn ('d' falling back to 'a') until the interact prompt reads `promptText`. */
async function sweepUntil(page: Page, promptText: string): Promise<void> {
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

test('aria coverage: every screen state has labeled interactive elements', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(300_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);

  // 1. CLAIM screen.
  await expect(page.locator('#callsign-input')).toBeVisible({ timeout: 15_000 });
  await assertAllInteractiveLabeled(page, 'claim');

  // 2. Claim in the browser (the app boots into the home system).
  // The claim is CLICKED (matching ClaimPage used by every other spec): this
  // Chromium build no longer performs implicit form submission on a
  // CDP-synthetic Enter (root-caused in TASK-95.2 — keydown arrives
  // unprevented, requestSubmit works; the app's form is healthy for real
  // keyboards). The spec's keyboard-only proof is the in-game navigation.
  const callsign = uniqueCallsign('aria');
  await page.fill('#callsign-input', callsign);
  await page.locator('#claim-button').click();
  await expect(page.locator('#player-list')).toContainText(`${callsign} (you)`, {
    timeout: 15_000,
  });
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 15_000 });

  const session = await page.evaluate(
    () => JSON.parse(localStorage.getItem('drift.session.v1') ?? 'null') as Session | null,
  );
  expect(session?.token, 'session stored by the claim flow').toBeTruthy();
  const auth = { authorization: `Bearer ${session!.token}` };
  const rest = (url: string, init?: RequestInit): Promise<unknown> =>
    fetch(baseURL + url, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } }).then((res) =>
      res.json(),
    );

  // 3. WHERE IS THE PAD? Home first, then the neighbors (ring topology —
  // the chart only exposes neighbors, so it must be reachable by one warp).
  const me = (await rest('/api/players/me')) as { homeSystemId: string };
  const overview = (await rest(`/api/galaxy/overview?home=${me.homeSystemId}`)) as {
    systems: Array<{ systemId: string; neighbors: Array<{ to: string }> }>;
  };
  const neighbors = overview.systems
    .find((s) => s.systemId === me.homeSystemId)!
    .neighbors.map((n) => n.to);
  let pad: PadTarget | null = null;
  let term: TerminalTarget | null = null;
  for (const sys of [me.homeSystemId, ...neighbors]) {
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

  // Warp to the pad's system if it is not home (keyboard-only, chart).
  if (pad!.systemId !== me.homeSystemId) {
    await keyboardWarp(page, pad!.systemId);
  }

  // 4. IN-SHIP HUD.
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 15_000 });
  await assertAllInteractiveLabeled(page, 'in-ship HUD');
  await assertA11yScaffolding(page);

  // 5. ESC MENU (+ settings view with the reduced-motion toggle).
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeVisible({ timeout: 5_000 });
  await assertAllInteractiveLabeled(page, 'ESC menu');
  const settings = page.locator('#esc-menu-settings');
  await settings.focus();
  await page.keyboard.press('Enter'); // toggles the settings view open
  await expect(page.locator('#reduced-motion-toggle')).toBeVisible({ timeout: 5_000 });
  await assertAllInteractiveLabeled(page, 'ESC menu + settings');
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-54-4.png'),
  });
  await page.keyboard.press('Escape'); // menu → closed
  await expect(page.locator('#esc-menu')).toBeHidden({ timeout: 5_000 });

  // 6. STAR CHART (M).
  await page.keyboard.press('m');
  await expect(page.locator('#star-chart')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#star-chart-loading')).toBeHidden({ timeout: 15_000 });
  await assertAllInteractiveLabeled(page, 'star chart');
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-54-5.png'),
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#star-chart')).toBeHidden({ timeout: 5_000 });

  // 7. SHARED SHIP PANEL (ESC → SHIPS → Enter).
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeVisible({ timeout: 5_000 });
  const ships = page.locator('#esc-menu-ships');
  await ships.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ship-panel')).toBeVisible({ timeout: 5_000 });
  await assertAllInteractiveLabeled(page, 'ship panel');
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-54-6.png'),
  });
  await page.keyboard.press('Escape'); // panel → menu
  await expect(page.locator('#ship-panel')).toBeHidden({ timeout: 5_000 });
  await page.keyboard.press('Escape'); // menu → closed
  await expect(page.locator('#esc-menu')).toBeHidden({ timeout: 5_000 });

  // 8. DOCK — the dev-teleport parks the ship in the pad's dock disc;
  // the pad machine docks it (server authority).
  const tele = (await rest('/api/dev/teleport', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: pad!.pad.x, y: pad!.pad.y + 5, z: pad!.pad.z }),
  })) as { ok?: boolean };
  expect(tele.ok).toBe(true);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 20_000 });

  // 9. ON-FOOT HUD (E — leave the docked ship).
  await page.keyboard.press('e');
  await expect(page.locator('#weight-bar')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#ship-hud-cargo')).toBeHidden({ timeout: 20_000 });
  await assertAllInteractiveLabeled(page, 'on-foot HUD');
  await assertA11yScaffolding(page);

  // 10. DOCK PANEL (park at the terminal, face it, E opens it server-side).
  const tp = (await rest('/api/dev/teleport-char', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: term!.pos.x + 1.5, y: term!.pos.y, z: term!.pos.z }),
  })) as { ok?: boolean };
  expect(tp.ok).toBe(true);
  await sweepUntil(page, '[E] Dock terminal');
  await page.keyboard.press('e');
  const panel = page.locator('#dock-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await assertAllInteractiveLabeled(page, 'dock panel');
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-54-7.png'),
  });
  await page.keyboard.press('Escape'); // the dock panel rides the menu stack
  await expect(panel).toBeHidden({ timeout: 5_000 });

  assertClean();
  await context.close();
});
