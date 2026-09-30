import path from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { GamePage } from './pages/game';

/**
 * TASK-70 two-client tests: two independent browser contexts (two players,
 * two storage states) share one system on the fixture's server.
 */

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
      path: path.join(__dirname, '../../../.agent/screenshots/TASK-70-2.png'),
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
      path: path.join(__dirname, '../../../.agent/screenshots/TASK-70-3.png'),
    });
    a.assertClean();
    b.assertClean();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
