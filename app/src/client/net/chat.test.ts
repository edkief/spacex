import { describe, expect, it } from 'vitest';
import { ChatStore } from '@client/net/chat';
import { CHAT_HISTORY_MAX } from '@shared/chat';
import type { ChatMessage } from '@shared/protocol/schemas';

function msg(from: string, i: number): ChatMessage {
  return { from, text: `msg ${i}`, ts: 1_767_225_600_000 + i };
}

/**
 * TASK-16: client chat log — 100-message ring buffer, snapshot seeding,
 * system-change watermark (stale frames from the old system are dropped),
 * emit-only-on-change.
 */
describe('ChatStore', () => {
  it('appends messages and emits', () => {
    const store = new ChatStore();
    let emits = 0;
    store.subscribe(() => emits++);
    store.append(msg('a', 1));
    store.append(msg('b', 2));
    expect(store.entries.map((m) => m.text)).toEqual(['msg 1', 'msg 2']);
    expect(emits).toBe(2);
  });

  it('keeps only the last 100 messages (ring buffer)', () => {
    const store = new ChatStore();
    for (let i = 1; i <= CHAT_HISTORY_MAX + 5; i++) store.append(msg('a', i));
    expect(store.size).toBe(CHAT_HISTORY_MAX);
    expect(store.entries[0].text).toBe('msg 6');
    expect(store.entries[store.size - 1].text).toBe(`msg ${CHAT_HISTORY_MAX + 5}`);
  });

  it('loadSnapshot replaces the log (enter_system seeding / system change)', () => {
    const store = new ChatStore();
    store.append(msg('old', 1));
    store.loadSnapshot([msg('a', 10), msg('b', 11)]);
    expect(store.entries.map((m) => m.text)).toEqual(['msg 10', 'msg 11']);
    store.loadSnapshot([]); // fresh shard: cleared on system change
    expect(store.size).toBe(0);
  });

  it('drops frames older than the last system change (watermark)', () => {
    const store = new ChatStore();
    store.append(msg('oldsys', 1)); // ts = base+1
    store.loadSnapshot([]);
    // A late frame from the OLD system (ts before the switch) must not
    // resurrect into the new log; a fresh one must.
    store.append(msg('oldsys', 1));
    expect(store.size).toBe(0);
    const fresh = msg('newsys', Math.floor(Date.now() / 1000) * 1000 + 50);
    store.append(fresh);
    expect(store.size).toBe(1);
  });

  it('unsubscribe stops emits', () => {
    const store = new ChatStore();
    let emits = 0;
    const off = store.subscribe(() => emits++);
    off();
    store.append(msg('a', 1));
    expect(emits).toBe(0);
  });
});
