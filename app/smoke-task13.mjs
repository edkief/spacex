// TASK-13 live smoke: test-only shard over the real :3000 proxy.
// Joins the shard's system, verifies 10 Hz entity_update snapshots,
// seq'd input integration (ship moves), and stale-seq protection.
// Pass the shard system id as SYSTEM_ID (computed from the seed).
import { WebSocket } from 'ws';

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

const health = await fetch(`${BASE}/api/health`);
assert(health.status === 200, `health 200 (${(await health.json()).ok})`);

const callsign = `smoke${Date.now().toString(36)}`;
const claimRes = await fetch(`${BASE}/api/callsigns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callsign }),
});
const claim = await claimRes.json();
assert(claimRes.status === 201, `claim 201 (ship ${claim.shipId})`);

const ws = new WebSocket(WS_URL);
const messages = [];
const updates = [];
const pending = [];
let sawError = null;

const scan = () => {
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    for (const m of messages) {
      if (p.predicate(m)) {
        pending.splice(i, 1);
        p.resolve(m);
        return;
      }
    }
  }
};
const next = (predicate, what, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.splice(
        pending.findIndex((p) => p.resolve === resolve),
        1,
      );
      reject(new Error(`timeout waiting for ${what}`));
    }, timeoutMs);
    pending.push({ predicate: (m) => (clearTimeout(timer), predicate(m)), resolve });
    scan();
  });

ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  messages.push(msg);
  if (msg.type === 'entity_update') updates.push(msg);
  if (msg.type === 'error') sawError = msg.payload;
  scan();
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

const enter = await next((m) => m.type === 'enter_system', 'enter_system', 5000);
assert(enter.payload.snapshot.systemId === SYSTEM_ID, 'enter_system for the shard system');

// First 10 Hz snapshot: the player's ship entity at the dock, full combat state.
const first = (
  await next((m) => m.type === 'entity_update', 'entity_update', 3000)
).payload.entities.find((e) => e.id === claim.shipId);
assert(first !== undefined, 'first snapshot carries the player ship');
assert(
  typeof first.hull === 'number' && typeof first.shields === 'number',
  'snapshot has hull/shields',
);
assert(first.targetId === null, 'snapshot has targetId');
const dockedRegime = first.regime;
assert(
  dockedRegime === 'docked' || dockedRegime === 'sublight',
  `initial regime valid (${dockedRegime})`,
);

// Measure snapshot cadence: collect ~1 s of snapshots and count.
const t0 = Date.now();
const count0 = updates.length;
while (Date.now() - t0 < 1100) {
  await new Promise((r) => setTimeout(r, 50));
}
const perSec = updates.length - count0;
assert(perSec >= 8 && perSec <= 12, `snapshot cadence ~10 Hz (got ${perSec}/s)`);

// Thrust for ~0.5 s: the ship must move (server-side integration).
for (let seq = 1; seq <= 10; seq++) {
  ws.send(
    JSON.stringify({
      v: 1,
      type: 'input',
      payload: { seq, thrust: 1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
    }),
  );
  await new Promise((r) => setTimeout(r, 30));
}
const after = (
  await next(
    (m) =>
      m.type === 'entity_update' &&
      (m.payload.entities.find((e) => e.id === claim.shipId)?.pos.z ?? -1e9) > first.pos.z + 0.5,
    'entity_update with forward motion',
    5000,
  )
).payload.entities.find((e) => e.id === claim.shipId);
assert(
  after.pos.z > first.pos.z + 0.5,
  `ship advanced +Z on thrust (${first.pos.z} → ${after.pos.z})`,
);
assert(after.vel.z > 0, `forward velocity positive (${after.vel.z.toFixed(2)} u/s)`);
assert(after.regime === 'sublight', 'ship left the dock regime after first input');

// Stale seq: thrust -1 at an old seq must be IGNORED (no reversal).
const beforeStale = after.pos.z;
ws.send(
  JSON.stringify({
    v: 1,
    type: 'input',
    payload: { seq: 2, thrust: -1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
  }),
);
await new Promise((r) => setTimeout(r, 400));
const latest = updates[updates.length - 1].payload.entities.find((e) => e.id === claim.shipId);
assert(
  latest.pos.z >= beforeStale - 1e-9,
  `stale seq ignored (pos.z ${beforeStale.toFixed(3)} → ${latest.pos.z.toFixed(3)}, no reversal)`,
);

assert(sawError === null, `no protocol errors during the flow`);

ws.close();
console.log('SMOKE PASS');
process.exit(0);
