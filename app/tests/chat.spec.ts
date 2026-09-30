import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * TASK-16 smoke: two browser contexts in one system share the chat log.
 * The Enter-toggled input stays out of the way until used; an XSS payload
 * arrives as INERT TEXT — no <img> element in the DOM (React text rendering,
 * never innerHTML), and the server already stripped control characters.
 * Screenshot evidence in .ralph/screenshots.
 */
async function join(page: Page, callsign: string, sysId?: string): Promise<void> {
  await page.goto(sysId ? `/?sys=${sysId}` : '/');
  await page.locator('#callsign-input').fill(callsign);
  await page.locator('#join-button').click();
  await expect(page.locator('#player-list')).toContainText(`${callsign} (you)`);
  await expect(page.locator('#chat-log')).toBeVisible();
}

/** Open the chat input (Enter), type, send (Enter); the input closes again. */
async function sendChat(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(page.locator('#chat-input')).toBeVisible();
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-input')).toBeHidden();
}

test('system chat: shared log, inert XSS text, no console errors', async ({ browser }) => {
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
    // A claims + joins home; B joins A's system (?sys= override).
    await join(pageA, csA);
    const sysId = (await pageA.locator('#sys-id').textContent())?.match(/sys ([0-9a-f]{16})/)?.[1];
    if (!sysId) throw new Error('no system id on A');
    await join(pageB, csB, sysId);

    // The log is empty until someone talks.
    await expect(pageA.locator('#chat-messages')).toBeEmpty();

    // --- Happy path: A says hi; BOTH logs show '[HH:MM] A: hi'.
    await sendChat(pageA, 'hello drift');
    await expect(pageA.locator('#chat-log')).toContainText(`${csA}: hello drift`);
    await expect(pageB.locator('#chat-log')).toContainText(`${csA}: hello drift`);
    // The timestamp is '[HH:MM]'.
    await expect(pageB.locator('#chat-log').first()).toContainText(/\[\d{2}:\d{2}\]/);

    // --- XSS: the payload must render as inert text, not an element.
    const XSS = '<img src=x onerror=alert(1)>';
    await sendChat(pageA, XSS);
    for (const page of [pageA, pageB]) {
      await expect(page.locator('#chat-log')).toContainText(`${csA}: ${XSS}`);
      await expect(page.locator('#chat-log img')).toHaveCount(0);
      await expect(page.locator('#chat-log script')).toHaveCount(0);
    }

    await pageA.screenshot({
      path: path.join(__dirname, '../../.ralph/screenshots/TASK-16-1.png'),
    });
    await pageB.screenshot({
      path: path.join(__dirname, '../../.ralph/screenshots/TASK-16-2.png'),
    });

    expect(errorsA, `console errors (context A): ${errorsA.join(' | ')}`).toEqual([]);
    expect(errorsB, `console errors (context B): ${errorsB.join(' | ')}`).toEqual([]);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
