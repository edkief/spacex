import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * TASK-17 smoke: drop the session's socket mid-session (an init-script
 * WebSocket proxy lets the test close it and "take the server down" for the
 * retry dials — the real server keeps simulating the ship while away) and
 * bring it back. After 30 s down the 'Connection lost' overlay shows with a
 * Retry button; on recovery the client AUTO-resyncs: a 'reconnected' toast,
 * the chat log preserved, NO UI reset (claim form stays gone, player list
 * intact). Screenshot evidence in .ralph/screenshots.
 *
 * The proxy (installed before the app loads):
 *  - window.__dropCurrent()  closes the open socket (server-side leave),
 *  - window.__wsBlock = true makes every NEW socket die ~50 ms after dial
 *    (the backoff loop keeps scheduling against a "down" server),
 *  - window.__wsBlock = false lets the next retry connect normally.
 */

const WS_PROXY_INIT = `
  const RealWS = window.WebSocket;
  window.__wsInstances = [];
  window.__wsBlock = false;
  // Game sockets live on /ws; everything else (vite HMR) must be left alone
  // — killing the HMR socket makes vite reload the page.
  const isGameUrl = (u) => String(u || '').includes('/ws');
  // While blocked, a game dial returns a stub that FAILS the connection
  // (server "unreachable") — a real socket would complete the local join
  // handshake faster than we could kill it.
  const makeStub = (url) => {
    const stub = {
      url,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send() {},
      close(code) {
        stub.readyState = 3;
        setTimeout(() => {
          stub.onerror?.();
          stub.onclose?.({ code: code ?? 1006 });
        }, 20);
      },
    };
    return stub;
  };
  window.WebSocket = new Proxy(RealWS, {
    construct(target, args) {
      if (isGameUrl(args[0]) && window.__wsBlock) {
        const stub = makeStub(args[0]);
        window.__wsInstances.push(stub);
        setTimeout(() => {
          if (stub.readyState !== 0) return;
          stub.readyState = 3;
          stub.onerror?.();
          stub.onclose?.({ code: 1006 });
        }, 20);
        return stub;
      }
      const ws = new target(...args);
      window.__wsInstances.push(ws);
      return ws;
    },
  });
  window.__dropCurrent = () => {
    for (const ws of window.__wsInstances) {
      if (ws.readyState === 1 && isGameUrl(ws.url)) { try { ws.close(); } catch {} }
    }
  };
`;

async function join(page: Page, callsign: string): Promise<void> {
  await page.goto('/');
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

test('socket drop → overlay after 30 s → auto-resync on recovery, chat preserved', async ({
  browser,
}) => {
  test.setTimeout(120_000); // 30 s patience window + reconnect
  const ctx = await browser.newContext();
  await ctx.addInitScript(WS_PROXY_INIT);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await join(page, `dr17${Date.now().toString(36).slice(-8)}`);

    // A chat line we can verify is STILL there after the resync.
    await sendChat(page, 'staying put');
    await expect(page.locator('#chat-log')).toContainText('staying put');

    // Drop the socket (the ship keeps simulating server-side, now idle)…
    await page.evaluate(() => (window as never as { __dropCurrent: () => void }).__dropCurrent());
    // …and the status line (above the system id) reports the drop.
    await expect(page.locator('p').filter({ hasText: 'server ok' })).toContainText('reconnecting');
    // …and take the "server" down so every retry dial dies.
    await page.evaluate(() => {
      (window as never as { __wsBlock: boolean }).__wsBlock = true;
    });

    // After the 30 s patience window the 'Connection lost' overlay shows.
    await expect(page.locator('#connection-lost-overlay')).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator('#reconnect-retry')).toBeVisible();
    await page.screenshot({
      path: path.join(__dirname, '../../.ralph/screenshots/TASK-17-1.png'),
    });

    // Back up: the background retry (≤ 5 s backoff) resyncs WITHOUT any
    // user action — 'reconnected' toast, chat preserved, no UI reset.
    await page.evaluate(() => {
      (window as never as { __wsBlock: boolean }).__wsBlock = false;
    });
    await expect(page.locator('#toast-stack')).toContainText('reconnected', {
      timeout: 15_000,
    });
    await expect(page.locator('#chat-log')).toContainText('staying put');
    await expect(page.locator('#player-list')).toBeVisible();
    await expect(page.locator('#callsign-input')).toBeHidden();
    await expect(page.locator('#connection-lost-overlay')).toBeHidden();
    await page.screenshot({
      path: path.join(__dirname, '../../.ralph/screenshots/TASK-17-2.png'),
    });

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  } finally {
    await ctx.close();
  }
});
