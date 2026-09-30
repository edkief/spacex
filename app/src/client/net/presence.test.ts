import { describe, expect, it } from 'vitest';
import type { PresenceEntry } from '@shared/protocol/schemas';
import { PresenceStore } from './presence';

const ME = { playerId: 'p-me', callsign: 'drifter' };
const ALICE: PresenceEntry = { playerId: 'p-a', callsign: 'alice', shipId: 's-a' };
const BOB: PresenceEntry = { playerId: 'p-b', callsign: 'bob' };
const CY: PresenceEntry = { playerId: 'p-c', callsign: 'cy' };

function clock(): { now: number; fn: () => number } {
  const t = { now: 1000 };
  return {
    fn: () => t.now,
    get now() {
      return t.now;
    },
    set now(v: number) {
      t.now = v;
    },
  };
}

describe('PresenceStore', () => {
  it('applies a snapshot: lists others, excludes self, tracks lastSeen', () => {
    const t = clock();
    const store = new PresenceStore(t.fn);
    store.setSelf(ME);
    store.applySnapshot([ME, ALICE, BOB]);

    expect(store.otherPlayers.map((p) => p.callsign)).toEqual(['alice', 'bob']);
    expect(store.selfPlayer?.callsign).toBe('drifter');
    expect(store.occupancy).toBe(3);
    expect(store.otherPlayers[0].lastSeen).toBe(1000);
  });

  it('does not re-emit when the snapshot is unchanged (no re-render per snapshot)', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    let changes = 0;
    store.subscribe(() => changes++);

    store.applySnapshot([ME, ALICE, BOB]);
    const after = changes;
    // 10 Hz snapshots with identical content must stay silent
    for (let i = 0; i < 10; i++) store.applySnapshot([ME, ALICE, BOB]);
    expect(changes).toBe(after);
  });

  it('emits when a snapshot actually differs', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    let changes = 0;
    store.subscribe(() => changes++);
    store.applySnapshot([ALICE]);
    expect(changes).toBe(1);
    store.applySnapshot([ALICE, BOB]);
    expect(changes).toBe(2);
  });

  it('presenceJoin adds a peer and emits a join toast (exactly once per change)', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    const toasts: string[] = [];
    store.onToast((t) => toasts.push(`${t.kind}:${t.callsign}`));
    let changes = 0;
    store.subscribe(() => changes++);

    store.presenceJoin(ALICE);
    expect(store.otherPlayers.map((p) => p.callsign)).toEqual(['alice']);
    expect(store.occupancy).toBe(2);
    expect(toasts).toEqual(['join:alice']);
    expect(changes).toBe(1);
  });

  it('never lists self even if the server sends its own join', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    store.presenceJoin(ME);
    expect(store.otherPlayers).toHaveLength(0);
  });

  it('presenceLeave removes the peer, emits a leave toast, and toasts unknown leavers', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    const toasts: string[] = [];
    store.onToast((t) => toasts.push(`${t.kind}:${t.callsign}`));
    store.applySnapshot([ALICE, BOB]);
    toasts.length = 0;

    store.presenceLeave(ALICE);
    expect(store.otherPlayers.map((p) => p.callsign)).toEqual(['bob']);
    expect(toasts).toEqual(['leave:alice']);

    // A leave for someone we never saw still toasts (the peer left, full stop).
    store.presenceLeave({ playerId: 'p-x', callsign: 'ghost' });
    expect(toasts).toEqual(['leave:alice', 'leave:ghost']);
    expect(store.otherPlayers.map((p) => p.callsign)).toEqual(['bob']);
  });

  it('reconnected() fires a reconnected toast and leaves the list untouched (TASK-17)', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    store.applySnapshot([ALICE, BOB]);
    const toasts: string[] = [];
    let changes = 0;
    store.onToast((t) => toasts.push(`${t.kind}:${t.callsign}`));
    store.subscribe(() => changes++);

    store.reconnected();
    expect(toasts).toEqual(['reconnected:drifter']);
    expect(changes).toBe(0); // no presence change emit
    expect(store.otherPlayers.map((p) => p.callsign)).toEqual(['alice', 'bob']);
  });

  it('updates lastSeen on events (kept for a future latency display)', () => {
    const t = clock();
    const store = new PresenceStore(t.fn);
    store.setSelf(ME);
    store.presenceJoin(ALICE);
    t.now += 250;
    store.applySnapshot([ALICE]); // unchanged content → no emit, but seen again
    t.now += 500;
    store.presenceJoin(ALICE); // re-join (returned within grace) refreshes
    expect(store.otherPlayers[0].lastSeen).toBe(1750);
  });

  it('leaveAll empties the list (system change) and emits once', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    let changes = 0;
    store.subscribe(() => changes++);
    store.applySnapshot([ALICE, BOB]);
    store.leaveAll();
    expect(store.otherPlayers).toHaveLength(0);
    expect(store.occupancy).toBe(1);
    expect(changes).toBe(2);
    // leaveAll on an empty store is a no-op
    store.leaveAll();
    expect(changes).toBe(2);
  });

  it('snapshot after leaveAll rebuilds the list for the new system', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    store.applySnapshot([ALICE]);
    store.leaveAll();
    store.applySnapshot([CY]);
    expect(store.otherPlayers.map((p) => p.callsign)).toEqual(['cy']);
  });

  it('keeps the optional onFoot flag once it arrives on the wire (TASK-36)', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    // The flag is optional in v1; the store must carry it through when present.
    store.applySnapshot([{ playerId: 'p-c', callsign: 'cy', onFoot: true } as never]);
    expect(store.otherPlayers[0].onFoot).toBe(true);
  });

  it('unsubscribes stop receiving events', () => {
    const store = new PresenceStore();
    store.setSelf(ME);
    let changes = 0;
    const off = store.subscribe(() => changes++);
    off();
    store.presenceJoin(ALICE);
    expect(changes).toBe(0);
    expect(store.otherPlayers).toHaveLength(1);
  });
});
