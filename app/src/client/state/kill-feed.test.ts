import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KILL_FEED_MAX,
  KILL_FEED_TTL_MS,
  __resetKillFeed,
  indexKillFeedEntities,
  indexKillFeedPlayers,
  killFeedEntries,
  killFeedSubscribe,
  pushKillEvent,
  removeKillFeedEntry,
} from './kill-feed';

const T0 = 1_000_000; // a fixed clock base — pushKillEvent takes `now`

afterEach(() => __resetKillFeed());

describe('kill feed state (TASK-47)', () => {
  it('subscribes with an immediate catch-up emit and emits only on change', () => {
    const fn = vi.fn();
    const off = killFeedSubscribe(fn);
    expect(killFeedEntries()).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith([]);

    // Indexing is silent: it only arms later resolution, never emits.
    // Victims resolve from entity batches; killers from the presence roster
    // (ship entities carry no playerId on the wire).
    indexKillFeedEntities([
      { id: 'ship-a', kind: 'ship', callsign: 'Alpha' },
      { id: 'ship-b', kind: 'ship', callsign: 'Bravo' },
    ]);
    indexKillFeedPlayers([
      { playerId: 'pl-a', callsign: 'Alpha' },
      { playerId: 'pl-b', callsign: 'Bravo' },
    ]);
    expect(fn).toHaveBeenCalledTimes(1);

    pushKillEvent('pl-a', 'ship-b', 'laser', T0);
    expect(fn).toHaveBeenCalledTimes(2);
    const entries = killFeedEntries();
    expect(entries).toHaveLength(1);
    expect(entries.at(0)).toMatchObject({ killer: 'Alpha', victim: 'Bravo', weapon: 'laser' });

    off();
    pushKillEvent('pl-a', 'ship-b', 'laser', T0 + 100);
    expect(fn).toHaveBeenCalledTimes(2); // unsubscribed → no more emits
  });

  it('caps the feed at the LAST 5 kills (oldest drops first)', () => {
    for (let i = 0; i < KILL_FEED_MAX + 1; i++) {
      pushKillEvent(`pl-a`, `ship-${i}`, 'laser', T0 + i * 100);
    }
    const entries = killFeedEntries();
    expect(entries).toHaveLength(KILL_FEED_MAX);
    expect(entries[0].victim).toBe('ship-1'); // ship-0 dropped
    expect(entries.at(-1)?.victim).toBe('ship-5');
  });

  it('prunes expired entries at the next push (TTL)', () => {
    pushKillEvent('pl-a', 'ship-old', 'laser', T0);
    pushKillEvent('pl-a', 'ship-new', 'missile', T0 + KILL_FEED_TTL_MS + 1);
    const entries = killFeedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].victim).toBe('ship-new');
  });

  it('resolves the killer via the presence roster and the victim via ship id', () => {
    indexKillFeedEntities([
      { id: 'ship-a', kind: 'ship', callsign: 'Alpha' },
      { id: 'ship-b', kind: 'ship', callsign: 'Bravo' },
    ]);
    indexKillFeedPlayers([{ playerId: 'pl-a', callsign: 'Alpha' }]);
    pushKillEvent('pl-a', 'ship-b', 'missile', T0);
    expect(killFeedEntries()[0]).toMatchObject({ killer: 'Alpha', victim: 'Bravo' });

    // An unindexed id falls back to the raw id (never throws).
    pushKillEvent('pl-ghost', 'ship-ghost', 'laser', T0 + 1000);
    const entries = killFeedEntries();
    expect(entries.at(-1)).toMatchObject({ killer: 'pl-ghost', victim: 'ship-ghost' });
  });

  it('derives pvp from the victim kind: false for ai-ship, true for ship/unindexed', () => {
    indexKillFeedEntities([
      { id: 'ship-b', kind: 'ship', callsign: 'Bravo' },
      { id: 'ai-1', kind: 'ai-ship', callsign: 'Rogue' },
    ]);
    pushKillEvent('pl-a', 'ship-b', 'laser', T0);
    pushKillEvent('pl-a', 'ai-1', 'laser', T0 + 1000);
    pushKillEvent('pl-a', 'unknown-ship', 'laser', T0 + 2000);
    const [pvp, vsAi, unindexed] = killFeedEntries();
    expect(pvp.pvp).toBe(true);
    expect(vsAi.pvp).toBe(false);
    expect(unindexed.pvp).toBe(true); // unindexed victim defaults to pvp
  });

  it('removeKillFeedEntry drops the entry and is a no-op for unknown ids', () => {
    const fn = vi.fn();
    const off = killFeedSubscribe(fn);
    fn.mockClear();
    pushKillEvent('pl-a', 'ship-b', 'laser', T0);
    expect(fn).toHaveBeenCalledTimes(1);

    removeKillFeedEntry(-1); // unknown id → no emit
    expect(fn).toHaveBeenCalledTimes(1);
    expect(killFeedEntries()).toHaveLength(1);

    const id = killFeedEntries()[0].id;
    removeKillFeedEntry(id);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(killFeedEntries()).toEqual([]);
    off();
  });

  it('__resetKillFeed clears state and both indexes', () => {
    indexKillFeedEntities([{ id: 'ship-b', kind: 'ship', callsign: 'Bravo' }]);
    indexKillFeedPlayers([{ playerId: 'pl-a', callsign: 'Alpha' }]);
    pushKillEvent('pl-a', 'ship-b', 'laser', T0);
    __resetKillFeed();
    expect(killFeedEntries()).toEqual([]);
    // The index is gone too: the same kill now resolves to raw ids.
    pushKillEvent('pl-a', 'ship-b', 'laser', T0);
    expect(killFeedEntries()[0]).toMatchObject({ killer: 'pl-a', victim: 'ship-b' });
  });
});
