// TASK-73 debug (temporary): raw-ws ship input path — does the server move
// the ship when an 'input' frame with thrust arrives? Boots the dev-test
// harness, claims, joins, sends one thrust frame, watches entity_updates.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const vitePort = await freePort();
const apiPort = await freePort();
const child = spawn('npm', ['run', 'dev:test'], {
  cwd: appDir,
  detached: true,
  env: {
    ...process.env,
    VITE_PORT: String(vitePort),
    API_PORT: String(apiPort),
    DB_DRIVER: 'sqlite',
    DATABASE_URL: '',
    DB_PATH: '/tmp/drift-debug-ship.db',
    SYSTEM_INSTANCE_COUNT: '1',
  },
});

const baseURL = `http://127.0.0.1:${vitePort}`;
const t0 = Date.now();
for (;;) {
  try {
    const res = await fetch(`${baseURL}/api/health`);
    if (res.status === 200) break;
  } catch {}
  if (Date.now() - t0 > 40_000) throw new Error('harness not ready');
  await new Promise((r) => setTimeout(r, 200));
}

try {
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign: 'dbgship' + Date.now().toString(36).slice(-8) }),
  });
  const raw = await claimRes.text();
  console.log('claim status', claimRes.status, raw.slice(0, 300));
  const session = JSON.parse(raw);

  const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/ws`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const send = (type, payload) => ws.send(JSON.stringify({ v: 1, type, payload }));
  let spawn = null;
  let lastPos = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === 'enter_system') {
      const ent = (m.payload.entities ?? []).find(
        (e) => e.kind === 'ship' && e.callsign === session.callsign,
      );
      if (ent && !spawn) {
        spawn = ent;
        console.log(
          'spawn:',
          JSON.stringify({ pos: ent.pos, rot: ent.rot, regime: ent.regime, padId: ent.padId }),
        );
      }
    }
    if (m.type === 'entity_update') {
      const e = (m.payload.entities ?? []).find(
        (t) => t.kind === 'ship' && t.callsign === session.callsign,
      );
      if (e) {
        if (!spawn) {
          spawn = e;
          console.log(
            'spawn (from update):',
            JSON.stringify({ pos: e.pos, rot: e.rot, regime: e.regime, padId: e.padId }),
          );
        }
        lastPos = e.pos;
        const d = spawn
          ? Math.hypot(e.pos.x - spawn.pos.x, e.pos.y - spawn.pos.y, e.pos.z - spawn.pos.z)
          : null;
        console.log(
          `upd regime=${e.regime} pad=${e.padId ?? '-'} vel=(${e.vel.x.toFixed(2)},${e.vel.y.toFixed(2)},${e.vel.z.toFixed(2)}) d=${d === null ? '-' : d.toFixed(2)}`,
        );
      }
    }
    if (m.type === 'error') console.log('ERROR frame:', JSON.stringify(m.payload));
    if (m.type === 'ack') console.log('ack', m.payload.seq);
  };
  send('hello', { v: 1 });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  // Wait for the first entity_update with our ship.
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (spawn) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(iv);
      resolve();
    }, 5000);
  });
  if (!spawn) throw new Error('never saw the self ship');
  send('input', {
    seq: 1,
    thrust: 1,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
  });
  console.log('--- sent input seq 1 thrust=1 ---');
  await new Promise((r) => setTimeout(r, 4000));
  console.log('final pos:', JSON.stringify(lastPos), 'spawn pos:', JSON.stringify(spawn.pos));
  ws.close();
} finally {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
}
