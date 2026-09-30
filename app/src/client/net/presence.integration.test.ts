import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeSystemIdForPlayer } from '@shared/galaxy/home';
import { bootServer, freePort, waitReady, type Child } from '@server/server-child';
import { PresenceStore } from './presence';

/**
 * TASK-15 acceptance, over the REAL server (child process, real shards):
 * 3 clients in one system each see exactly the other 2; one leaves → the
 * other two update within 1 s; one joins a different system → not listed.
 * The stores are the actual client PresenceStore fed through the wire.
 */

const SEED = 'task15-presence';
// Two distinct seeded systems (star indices 0 and 1 → different star ids).
const SYS_A = homeSystemIdForPlayer(SEED, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
const SYS_B = homeSystemIdForPlayer(SEED, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

interface Claim {
  callsign: string;
  token: string;
  playerId: string;
  homeSystemId: string;
}

async function claim(base: number, callsign: string): Promise<Claim> {
  const res = await fetch(`http://127.0.0.1:${base}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  if (res.status !== 201) throw new Error(`claim ${callsign} failed: ${res.status}`);
  return (await res.json()) as Claim;
}

/**
 * A live peer: real WS connection, real PresenceStore. `enter_system`
 * snapshots and presence events feed the store exactly like the browser
 * does (main.tsx wiring).
 */
class Peer {
  readonly store = new PresenceStore();
  readonly ws: WebSocket;
  closed = false;
  private pending: Array<(s: unknown) => void> = [];

  constructor(
    readonly base: number,
    readonly claim: Claim,
  ) {
    this.ws = new WebSocket(`ws://127.0.0.1:${base}/ws`);
    this.store.setSelf(claim);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { type: string; payload: any };
      if (msg.type === 'enter_system') {
        // The store excludes self on its own (like the browser wiring).
        this.store.applySnapshot(msg.payload.snapshot.players as any[]);
        this.pending.shift()?.(msg.payload.snapshot);
      } else if (msg.type === 'presence') {
        if (msg.payload.event === 'join') this.store.presenceJoin(msg.payload.player);
        else this.store.presenceLeave(msg.payload.player);
      }
    });
    this.ws.on('close', () => (this.closed = true));
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ v: 1, type: 'hello', payload: { v: 1 } }));
      this.ws.send(JSON.stringify({ v: 1, type: 'auth', payload: { token: this.claim.token } }));
    });
  }

  async join(systemId: string): Promise<void> {
    // Works for both first join (socket still opening) and system switches.
    await new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`${this.claim.callsign}: open timeout`)),
        8000,
      );
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.claim.callsign}: enter_system timeout`)),
        8000,
      );
      this.ws.send(JSON.stringify({ v: 1, type: 'join_system', payload: { systemId } }));
      this.pending.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // wait until the enter_system answer actually landed in the store
    // (the enter_system handler applies the snapshot to the store BEFORE it
    // resolves the pending join, so no extra store-wait is needed here)
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** Polls `fn` until it returns true or the deadline passes. */
async function until(fn: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('TASK-15 presence over the live server', () => {
  let child: Child;
  let base: number;
  let dbDir: string;

  beforeAll(async () => {
    base = await freePort();
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-it-'));
    child = bootServer({ base, dbPath: path.join(dbDir, 'drift.db'), galaxySeed: SEED });
    await waitReady(child);
  }, 90_000);

  afterAll(async () => {
    child.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dbDir, { recursive: true, force: true });
  }, 15_000);

  it('3 clients see exactly the other 2; a leaver drops within 1 s; a system switch is not listed', async () => {
    const suffix = Date.now().toString(36);
    const a = new Peer(base, await claim(base, `presA${suffix}`));
    const b = new Peer(base, await claim(base, `presB${suffix}`));
    const c = new Peer(base, await claim(base, `presC${suffix}`));
    const callsigns = [a.claim.callsign, b.claim.callsign, c.claim.callsign];
    const stores = [a.store, b.store, c.store];
    const othersOf = (i: number) => callsigns.filter((_, j) => j !== i);
    const list = (s: PresenceStore) => s.otherPlayers.map((p) => p.callsign).sort();

    // --- all three join SYS_A -------------------------------------------
    await a.join(SYS_A);
    await b.join(SYS_A);
    await c.join(SYS_A);
    for (let i = 0; i < 3; i++) {
      await until(
        () => JSON.stringify(list(stores[i])) === JSON.stringify([...othersOf(i)].sort()),
        `client ${i} sees exactly the other 2 in ${SYS_A}`,
      );
    }
    // Each list has EXACTLY two entries (not three, not one).
    for (const s of stores) expect(s.otherPlayers).toHaveLength(2);

    // --- C leaves: A and B must update within 1 s ------------------------
    const seen = new Map<PresenceStore, number>();
    const offs = stores.map((s) =>
      s.subscribe(() => {
        if (!s.otherPlayers.some((p) => p.callsign === c.claim.callsign)) {
          seen.set(s, Date.now());
        }
      }),
    );
    const tLeave = Date.now();
    c.close();
    await until(() => seen.size >= 2, 'both remaining peers dropped the leaver');
    for (const [s, at] of seen) {
      expect(at - tLeave, `${s.selfPlayer?.callsign} update latency`).toBeLessThan(1000);
    }
    offs.forEach((off) => off());
    await until(
      () => list(a.store).length === 1 && list(b.store).length === 1,
      'A and B now list only each other',
    );
    expect(list(a.store)).toEqual([b.claim.callsign]);
    expect(list(b.store)).toEqual([a.claim.callsign]);

    // --- B joins SYS_B: A no longer lists B ------------------------------
    const bSeenAt: { at: number } = { at: 0 };
    const offA = a.store.subscribe(() => {
      if (!a.store.otherPlayers.some((p) => p.callsign === b.claim.callsign))
        bSeenAt.at = Date.now();
    });
    const tSwitch = Date.now();
    await b.join(SYS_B);
    await until(() => bSeenAt.at > 0, 'A dropped B after the system switch');
    expect(bSeenAt.at - tSwitch, 'switch visibility latency').toBeLessThan(1000);
    offA();

    // A is now alone in SYS_A; B is alone in SYS_B (not listed anywhere).
    expect(list(a.store)).toEqual([]);
    expect(list(b.store)).toEqual([]);
    expect(b.store.occupancy).toBe(1);

    a.close();
    b.close();
  }, 60_000);
});
