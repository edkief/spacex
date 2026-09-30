// TASK-21 live smoke: ship livery REST over the :3000 proxy + page load
// with a console-error watch and a screenshot.
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:3000';

function assert(cond, what) {
  if (!cond) {
    console.error(`SMOKE FAIL: ${what}`);
    process.exit(1);
  }
  console.log(`ok: ${what}`);
}

// --- Live API happy path through the real server -------------------------
// Callsigns are capped at 16 chars (shared callsign schema).
const callsign = `sm-${Date.now().toString(36)}`;
const claimRes = await fetch(`${BASE}/api/callsigns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callsign }),
});
assert(claimRes.status === 201, `claim 201 (${callsign})`);
const { token } = await claimRes.json();

const ship0 = await (
  await fetch(`${BASE}/api/ships`, { headers: { authorization: `Bearer ${token}` } })
).json();
assert(
  typeof ship0.ship.livery?.hull === 'string',
  `starter ship has a default livery (${ship0.ship.livery.hull})`,
);

const paint = { hull: '#112233', accent: '#445566', trim: '#778899' };
const setRes = await fetch(`${BASE}/api/ships/livery`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ colors: paint }),
});
assert(setRes.status === 200, 'POST /api/ships/livery 200');
assert(
  (await setRes.json()).ship.livery.hull === paint.hull,
  'updated livery returned in the ship',
);

const bad = await fetch(`${BASE}/api/ships/livery`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ colors: { hull: 'red', accent: '#445566' } }),
});
assert(bad.status === 400, 'invalid/partial livery rejected 400');

// --- Browser: page loads clean, canvas + HUD present ----------------------
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));
await page.goto(BASE, { waitUntil: 'networkidle' });
assert(await page.locator('#game-canvas').isVisible(), 'game canvas visible');
assert((await page.locator('h1').textContent()) === 'DRIFT', 'HUD title present');
await page.screenshot({ path: '../.ralph/screenshots/TASK-21-1.png', fullPage: true });
assert(errors.length === 0, `no console errors (${errors.length})`);
await browser.close();

console.log('SMOKE PASS: TASK-21');
