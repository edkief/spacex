/**
 * TASK-73: the shared input plumbing for the ship + on-foot prediction
 * loops.
 *
 * ONE monotonic seq per connection: the server drops any 'input' frame
 * with `seq <= conn.lastSeq` PER CONNECTION (shard.enqueueInput), and the
 * same message type drives the ship or the character — so the ship loop
 * and the on-foot loop must share ONE counter (the old `charSeqRef`).
 * Disembark / re-entry must never reset it, or a frame in flight from the
 * previous regime arrives as stale and is silently dropped.
 *
 * `InputFrameSender` owns that counter + the send cadence (a frame goes
 * out on key CHANGE or at 20 Hz while held — the same rule the on-foot
 * loop shipped with in TASK-32). DOM-free and clock-injected so the whole
 * cadence is unit-testable.
 */

import type { ShipInput } from '@shared/physics/flight';

/** Send cadence (ms): 20 Hz while a held frame stays unchanged. */
export const INPUT_SEND_PERIOD_MS = 50;

/**
 * The shared input-seq + cadence owner. `shouldSend` decides whether a
 * frame goes out this tick and stamps it with the next seq.
 */
export class InputFrameSender {
  private seqValue = 0;
  private lastKey = '';
  private lastSendMs = 0;

  /** The last seq stamped (0 = nothing sent yet). */
  get seq(): number {
    return this.seqValue;
  }

  /**
   * A frame is due when the input KEY changed or the last send is at least
   * {@link INPUT_SEND_PERIOD_MS} old (held-frame cadence). Returns the NEW
   * seq to stamp on the frame, or null when nothing is due.
   */
  shouldSend(nowMs: number, key: string): number | null {
    if (key === this.lastKey && nowMs - this.lastSendMs < INPUT_SEND_PERIOD_MS) return null;
    this.seqValue += 1;
    this.lastKey = key;
    this.lastSendMs = nowMs;
    return this.seqValue;
  }
}

/** One channel key → its demand, as a stable cadence string. */
export function shipInputKey(input: ShipInput): string {
  return `${input.thrust}|${input.yaw}|${input.pitch}|${input.roll}|${input.up}`;
}

const EMPTY_PRESSED: ReadonlySet<string> = new Set();

/**
 * The pressed set the FLIGHT loop reads: the star chart open never flies
 * the ship — the effective set is empty (the loop then sends a coast
 * frame on the key change, stopping any held thrust). The captured set is
 * never mutated: the keys are still physically held and resume when the
 * chart closes. (Typing in chat is already excluded upstream by the key
 * capture — the same rules as the on-foot capture.)
 */
export function effectiveFlightPressed(
  pressed: ReadonlySet<string>,
  opts: { chartOpen: boolean },
): ReadonlySet<string> {
  return opts.chartOpen ? EMPTY_PRESSED : pressed;
}
