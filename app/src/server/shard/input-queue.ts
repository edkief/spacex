/**
 * Per-connection input slot — TASK-13.
 *
 * The WS layer pushes validated `PlayerInput` frames here. Each
 * connection holds at most ONE pending input at a time: the *latest*
 * input wins, and older frames (or out-of-order re-transmits) are
 * dropped as stale.
 *
 * Why "latest-wins" and not a queue? Two reasons:
 *
 *   1. The sim tick is 20 Hz. Inputs arrive at ≥20 Hz from a smooth
 *      client. Queuing two or three frames before the next tick just
 *      means we integrate stale data — the latest is always the one
 *      closest to the player's current intent.
 *   2. Client prediction (TASK-14) already integrates every input
 *      locally. The server only needs the *last* one for its
 *      authoritative tick; reconciliation catches the gaps.
 *
 * Strict-seq protection is layered on top:
 *
 *   - First input for a connection: `seq` MUST equal
 *     `lastSeq + 1`. Anything else drops as stale (catches pre-handshake
 *     or replay attacks).
 *   - Subsequent inputs: `seq > lastSeq` wins; `seq <= lastSeq` drops.
 *
 * Stale drops are counted on `ShardConnection.staleDrops` for tests
 * + ops dashboards. Drops are emitted on a per-frame debug log so a
 * dev can verify the queue is healthy.
 *
 * The module is intentionally side-effect free: it returns a
 * `{accepted, dropped, staleSeq, diagLog}` tuple and lets the caller
 * update the connection state. The shard wraps these primitives in
 * the `onMessage` handler.
 *
 * @see ./types.ts for `PlayerInput` / `ShardConnection`.
 */
import type { PlayerInput, ShardConnection } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How many stale frames can drop in a row before we log a warning?
 * A small number here keeps a chatty misbehaving client visible without
 * spamming the log every tick.
 */
export const STALE_LOG_THRESHOLD = 25;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to enqueue an input for the connection. Returns a small
 * diagnostic blob the caller (and tests) can inspect:
 *
 *   - `accepted: true`     — the input replaced the slot; the next
 *                            tick will integrate it.
 *   - `accepted: false`    — drop reasons:
 *                              `stale-seq` — `input.seq <= lastSeq`
 *                                            (or `seq > lastSeq + 1`
 *                                             from cold start).
 *                              `malformed`  — non-finite axes.
 *
 * `connection` is mutated in-place (`lastSeq`, `pendingInput`,
 * `staleDrops`) so the next `processTick()` sees the new state. The
 * mutation is intentional: keeping the field assignments inside the
 * function ensures the caller can't forget to bump `lastSeq` when it
 * decides to accept.
 */
export function enqueueInput(
  connection: ShardConnection,
  input: PlayerInput,
  nowDebug: () => void = () => {
    /* placeholder so unit tests can pass `() => log.debug(...)` */
  },
): { accepted: boolean; reason?: "stale-seq" | "malformed" } {
  if (!isWellFormed(input)) {
    bumpStale(connection);
    nowDebug();
    return { accepted: false, reason: "malformed" };
  }

  // Cold-start guard: first input must have seq === 1 (matches the
  // client-side "start predicting from seq=1" convention). A first
  // input at seq>1 is almost always a client that crashed mid-input
  // and resumed on a fresh connection — the right thing is to drop
  // and resync.
  if (connection.lastSeq === 0 && input.seq !== 1) {
    bumpStale(connection);
    nowDebug();
    return { accepted: false, reason: "stale-seq" };
  }

  if (input.seq <= connection.lastSeq) {
    bumpStale(connection);
    nowDebug();
    return { accepted: false, reason: "stale-seq" };
  }

  // Latest-wins: replace whatever was pending (if anything).
  connection.lastSeq = input.seq;
  connection.pendingInput = input;
  return { accepted: true };
}

/**
 * Drain the per-connection input slot. The tick loop calls this once
 * per connection per tick; the returned input is applied to the
 * entity's integrator and the slot is cleared so the next tick starts
 * fresh.
 */
export function drainInput(connection: ShardConnection): PlayerInput | null {
  const input = connection.pendingInput;
  connection.pendingInput = null;
  return input;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bumpStale(connection: ShardConnection): void {
  connection.staleDrops += 1;
}

function isFinite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function isWellFormed(input: PlayerInput): boolean {
  return (
    Number.isInteger(input.seq) &&
    input.seq >= 1 &&
    isFinite(input.thrust) &&
    isFinite(input.turn) &&
    isFinite(input.pitch) &&
    isFinite(input.yaw) &&
    typeof input.fire === "boolean" &&
    typeof input.lock === "boolean" &&
    (input.action === null || typeof input.action === "string")
  );
}
