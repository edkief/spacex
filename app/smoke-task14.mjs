// TASK-14 live smoke: prediction/reconciliation over the real :3000 proxy.
// 1. WS: joins the shard system, verifies orientation on the wire (rot),
//    and the ack contract — the server echoes the last APPLIED seq at
//    snapshot cadence, monotonically, only for frames it actually applied.
// 2. Drives the REAL ClientShipPredictor from the live snapshots + acks and
//    checks the local ship tracks the authority with bounded corrections
//    (no visible snap). The strict 5 u @ 150 ms RTT acceptance threshold is
//    the virtual-clock unit test's domain; the live bound is loose because
//    localhost RTT is tiny but the server tick phase is unknown to the
//    client.
// 3. Browser: page loads clean (console watch) + screenshot.
// Pass the shard system id as SYSTEM_ID (computed from the seed).
import path from 'node:path';
import { WebSocket } from 'ws';
import { chromium } from '@playwright/test';
import { ClientShipPredictor, shipStateFromWire } from './src/client/net/prediction.ts';
import { inputToShipInput } from './src/shared/protocol/inputs.ts';

const BASE = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';
const SYSTEM_ID = process.env.SYSTEM_ID;
if (!SYSTEM_ID) {
  console.error('SMOKE FAIL: SYSTEM_ID env not set');
  process.exit(1);
}

function assert(cond, what) {
  if (!cond) {
    console.error(`SMOKE FAIL: ${what}`);
    process.exit(1);
  }
  console.log(`ok: ${what}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Live WS: wire contract + live predictor ------------------------------
const health = await fetch(`${BASE}/api/health`);
assert(health.status === 200, `health 200 (${(await health.json()).ok})`);

const callsign = `smoke14${Date.now().toString(36).slice(-8)}`;
const claimRes = await fetch(`${BASE}/api/callsigns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callsign }),
});
const claim = await claimRes.json();
assert(claimRes.status === 201, `claim 201 (ship ${claim.shipId})`);

const ws = new WebSocket(WS_URL);
const messages = [];
const updates = []; // {t, entity}
const acks = []; // {t, seq}
const sentSeqs = new Set();
let sawError = null;

ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  messages.push(msg);
  if (msg.type === 'entity_update') {
    const e = msg.payload.entities.find((x) => x.id === claim.shipId);
    if (e) updates.push({ t: Date.now(), entity: e });
  } else if (msg.type === 'ack') {
    acks.push({ t: Date.now(), seq: msg.payload.seq });
  } else if (msg.type === 'error') {
    sawError = msg.payload;
  }
});
ws.on('open', () => {
  ws.send(JSON.stringify({ v: 1, type: 'hello', payload: { v: 1 } }));
  ws.send(JSON.stringify({ v: 1, type: 'auth', payload: { token: claim.token } }));
  ws.send(JSON.stringify({ v: 1, type: 'join_system', payload: { systemId: SYSTEM_ID } }));
});
ws.on('error', (err) => {
  console.error('SMOKE FAIL: ws error', err.message);
  process.exit(1);
});
await sleep(1500); // join + first snapshots

const first = updates[0]?.entity;
assert(first !== undefined, 'received entity snapshots of the own ship');
assert(
  first.rot && [first.rot.x, first.rot.y, first.rot.z, first.rot.w].every(Number.isFinite),
  'snapshot carries orientation (rot) for reconciliation/slerp',
);
const qLen = Math.hypot(first.rot.x, first.rot.y, first.rot.z, first.rot.w);
assert(Math.abs(qLen - 1) < 1e-6, `rot is a unit quaternion (|q|=${qLen.toExponential(2)})`);

// Every snapshot after the first must carry rot too (wire contract is stable).
const missingRot = updates.filter((u) => !u.entity.rot).length;
assert(missingRot === 0, `all snapshots carry rot (${updates.length} so far)`);

// Seed the real predictor from the live wire state.
const predictor = new ClientShipPredictor(shipStateFromWire(first), {
  regime: 'space',
  shipClass: first.classId ?? 'scout',
});

// Drive: 10 Hz input frames (thrust 1) + 60 Hz prediction steps.
let seq = 0;
let lastEntity = first;
let lastInput = inputToShipInput({
  seq: 0,
  thrust: 0,
  turn: 0,
  pitch: 0,
  yaw: 0,
  fire: false,
  lock: false,
});
const corrections = [];
const t0 = Date.now();

const inputTimer = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  seq += 1;
  sentSeqs.add(seq);
  const payload = { seq, thrust: 1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false };
  ws.send(JSON.stringify({ v: 1, type: 'input', payload }));
  lastInput = inputToShipInput(payload);
  predictor.step(0.016, Date.now(), { seq, input: lastInput });
}, 100);
const frameTimer = setInterval(() => {
  predictor.step(0.016, Date.now());
}, 16);

// The ws message handler feeds the predictor: snapshots are remembered,
// acks reconcile against the newest snapshot seen.
const origOnMessage = ws.listeners('message')[0];
ws.removeAllListeners('message');
ws.on('message', (data) => {
  origOnMessage(data);
  const msg = JSON.parse(String(data));
  if (msg.type === 'entity_update') {
    const e = msg.payload.entities.find((x) => x.id === claim.shipId);
    if (e) lastEntity = e;
  } else if (msg.type === 'ack' && lastEntity) {
    const r = predictor.reconcile(shipStateFromWire(lastEntity), msg.payload.seq, Date.now());
    corrections.push({ t: Date.now() - t0, mode: r.mode, dist: r.correctionDistance });
  }
});

await sleep(4000);
clearInterval(inputTimer);
clearInterval(frameTimer);

// --- Ack contract ----------------------------------------------------------
assert(acks.length > 10, `acks flowing at ~10 Hz (${acks.length} over ~5 s)`);
assert(
  acks.every((a, i) => i === 0 || a.seq > acks[i - 1].seq),
  'acked seqs strictly increase (monotonic)',
);
assert(
  acks.every((a) => sentSeqs.has(a.seq)),
  'every acked seq is a frame the client actually sent (server echoes applied seqs)',
);
assert(acks.length < 45, `no duplicate/spam acks (${acks.length} for ${seq} sent frames)`);
assert(
  acks[acks.length - 1].seq >= 5,
  `many frames applied (last ack ${acks.at(-1).seq} of ${seq} sent)`,
);

// --- Live predictor: bounded corrections, no catastrophic snap ------------
const warm = corrections.filter((c) => c.t >= 2000);
assert(warm.length > 5, `reconciles running after warmup (${warm.length})`);
const maxDist = warm.reduce((m, c) => Math.max(m, c.dist), 0);
assert(
  maxDist < 20,
  `live corrections bounded after warmup (max ${maxDist.toFixed(2)} u; strict 5 u @150 ms RTT is the virtual-clock unit test)`,
);
assert(
  warm.every((c) => c.mode !== 'snap'),
  'no forced snaps in live steady state',
);
const blended = warm.filter((c) => c.mode === 'blend').length;
assert(blended / warm.length > 0.5, `most corrections blend smoothly (${blended}/${warm.length})`);

// --- Server-side motion still advances (input integration) -----------------
const last = updates.at(-1)?.entity;
assert(
  last.pos.z > first.pos.z + 0.5,
  `ship advanced +Z on thrust (${first.pos.z.toFixed(2)} → ${last.pos.z.toFixed(2)})`,
);
assert(sawError === null, 'no protocol errors during the flow');

ws.close();

// --- Browser: page loads clean (no renderer yet — placeholder HUD) ---------
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));
await page.goto(`${BASE}/`);
await page.waitForSelector('#game-canvas');
await expect_text(page, 'DRIFT');
// 5 s window: the manual feel check for a rendered ship lands with the
// client renderer (later tasks) — for now the page must stay error-free.
await page.waitForTimeout(5000);
const shot = path.join(import.meta.dirname, '../.agent/screenshots/TASK-14-1.png');
await page.screenshot({ path: shot, fullPage: true });
assert(errors.length === 0, `browser console clean over 5 s (${errors.length} errors)`);
await browser.close();

console.log(`screenshot: ${shot}`);
console.log('SMOKE PASS');
process.exit(0);

async function expect_text(page, text) {
  for (let i = 0; i < 50; i++) {
    if ((await page.locator('#root').textContent())?.includes(text)) return;
    await sleep(100);
  }
  throw new Error(`SMOKE FAIL: page never showed ${text}`);
}
