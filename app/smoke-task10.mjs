// TASK-10 live smoke: REST claim + session + WS token auth over the :3000 proxy.
import { WebSocket } from 'ws';

const BASE = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';

function assert(cond, what) {
  if (!cond) {
    console.error(`SMOKE FAIL: ${what}`);
    process.exit(1);
  }
  console.log(`ok: ${what}`);
}

const health = await fetch(`${BASE}/api/health`);
assert(health.status === 200, `health 200 (${(await health.json()).ok})`);

const callsign = `smoke-${Date.now().toString(36)}`;
const claimRes = await fetch(`${BASE}/api/callsigns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callsign }),
});
const claimBody = await claimRes.json();
assert(
  claimRes.status === 201,
  `claim 201 (${claimBody.callsign}, token len ${claimBody.token?.length})`,
);
assert(
  typeof claimBody.playerId === 'string' && typeof claimBody.homeSystemId === 'string',
  'claim returns playerId + homeSystemId',
);

const dupRes = await fetch(`${BASE}/api/callsigns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callsign: callsign.toUpperCase() }),
});
assert(
  dupRes.status === 409 && (await dupRes.json()).code === 'callsign-taken',
  'duplicate claim (upper-case) 409 callsign-taken',
);

const badRes = await fetch(`${BASE}/api/callsigns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callsign: 'x!' }),
});
assert(badRes.status === 400, `invalid callsign 400 (${(await badRes.json()).code})`);

const noAuth = await fetch(`${BASE}/api/session`);
assert(noAuth.status === 401, `session without bearer 401 (${(await noAuth.json()).reason})`);

const sessRes = await fetch(`${BASE}/api/session`, {
  headers: { authorization: `Bearer ${claimBody.token}` },
});
const sess = await sessRes.json();
assert(
  sessRes.status === 200 && sess.callsign === claimBody.callsign,
  `session 200 (${sess.callsign}, ship ${sess.shipId})`,
);

const badTok = await fetch(`${BASE}/api/session`, {
  headers: { authorization: 'Bearer forged.token' },
});
assert(badTok.status === 401, `forged token 401 (${(await badTok.json()).reason})`);

// WS: valid token gets through auth (home system is not in system_registry yet
// → system-not-found proves the auth gate passed); bad token → unauthenticated.
function wsFlow(authToken, joinId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ v: 1, type: 'hello', payload: { v: 1 } }));
      ws.send(JSON.stringify({ v: 1, type: 'auth', payload: { token: authToken } }));
      ws.send(JSON.stringify({ v: 1, type: 'join_system', payload: { systemId: joinId } }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'error') {
        clearTimeout(timer);
        ws.close();
        resolve(msg.payload);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const wsOk = await wsFlow(claimBody.token, claimBody.homeSystemId);
assert(
  wsOk.code === 'system-not-found',
  `ws auth passed (got system-not-found for unregistered home, not unauthenticated)`,
);

const wsBad = await wsFlow('forged.token', 'abc');
assert(wsBad.code === 'unauthenticated', `ws forged token rejected (unauthenticated)`);

console.log('SMOKE PASS');
process.exit(0);
