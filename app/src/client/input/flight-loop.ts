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
 * `InputFrameSender` owns that counter + the send cadence. TASK-104 made
 * the cadence a PURE period: a frame goes out only when
 * INPUT_SEND_PERIOD_MS has elapsed since the last send — the input key
 * NEVER bypasses it. The old key-change bypass was correct for keyboard
 * input (exact ±1/0 values, the key changes only on press/release → a
 * stable 20 msg/s at the bucket's refill rate), but the M7 ANALOG touch
 * sticks (TASK-99/100) write a continuous magnitude on every
 * pointermove — a NEW key every frame — so the bypass streamed 'input'
 * frames at FRAME rate (60-120+ msg/s) into the server's 20 msg/s
 * per-connection bucket and got the socket 4009-kicked on touch devices.
 * DOM-free and clock-injected so the whole cadence is unit-testable.
 */

import type { ShipInput } from '@shared/physics/flight';
import type { Regime } from '@shared/regime';

import { CONTROL_SCHEMES, type ControlScheme } from './controls';

/**
 * Send cadence (ms): the PURE send period (TASK-104). 66 ms ≈ 15.2 msg/s —
 * deliberately UNDER the server's 20 msg/s inbound bucket (TASK-65) so
 * sustained input leaves headroom for fire-intents (the 333 ms fire
 * pacer, ≈3 msg/s) and chat (2 s min gap): worst-case legit traffic is
 * ≈18.2 msg/s < 20. The server's 20 Hz tick absorbs the extra ≤16 ms
 * input latency with no visible change (150 ms latency budget, TASK-14).
 */
export const INPUT_SEND_PERIOD_MS = 66;

/**
 * The shared input-seq + cadence owner. `shouldSend` decides whether a
 * frame goes out this tick and stamps it with the next seq.
 */
export class InputFrameSender {
  private seqValue = 0;
  /**
   * NEGATIVE_INFINITY (not 0): the FIRST call always sends immediately.
   * Load-bearing for the docked 'first input = take-off' contract
   * (TASK-78/86): while wire-docked the loop suppresses zero-demand
   * frames, so lastSendMs goes stale, and the player's first W after
   * docking must go out on the very next frame.
   */
  private lastSendMs = Number.NEGATIVE_INFINITY;

  /** The last seq stamped (0 = nothing sent yet). */
  get seq(): number {
    return this.seqValue;
  }

  /**
   * PURE period (TASK-104): a frame is due only when
   * {@link INPUT_SEND_PERIOD_MS} has elapsed since the last send — the
   * input key never bypasses the cadence (the bypass streamed touch
   * input at frame rate and tripped the 20 msg/s bucket). Returns the
   * NEW seq to stamp on the frame, or null when nothing is due.
   */
  shouldSend(nowMs: number): number | null {
    if (nowMs - this.lastSendMs < INPUT_SEND_PERIOD_MS) return null;
    this.seqValue += 1;
    this.lastSendMs = nowMs;
    return this.seqValue;
  }
}

/** One channel key → its demand, as a stable cadence string. */
export function shipInputKey(input: ShipInput): string {
  return `${input.thrust}|${input.yaw}|${input.pitch}|${input.roll}|${input.up}|${
    input.boost ?? 0
  }`;
}

/** True when the frame carries any real control demand (not the idle frame). */
export function anyFlightDemand(input: ShipInput): boolean {
  return (
    input.thrust !== 0 ||
    input.yaw !== 0 ||
    input.pitch !== 0 ||
    input.roll !== 0 ||
    input.up !== 0 ||
    (input.boost ?? 0) !== 0
  );
}

/**
 * TASK-86: the FLIGHT scheme a wire-docked ship's demand must be read
 * through. A pad-docked ship carries the server flightRegime 'surface',
 * which remaps the keys to the CHARACTER scheme (W = walk) — zero flight
 * demand — so the dock gate (TASK-78) suppressed the very frame the
 * server's "first input = take-off" contract needs. 'surface' maps to the
 * atmosphere scheme (full flight + VTOL lift off the pad); space/atmosphere
 * map to themselves.
 */
export function dockedFlightScheme(regime: Regime): ControlScheme {
  return CONTROL_SCHEMES[regime === 'surface' ? 'atmosphere' : regime];
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
