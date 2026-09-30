import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientSession, type ClaimedSession, type ConnectionState } from './session';
import { encodeMessage, PROTOCOL_VERSION } from '@shared/protocol';
import type { StateSnapshot } from '@shared/protocol/schemas';

/**
 * TASK-17 client-side reconnect: scripted fake WebSocket + fake timers.
 * Covers the auto-retry loop (exponential backoff with cap), the resync
 * snapshot (reconnect=true), the 'lost' patience window, retryNow(), and
 * the deliberate-close / initial-failure no-retry paths.
 */

interface FakeWs {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  sent: string[];
  closedWith: number | null;
  send(data: string): void;
  close(code?: number): void;
}

function makeHarness() {
  const sockets: FakeWs[] = [];
  const wsFactory = (): WebSocket => {
    const ws: FakeWs = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      sent: [],
      closedWith: null,
      send(data) {
        this.sent.push(data);
      },
      close(code) {
        this.closedWith = code ?? 1000;
        this.readyState = 3;
        this.onclose?.({ code: this.closedWith });
      },
    };
    sockets.push(ws);
    return ws as unknown as WebSocket;
  };
  const open = (i: number): void => {
    sockets[i].readyState = 1;
    sockets[i].onopen?.();
  };
  const deliver = (i: number, type: string, payload: unknown): void => {
    sockets[i].onmessage?.({ data: encodeMessage(type as never, payload as never) });
  };
  /** Server-side / network drop (NOT a session.close() call). */
  const drop = (i: number, code = 1006): void => {
    sockets[i].readyState = 3;
    sockets[i].onclose?.({ code });
  };
  return { sockets, wsFactory, open, deliver, drop };
}

const session: ClaimedSession = {
  token: 'tok-1',
  playerId: 'p1',
  callsign: 'Testy',
  homeSystemId: 'sys1',
};

const snapshotFor = (systemId: string): StateSnapshot => ({
  systemId,
  entities: [],
  nodes: [],
  chat: [],
  players: [],
});

/** Small backoff values so the 30 s patience window is reachable quickly. */
const RETRY = { baseMs: 10, capMs: 40, giveUpMs: 300 };

/** Boot a session: dial, open, join, receive the initial snapshot. */
async function boot(h: ReturnType<typeof makeHarness>, session_: ClientSession): Promise<void> {
  const pending = session_.connect();
  h.open(0);
  await pending;
  const joinPending = session_.joinSystem('sys1');
  h.deliver(0, 'enter_system', { snapshot: snapshotFor('sys1') });
  await joinPending;
}

describe('ClientSession reconnect and resync (TASK-17)', () => {
  let states: ConnectionState[];

  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mkSession(h: ReturnType<typeof makeHarness>): ClientSession {
    return new ClientSession('ws://test', session, {
      wsFactory: h.wsFactory,
      onState: (s) => states.push(s),
      retry: RETRY,
    });
  }

  it('retries on the next second and resyncs with reconnect=true', async () => {
    const h = makeHarness();
    const snapshots: Array<{ systemId: string; reconnect: boolean }> = [];
    const s = new ClientSession('ws://test', session, {
      wsFactory: h.wsFactory,
      onState: (st) => states.push(st),
      onSnapshot: (snap, reconnect) => snapshots.push({ systemId: snap.systemId, reconnect }),
      retry: RETRY,
    });
    await boot(h, s);
    expect(states).toEqual(['connecting', 'connected']);
    expect(snapshots).toEqual([{ systemId: 'sys1', reconnect: false }]);

    // Network drop: state flips to reconnecting; no dial yet (backoff)…
    h.drop(0, 1006);
    expect(s.connectionState).toBe('reconnecting');
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(9);
    expect(h.sockets).toHaveLength(1);
    // …then the retry dials and AUTO-JOINS the same system.
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(2);
    h.open(1); // onopen: hello + auth + auto-join of the SAME system
    expect(JSON.parse(String(h.sockets[1].sent.at(-1)))).toMatchObject({
      type: 'join_system',
      payload: { systemId: 'sys1' },
    });
    h.deliver(1, 'enter_system', { snapshot: snapshotFor('sys1') });
    expect(snapshots.at(-1)).toEqual({ systemId: 'sys1', reconnect: true });
    expect(s.connectionState).toBe('connected');
    expect(states).toContain('reconnecting');
  });

  it('backs off with a cap, reports lost after the patience window, retryNow recovers', async () => {
    const h = makeHarness();
    const s = mkSession(h);
    await boot(h, s);
    states.length = 0;

    // Server keeps refusing: each retry opens and is immediately dropped.
    // Delays: 10, 20, 40, then capped at 40 (80 → 40).
    h.drop(0, 1006);
    vi.advanceTimersByTime(10);
    h.open(1);
    h.drop(1, 1006);
    vi.advanceTimersByTime(20);
    h.open(2);
    h.drop(2, 1006);
    vi.advanceTimersByTime(40);
    h.open(3);
    h.drop(3, 1006);
    vi.advanceTimersByTime(40); // 4th attempt: capped (base×2³=80 → cap 40)
    expect(h.sockets).toHaveLength(5);
    expect(s.connectionState).toBe('reconnecting');

    // Keep failing until the down-stretch outgrows the patience window:
    // the state becomes 'lost' (the overlay), retries still scheduled.
    for (let i = 4; s.connectionState !== 'lost' && i < 20; i++) {
      vi.advanceTimersByTime(40);
      h.open(i);
      h.drop(i, 1006);
    }
    expect(s.connectionState).toBe('lost');

    // retryNow(): dials IMMEDIATELY (no backoff wait) and recovers.
    const before = h.sockets.length;
    s.retryNow();
    expect(h.sockets).toHaveLength(before + 1);
    h.open(h.sockets.length - 1);
    h.deliver(h.sockets.length - 1, 'enter_system', { snapshot: snapshotFor('sys1') });
    expect(s.connectionState).toBe('connected');
  });

  it('a refused rejoin (error frame during auto-join) drops the socket and retries', async () => {
    const h = makeHarness();
    const s = mkSession(h);
    await boot(h, s);
    h.drop(0, 1006);
    vi.advanceTimersByTime(10);
    h.open(1);
    // The rejoin is refused (e.g. system-full): the session drops its own
    // socket so the close path schedules the next backoff attempt.
    h.deliver(1, 'error', { code: 'system-full', message: 'system is full' });
    expect(h.sockets[1].closedWith).toBe(1000);
    vi.advanceTimersByTime(20);
    expect(h.sockets).toHaveLength(3);
    // Next attempt succeeds.
    h.open(2);
    h.deliver(2, 'enter_system', { snapshot: snapshotFor('sys1') });
    expect(s.connectionState).toBe('connected');
  });

  it('a deliberate close() never auto-retries', async () => {
    const h = makeHarness();
    const s = mkSession(h);
    await boot(h, s);
    s.close();
    vi.advanceTimersByTime(10_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('an initial connect failure is the caller error path (no auto-retry)', async () => {
    const h = makeHarness();
    const s = mkSession(h);
    const pending = s.connect().catch((err: Error) => err);
    // Socket dies before it ever opens (server down on first contact).
    h.sockets[0].readyState = 3;
    h.sockets[0].onerror?.();
    h.drop(0, 1006);
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(s.connectionState).toBe('closed');
    vi.advanceTimersByTime(10_000);
    expect(h.sockets).toHaveLength(1); // no retry dial
  });

  it('send() is a no-op while the socket is down', async () => {
    const h = makeHarness();
    const s = mkSession(h);
    const pending = s.connect();
    h.open(0);
    await pending;
    const payload = { seq: 1, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false };
    s.send('input', payload); // socket open → delivered
    expect(h.sockets[0].sent.at(-1)).toBe(encodeMessage('input', payload));
    const before = h.sockets[0].sent.length;
    h.drop(0, 1006);
    s.send('input', { ...payload, seq: 2 }); // down → dropped, no throw
    expect(h.sockets[0].sent).toHaveLength(before);
  });

  it('fires hello + auth (with the claimed token) on every dial', async () => {
    const h = makeHarness();
    const s = mkSession(h);
    await boot(h, s);
    h.drop(0, 1006);
    vi.advanceTimersByTime(10);
    h.open(1);
    const frames = h.sockets[1].sent.map((f) => JSON.parse(String(f)) as { type: string });
    expect(frames.map((f) => f.type)).toEqual(['hello', 'auth', 'join_system']);
    expect(JSON.parse(String(h.sockets[1].sent[0]))).toMatchObject({
      v: PROTOCOL_VERSION,
      type: 'hello',
    });
  });
});

/**
 * TASK-8: warpTo over a scripted socket. The optimistic lastSystemId commit
 * (reconnect mid-warp targets the DESTINATION), the warp_arrived resolution
 * (full-boot onSnapshot path), the server-rejection rollback to the source,
 * and the close-mid-warp rejection.
 */
describe('ClientSession warpTo (TASK-8)', () => {
  const session2: ClaimedSession = { ...session, homeSystemId: 'sys1' };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mkWarpSession(h: ReturnType<typeof makeHarness>) {
    const snapshots: Array<{ systemId: string; reconnect: boolean }> = [];
    const s = new ClientSession('ws://test', session2, {
      wsFactory: h.wsFactory,
      onSnapshot: (snap, reconnect) => snapshots.push({ systemId: snap.systemId, reconnect }),
      retry: RETRY,
    });
    return { s, snapshots };
  }

  function warpAnd(h: ReturnType<typeof makeHarness>, s: ClientSession, to: string) {
    const pending = s.warpTo(to);
    return { pending, frame: h.sockets[0].sent.at(-1) };
  }

  it('sends the warp frame and resolves with the warp_arrived snapshot (full-boot path)', async () => {
    const h = makeHarness();
    const { s, snapshots } = mkWarpSession(h);
    await boot(h, s);
    snapshots.length = 0;

    const { pending, frame } = warpAnd(h, s, 'sys2');
    expect(frame).toBe(encodeMessage('warp', { destinationSystemId: 'sys2' }));

    h.deliver(0, 'warp_arrived', { systemId: 'sys2', snapshot: snapshotFor('sys2') });
    await expect(pending).resolves.toEqual(snapshotFor('sys2'));
    expect(snapshots).toEqual([{ systemId: 'sys2', reconnect: false }]);

    // A drop after arrival reconnects into the destination.
    h.drop(0, 1006);
    vi.advanceTimersByTime(10);
    h.open(1);
    const frames = h.sockets[1].sent.map((f) => JSON.parse(String(f)) as { type: string });
    expect(frames.map((f) => f.type)).toEqual(['hello', 'auth', 'join_system']);
  });

  it('server rejection: rejects with WarpRejectedError and rolls the reconnect target back', async () => {
    const h = makeHarness();
    const { s } = mkWarpSession(h);
    await boot(h, s);

    const { pending } = warpAnd(h, s, 'sys2');
    h.deliver(0, 'error', { code: 'system-full', message: 'system sys2 is full (16 players)' });
    await expect(pending).rejects.toMatchObject({
      name: 'WarpRejectedError',
      code: 'system-full',
    });

    // Optimistic commit rolled back: a drop now reconnects into the SOURCE.
    h.drop(0, 1006);
    vi.advanceTimersByTime(10);
    h.open(1);
    const joinFrame = h.sockets[1].sent
      .map((f) => JSON.parse(String(f)) as { type: string; payload?: { systemId?: string } })
      .find((f) => f.type === 'join_system');
    expect(joinFrame?.payload?.systemId).toBe('sys1');
  });

  it('close mid-warp: the pending warp rejects (optimistic commit stands)', async () => {
    const h = makeHarness();
    const { s } = mkWarpSession(h);
    await boot(h, s);

    const { pending } = warpAnd(h, s, 'sys2');
    h.drop(0, 1006);
    await expect(pending).rejects.toThrow(/connection closed/);

    // The commit stands: the retry re-joins the DESTINATION (the server
    // either completed the move or the row still homes the re-adopt).
    vi.advanceTimersByTime(10);
    h.open(1);
    const joinFrame = h.sockets[1].sent
      .map((f) => JSON.parse(String(f)) as { type: string; payload?: { systemId?: string } })
      .find((f) => f.type === 'join_system');
    expect(joinFrame?.payload?.systemId).toBe('sys2');
  });

  it('warpTo without an active system rejects', async () => {
    const h = makeHarness();
    const { s } = mkWarpSession(h);
    await expect(s.warpTo('sys2')).rejects.toThrow(/no active system/);
    expect(h.sockets).toHaveLength(0); // nothing was ever dialed
  });
});
