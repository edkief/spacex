import { expect } from '@playwright/test';

/**
 * Shared keyboard-only helpers (extracted from keyboard-only.spec.ts for
 * TASK-59): importing a spec file re-registers its tests in Playwright, so
 * specs that reuse these helpers must import THIS module instead.
 */

/**
 * Count mouse/pointer events on the page (capture phase, before any
 * app handler). The test proves "no mouse events at all" by asserting
 * the counter is still zero at the end of the loop.
 *
 * One exemption: a `click` with `detail === 0` is the BROWSER'S own
 * translation of keyboard activation (Enter on a focused native button
 * dispatches a detail-0 click) or programmatic `.click()` — it is not a
 * pointer interaction. Real mouse clicks always carry `detail >= 1`, and
 * no mouse/pointer event can be produced by the keyboard at all, so the
 * rest of the list stays absolute.
 */
export async function installMouseEventGuard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    interface MouseLogEntry {
      ev: string;
      t: number;
      target: string;
      detail: number;
    }
    (window as unknown as { __MOUSE_EVENTS__: number }).__MOUSE_EVENTS__ = 0;
    (window as unknown as { __MOUSE_LOG__: MouseLogEntry[] }).__MOUSE_LOG__ = [];
    const count = (ev: string, e: Event): void => {
      // Keyboard-activated clicks (Enter on a focused button) and
      // programmatic .click() carry detail 0 — exempt (see doc above).
      if (ev === 'click' && (e as MouseEvent).detail === 0) return;
      const w = window as unknown as { __MOUSE_EVENTS__: number; __MOUSE_LOG__: MouseLogEntry[] };
      w.__MOUSE_EVENTS__ += 1;
      const el = e.target as HTMLElement | null;
      w.__MOUSE_LOG__.push({
        ev,
        t: Math.round(performance.now()),
        target: el ? `${el.tagName}${el.id ? `#${el.id}` : ''}` : 'null',
        detail: (e as MouseEvent).detail ?? -1,
      });
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
      window.addEventListener(ev, (e) => count(ev, e), { capture: true, passive: true });
    }
  });
}

/** Select the chart node + fire the warp, all with keys. Returns on detach. */
export async function keyboardWarp(
  page: import('@playwright/test').Page,
  toSystemId: string,
  fromSystemId: string,
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
  // Race guard: after a world swap the overview refetch can still be in
  // flight, so 'loading hidden' alone does not prove the map is centered on
  // the system the player is in NOW. The data-current node carrying the
  // expected source id does (both #sys-id and the chart prop read the same
  // systemId state, so once sys-id matches this is what the fetch centers on).
  // The nearest-star graph then guarantees the target neighbor node is
  // rendered (the test only warps to a system the chart lists).
  await expect(
    page.locator(
      `[data-testid="star-chart-node"][data-current="true"][data-system-id="${fromSystemId}"]`,
    ),
  ).toHaveCount(1, { timeout: 15_000 });
  const node = page.locator(`[data-testid="star-chart-node"][data-system-id="${toSystemId}"]`);
  if ((await node.count()) === 0) {
    const rendered = await page.$$eval('[data-testid="star-chart-node"]', (els) =>
      els.map((el) => el.getAttribute('data-system-id')),
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
export async function sweepUntil(
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
