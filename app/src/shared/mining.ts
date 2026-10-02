/**
 * Mining channel contract (TASK-38) — the pure, server-clock math behind
 * hold-to-mine: one ore unit per MINING_UNIT_MS (1.5 s) of channeling.
 *
 * The anti-spam core: a unit is DUE only when the SERVER clock is
 * MINING_UNIT_MS past the last award. Client messages (mine-start /
 * mine-tick / mine-stop) only assert intent — any rate of them changes
 * nothing. The award reuses the shared partial-pickup math (TASK-34), so
 * the weight cap pauses the channel with 'full' (held until space frees).
 */

import { pickupInto, type InventoryStacks, type ResourceId } from './inventory';

/** Channel cadence (ms): one unit of ore per 1.5 s of channeling (AC-pinned). */
export const MINING_UNIT_MS = 1500;

/** One active mining channel (shard-owned, keyed by playerId). */
export interface MiningChannel {
  /** The deposit being mined (the channel dies if it despawns). */
  depositId: string;
  /** Units already awarded in this channel (the client's ore counter). */
  unitsSoFar: number;
  /** Server clock (ms) of the last award — the cadence anchor (start = first). */
  lastAwardAt: number;
}

/** One tick's outcome for an active channel. */
export type MiningStep =
  /** Not due yet — client spam can never force the cadence. */
  | { kind: 'idle' }
  /** Due, but the weight cap holds it: PAUSED, retried on the next tick. */
  | { kind: 'full' }
  /** Due and awarded: the caller applies (deposit −1, inventory +1, persist). */
  | { kind: 'awarded'; stacks: InventoryStacks; depleted: boolean };

/**
 * Advance one channel by one tick (AC: the server enforces the channel
 * timing): the award is due only when `nowMs − lastAwardAt ≥ MINING_UNIT_MS`
 * AND the deposit still has remaining; the grant is one unit through the
 * shared partial-pickup math (at the weight cap `pickupInto` takes 0 →
 * 'full'; the caller does NOT advance lastAwardAt, so the held award lands
 * on the next tick once space frees). 'depleted' flags the last unit —
 * the deposit despawns at zero remaining. Pure: the shard applies the
 * effects (decrement / inventory / persist / despawn).
 */
export function stepMiningChannel(
  channel: MiningChannel,
  nowMs: number,
  depositRemaining: number,
  stacks: InventoryStacks,
  resourceId: ResourceId,
): MiningStep {
  if (nowMs - channel.lastAwardAt < MINING_UNIT_MS) return { kind: 'idle' };
  if (depositRemaining < 1) return { kind: 'idle' };
  const res = pickupInto(stacks, resourceId, 1);
  if (res.taken < 1) return { kind: 'full' };
  return { kind: 'awarded', stacks: res.stacks, depleted: depositRemaining - 1 < 1 };
}
