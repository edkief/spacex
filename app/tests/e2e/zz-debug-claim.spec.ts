import { expect, test } from './fixtures';
import { uniqueCallsign } from './helpers';

test('debug: claim via Enter', async ({ browser, e2eServer }) => {
  const { baseURL } = e2eServer;
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  page.on('request', (r) =>
    r.url().includes('/api/') && r.method() !== 'GET'
      ? console.log('[req]', r.method(), r.url())
      : undefined,
  );
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
  page.on('response', (r) =>
    r.url().includes('/api/callsigns')
      ? console.log('[res]', r.status(), r.url())
      : undefined,
  );
  await page.goto(baseURL);
  await expect(page.locator('#callsign-input')).toBeVisible({ timeout: 15_000 });
  const callsign = uniqueCallsign('dbg');
  await page.fill('#callsign-input', callsign);
  const domInfo = await page.evaluate(() => {
    const form = document.querySelector('form');
    const input = document.getElementById('callsign-input');
    (window as unknown as { __keys: unknown[] }).__keys = [];
    window.addEventListener(
      'keydown',
      (e) =>
        (window as unknown as { __keys: unknown[] }).__keys.push({
          key: e.key,
          target: (e.target as HTMLElement | null)?.id,
          prevented: e.defaultPrevented,
        }),
      true, // capture: before anything else
    );
    return { formHasInput: !!form?.contains(input), formTag: form?.tagName };
  });
  console.log('[dom]', JSON.stringify(domInfo));
  console.log('[step] filled, pressing Enter');
  await page.keyboard.press('Enter');
  const keys = await page.evaluate(
    () => (window as unknown as { __keys: unknown[] }).__keys,
  );
  console.log('[keys-after-enter]', JSON.stringify(keys));
  const probe = await page.evaluate(() => {
    const form = document.querySelector('form') as HTMLFormElement | null;
    const input = document.getElementById('callsign-input');
    const submits: string[] = [];
    form?.addEventListener('submit', () => submits.push('submit-event'), {
      once: true,
    });
    // 1. native synthetic keydown (trusted=false)
    input?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    const afterNative = [...submits];
    submits.length = 0;
    // 2. requestSubmit()
    form?.requestSubmit();
    return { afterNative, afterRequestSubmit: [...submits] };
  });
  console.log('[probe]', JSON.stringify(probe));
  await page.waitForTimeout(1500);
  console.log('[after-probe-session]', await page.evaluate(() => !!localStorage.getItem('drift.session.v1')));
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(2000);
    const state = await page.evaluate(() => ({
      status: document.querySelector('#claims-status')?.textContent ?? null,
      button: (document.querySelector('#claim-button') as HTMLButtonElement | null)?.textContent,
      disabled: (document.querySelector('#claim-button') as HTMLButtonElement | null)?.disabled,
      claimVisible: !!document.getElementById('claims-screen'),
      playerList: !!document.getElementById('player-list'),
      session: !!localStorage.getItem('drift.session.v1'),
      activeEl: document.activeElement?.id ?? document.activeElement?.tagName,
    }));
    console.log(`[t+${i * 2}s]`, JSON.stringify(state));
    if (state.playerList || !state.claimVisible) break;
  }
});
