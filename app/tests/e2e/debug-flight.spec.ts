import { test } from './fixtures';
import { uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

test('debug: outbound ws traffic while holding W', async ({ browser, e2eServer }) => {
  const { baseURL } = e2eServer;
  test.setTimeout(90_000);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const orig = WebSocket.prototype.send;
    (window as unknown as Record<string, unknown>).__net = [] as string[];
    WebSocket.prototype.send = function (data: unknown) {
      const s = String(data);
      ((window as unknown as Record<string, unknown>)
        .__net as string[]).push(s.slice(0, 220));
      return orig.call(this, data);
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const claim = new ClaimPage(page, baseURL);
  await claim.claim(uniqueCallsign('dbgw'));
  await page.waitForSelector('#sys-id', { timeout: 20_000 });
  await page.waitForTimeout(2000); // let boot settle
  const before: number = await page.evaluate(() =>
    ((window as unknown as Record<string, unknown>)
      .__net as string[]).length,
  );
  await page.keyboard.down('w');
  await page.waitForTimeout(3000);
  await page.keyboard.up('w');
  const net = await page.evaluate(
    (from: number) =>
      ((window as unknown as Record<string, unknown>)
        .__net as string[]).slice(from),
    before,
  );
  console.log(`\n=== outbound messages (first 40, ${net.length} total) ===`);
  for (const m of net.slice(0, 40)) console.log(m);
  const inputs = net.filter((m) => m.includes('"input"'));
  console.log(`\n=== ${inputs.length} input frames; first 5: ===`);
  for (const m of inputs.slice(0, 5)) console.log(m);
  console.log(`\n=== errors: ${errors.length} ===`);
  for (const e of errors.slice(0, 10)) console.log(e);
  await context.close();
});
