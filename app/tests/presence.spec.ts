import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * TASK-15 smoke: two browser contexts (independent storage, two players)
 * join the same system — each player list shows BOTH callsigns, and the
 * joiner sees a "joined" toast. Screenshot evidence in .ralph/screenshots.
 */
async function join(page: Page, callsign: string, sysId?: string): Promise<void> {
  await page.goto(sysId ? `/?sys=${sysId}` : '/');
  await page.locator('#callsign-input').fill(callsign);
  await page.locator('#join-button').click();
  // In-system: our own "(you)" row plus the system status line appear.
  await expect(page.locator('#player-list')).toContainText(`${callsign} (you)`);
  await expect(page.locator('#sys-id')).toBeVisible();
}

async function readSysId(page: Page): Promise<string> {
  const text = await page.locator('#sys-id').textContent();
  const match = text?.match(/sys ([0-9a-f]{16})/);
  if (!match) throw new Error(`no system id in: ${text}`);
  return match[1];
}

test('two contexts: both player lists show both callsigns', async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-8);
  const csA = `dr1${suffix}`;
  const csB = `dr2${suffix}`;

  const errorsA: string[] = [];
  const errorsB: string[] = [];

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  pageA.on('console', (m) => m.type() === 'error' && errorsA.push(m.text()));
  pageA.on('pageerror', (e) => errorsA.push(String(e)));

  const ctxB: BrowserContext = await browser.newContext();
  const pageB = await ctxB.newPage();
  pageB.on('console', (m) => m.type() === 'error' && errorsB.push(m.text()));
  pageB.on('pageerror', (e) => errorsB.push(String(e)));

  try {
    // Context A claims and joins its home system.
    await join(pageA, csA);
    const sysId = await readSysId(pageA);
    expect(sysId).toMatch(/^[0-9a-f]{16}$/);

    // Context B claims and joins A's system (?sys= override).
    await join(pageB, csB, sysId);

    // Both lists show both callsigns (each with its own "(you)" marker).
    await expect(pageA.locator('#player-list')).toContainText(`${csB}`);
    await expect(pageA.locator('#player-list')).toContainText(`${csA} (you)`);
    await expect(pageB.locator('#player-list')).toContainText(`${csA}`);
    await expect(pageB.locator('#player-list')).toContainText(`${csB} (you)`);

    // A saw B's join as a toast (3 s life; we are well inside it).
    await expect(pageA.locator('#toast-stack')).toContainText(`${csB} joined`);

    await pageA.screenshot({
      path: path.join(__dirname, '../../.ralph/screenshots/TASK-15-1.png'),
    });
    await pageB.screenshot({
      path: path.join(__dirname, '../../.ralph/screenshots/TASK-15-2.png'),
    });

    expect(errorsA, `console errors (context A): ${errorsA.join(' | ')}`).toEqual([]);
    expect(errorsB, `console errors (context B): ${errorsB.join(' | ')}`).toEqual([]);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
