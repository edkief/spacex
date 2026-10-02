import { describe, expect, it } from 'vitest';

import { MINING_UNIT_MS, stepMiningChannel, type MiningChannel } from './mining';

/**
 * TASK-38 step 1: the pure award math behind the hold-to-mine channel.
 * The AC: a unit is DUE only when the SERVER clock is MINING_UNIT_MS (1.5 s)
 * past the last award — client message rate is irrelevant (anti-spam) — and
 * the grant is one unit through the shared partial-pickup math (the weight
 * cap holds the award as 'full'; the caller keeps lastAwardAt so it lands
 * on the next tick once space frees).
 */

const T0 = 1_000_000;

const channel = (over: Partial<MiningChannel> = {}): MiningChannel => ({
  depositId: 'dep-1',
  unitsSoFar: 0,
  lastAwardAt: T0,
  ...over,
});

describe('stepMiningChannel (the server-clock award math)', () => {
  it('not due before 1.5 s of channeling (spam cannot force the cadence)', () => {
    expect(stepMiningChannel(channel(), T0 + MINING_UNIT_MS - 1, 5, {}, 'iron')).toEqual({
      kind: 'idle',
    });
    // Even far past the first cadence, a FRESH 1.5 s since the last award
    // is still required (the anchor is the last award, not the start).
    expect(stepMiningChannel(channel({ lastAwardAt: T0 + 9_000 }), T0 + 9_000 + 1_499, 5, {}, 'iron')).toEqual({
      kind: 'idle',
    });
  });

  it('due at exactly 1.5 s: one unit lands; depleted flags only the last unit', () => {
    expect(stepMiningChannel(channel(), T0 + MINING_UNIT_MS, 2, {}, 'iron')).toEqual({
      kind: 'awarded',
      stacks: { iron: 1 },
      depleted: false,
    });
    expect(stepMiningChannel(channel(), T0 + MINING_UNIT_MS, 1, {}, 'copper')).toEqual({
      kind: 'awarded',
      stacks: { copper: 1 },
      depleted: true,
    });
  });

  it('an exhausted deposit (0 remaining) is idle — no award past the end', () => {
    expect(stepMiningChannel(channel(), T0 + MINING_UNIT_MS, 0, {}, 'iron')).toEqual({
      kind: 'idle',
    });
  });

  it('any resource type awards its own stacks (the deposit carries the resource)', () => {
    expect(stepMiningChannel(channel(), T0 + MINING_UNIT_MS, 3, { iron: 2 }, 'rare-earth')).toEqual({
      kind: 'awarded',
      stacks: { iron: 2, 'rare-earth': 1 },
      depleted: false,
    });
  });

  it('at the weight cap the due award is HELD as "full" (caller keeps the anchor)', () => {
    // 40 u of iron = the 40 u cap: nothing fits, whatever the resource.
    expect(stepMiningChannel(channel(), T0 + MINING_UNIT_MS, 5, { iron: 40 }, 'copper')).toEqual({
      kind: 'full',
    });
    // 39 u of iron leaves 1 u of room: a 1 u resource fits…
    expect(stepMiningChannel(channel(), T0 + MINING_UNIT_MS, 5, { iron: 39 }, 'copper')).toEqual({
      kind: 'awarded',
      stacks: { iron: 39, copper: 1 },
      depleted: false,
    });
    // …but a 3 u crystal does not (the award is held, not rounded down to 0).
    expect(stepMiningChannel(channel(), T0 + MINING_UNIT_MS, 5, { iron: 39 }, 'crystal')).toEqual({
      kind: 'full',
    });
  });
});
