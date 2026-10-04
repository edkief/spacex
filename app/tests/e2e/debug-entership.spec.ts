/**
 * TEMP DEBUG spec for the TASK-73 enter-ship re-enter flake (deleted at
 * close-out). Mirrors enter-ship.spec.ts VERBATIM (same steps, same 15 s
 * timeouts) but taps the browser's WebSocket (addInitScript subclass) to
 * dump every inbound/outbound frame on finish: which 'enter_ship' went out,
 * which 'error' came back, last input payloads, last ship/char state.
 */
import fs from 'node:fs';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { uniqueCallsign } from './helpers';

const PROTOCOL_VERSION = 1;

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

class RawWsClient {
  readonly messages: Envelope[] = [];
  closed = false;
  private ws: WebSocket;
  private wake: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {});
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as Envelope);
      for (const w of this.wake.splice(0)) w();
    });
    this.ws.on('close', () => {
      this.closed = true;
      for (const w of this.wake.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', () => reject(new Error('socket closed before open')));
    });
  }

  send(envelope: Envelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  async next(predicate: (m: Envelope) => boolean, what: string, ms = 8000): Promise<Envelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}

interface PadTarget {
  systemId: string;
  planetId: string;
  padId: string;
  pad: { x: number; y: number; z: number };
}

interface EntityState {
  id: string;
  kind: string;
  pos: { x: number; y: number; z: number };
  regime: string;
  padId?: string;
  callsign?: string;
}

type CharPos = { x: number; y: number; z: number };

async function dockAtPad(baseURL: string, apiPort: number, session: ClaimResponse) {
  const auth = { authorization: `Bearer ${session.token}` };
  const targetRes = await fetch(`${baseURL}/api/dev/pad-target`, { headers: auth });
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as PadTarget;

  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (target.systemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: target.systemId });
    await client.next((m) => m.type === 'warp_arrived', 'warp_arrived (pad system)', 10_000);
  }
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: target.pad.x, y: target.pad.y + 5, z: target.pad.z }),
  });
  expect(teleRes.status).toBe(200);
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close();
  return target;
}

/**
 * The WS tap: a WebSocket subclass installed BEFORE the page's own scripts
 * log EVERY frame (in + out, bounded) and track the last self-ship state
 * (pos/vel/regime/padId) and self-character pos out of entity_update.
 */
function installTap(callsign: string): string {
  return `
    (() => {
      const callsign = ${JSON.stringify(callsign)};
      const OrigWS = window.WebSocket;
      class TapWS extends OrigWS {
        constructor(url, protocols) {
          super(url, protocols);
          this.addEventListener('message', (ev) => {
            try {
              const m = JSON.parse(String(ev.data));
              window.__msgs = window.__msgs || [];
              window.__msgs.push({ dir: 'in', m, t: Date.now() });
              if (window.__msgs.length > 4000) window.__msgs.splice(0, window.__msgs.length - 4000);
              if (m.type === 'entity_update') {
                const ents = (m.payload && m.payload.entities) || [];
                for (const e of ents) {
                  if (e.callsign !== callsign) continue;
                  if (e.kind === 'character') {
                    window.__lastChar = { pos: e.pos, onFoot: e.onFoot };
                  } else if (e.kind === 'ship') {
                    window.__lastShip = { pos: e.pos, vel: e.vel, regime: e.regime, padId: e.padId ?? null };
                  }
                }
              }
            } catch { /* ignore non-JSON */ }
          });
          this.addEventListener('open', () => {
            const origSend = this.send.bind(this);
            this.send = (data) => {
              try {
                const m = JSON.parse(String(data));
                window.__msgs = window.__msgs || [];
                window.__msgs.push({ dir: 'out', m, t: Date.now() });
                if (window.__msgs.length > 4000) window.__msgs.splice(0, window.__msgs.length - 4000);
              } catch { /* ignore */ }
              return origSend(data);
            };
          });
        }
      }
      window.WebSocket = TapWS;
    })();
  `;
}

/**
 * The E-press tap: captures, at EVERY 'e' keydown, what the client saw at
 * that instant — the focus target, the DOM prompt text, the __INTERACT__
 * hook (the raycast the dispatch reads) and the __CHAR__ server state.
 */
function installEPressCapture(): string {
  return `
    (() => {
      window.addEventListener('keydown', (e) => {
        if (e.key !== 'e' && e.key !== 'E') return;
        window.__ePresses = window.__ePresses || [];
        const promptEl = document.querySelector('#interact-prompt');
        const i = window.__INTERACT__ || null;
        const c = window.__CHAR__ || null;
        window.__ePresses.push({
          t: Date.now(),
          tag: (document.activeElement && document.activeElement.tagName) || null,
          repeat: e.repeat,
          promptText: (promptEl && promptEl.textContent) || null,
          interact: i ? { text: i.text, targetId: i.targetId, distance: i.distance, feet: i.feet } : null,
          char: c ? { pos: c.pos, acked: c.acked } : null,
        });
        if (window.__ePresses.length > 20) window.__ePresses.shift();
      });
    })();
  `;
}

// (The dump logic lives in-page: page.evaluate cannot serialize fns and
// silently drops extra args — one plain-object arg, constants only.)

test('debug: enter-ship re-enter with full WS dump', async ({ browser, e2eServer }) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  const callsign = uniqueCallsign('dbg');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(installTap(session.callsign));
  await page.addInitScript(installEPressCapture());
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  // Soft step runner: a failed step is recorded (with its error) and the
  // sequence CONTINUES so the WS dump at the end always lands.
  let failedStep: string | null = null;
  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    if (failedStep) return;
    try {
      await fn();
    } catch (err) {
      failedStep = `${name}: ${String(err).split('\n')[0]}`;
      console.log(`[DEBUG-ENTER-SHIP] STEP-FAILED ${failedStep}`);
    }
  };

  await step('disembark', async () => {
    await page.keyboard.press('e');
    await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  });
  const start = (await page
    .waitForFunction(() => window.__CHAR__?.pos ?? null, null, { timeout: 15_000 })
    .then((h) => h.jsonValue())) as CharPos;

  const prompt = page.locator('#interact-prompt');
  const promptText = async (): Promise<string | null> =>
    prompt.isVisible().then((v) => (v ? prompt.textContent() : null)).catch(() => null);

  await step('turn', async () => {
    await page.keyboard.down('d');
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await page.keyboard.up('d');
    await expect(prompt).toHaveText('[E] Enter ship');
    await page.waitForTimeout(800);
  });
  void (await promptText());

  await step('walk-away', async () => {
    await page.keyboard.down('w');
    const far = await page
      .waitForFunction(
        ({ s, d }: { s: { x: number; z: number }; d: number }) => {
          const p = window.__CHAR__?.pos;
          return p && Math.hypot(p.x - s.x, p.z - s.z) >= d ? p : null;
        },
        { s: { x: start.x, z: start.z }, d: 10 },
        { timeout: 15_000, polling: 100 },
      )
      .then((h) => h.jsonValue());
    await page.keyboard.up('w');
    void far;
    await expect(prompt).toBeHidden({ timeout: 10_000 });
  });

  await step('walk-back', async () => {
    await page.keyboard.down('s');
    const back = await page
      .waitForFunction(
        ({ s, d }: { s: { x: number; z: number }; d: number }) => {
          const p = window.__CHAR__?.pos;
          return p && Math.hypot(p.x - s.x, p.z - s.z) <= d ? p : null;
        },
        { s: { x: start.x, z: start.z }, d: 0.6 },
        { timeout: 15_000, polling: 100 },
      )
      .then((h) => h.jsonValue());
    await page.keyboard.up('s');
    void back;
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    await expect(prompt).toHaveText('[E] Enter ship');
  });
  const promptBeforeE = await promptText();

  // The flaky step — DO NOT throw here; record and always dump.
  await step('re-enter', async () => {
    await page.keyboard.press('e');
    await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  });
  await page.waitForTimeout(1_000);

  const dump = await page.evaluate(({ cs }: { cs: string }) => {
    const w = window as unknown as {
      __msgs?: { dir: string; m: Envelope; t?: number }[];
      __lastShip?: unknown;
      __lastChar?: unknown;
      __CHAR__?: unknown;
      __ePresses?: unknown[];
    };
    const msgs: { dir: string; m: Envelope; t?: number }[] = w.__msgs ?? [];
    const countsByOut: Record<string, number> = {};
    for (const { dir, m } of msgs) if (dir === 'out') countsByOut[m.type] = (countsByOut[m.type] ?? 0) + 1;
    return {
      callsign: cs,
      countsByOut,
      errors: msgs
        .filter((x) => x.dir === 'in' && x.m.type === 'error')
        .map((x) => x.m.payload),
      shipFrames: msgs
        .filter(
          (x) => x.dir === 'out' && (x.m.type === 'enter_ship' || x.m.type === 'exit_ship'),
        )
        .map((x) => ({ type: x.m.type, payload: x.m.payload, t: x.t ?? null })),
      interactFrames: msgs
        .filter((x) => x.dir === 'out' && x.m.type === 'interact')
        .map((x) => x.m.payload),
      lastInputs: msgs
        .filter((x) => x.dir === 'out' && x.m.type === 'input')
        .slice(-8)
        .map((x) => x.m.payload),
      lastShip: w.__lastShip ?? null,
      lastChar: w.__lastChar ?? null,
      dockedIndicatorVisible: !!document.querySelector('#docked-indicator'),
      interactPromptVisible: !!document.querySelector('#interact-prompt'),
      charHook: w.__CHAR__ ?? null,
      ePresses: w.__ePresses ?? [],
    };
  }, { cs: session.callsign });
  fs.writeFileSync(
    `/tmp/entership-dump-${process.env.DUMP_N ?? 'x'}.json`,
    JSON.stringify({ failedStep, promptBeforeE, ...dump }, null, 1),
  );
  console.log(`[DEBUG-ENTER-SHIP] FAILED_STEP=${failedStep}`, JSON.stringify(dump));
  expect(failedStep).toBeNull();
  await context.close();
});
