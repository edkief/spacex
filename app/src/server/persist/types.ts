import type { ShipClassId } from '@shared/ships/ids.ts';
import type { Livery, Position, Velocity } from '../db/json.ts';
import type { ShipState } from '../db/schema.ts';
import type { CargoItem, NodeState, Ship } from '../db/types.ts';
import type { Scheduler } from './scheduler.ts';

/** A ship's live, in-memory state as the shard sees it; what save points snapshot. */
export interface LiveShip {
  shipId: string;
  classId: ShipClassId;
  hull: number;
  shields: number;
  position: Position;
  velocity: Velocity;
  state: ShipState;
  livery?: Livery;
  /** Omit to leave the stored hold untouched; unchanged holds are not rewritten. */
  cargo?: readonly CargoItem[];
}

/** Everything a shard needs to spawn a system: persisted ships (with holds) and node state. */
export interface SystemState {
  systemId: string;
  ships: (Ship & { cargo: CargoItem[] })[];
  nodeStates: NodeState[];
}

/** Outcome of one flush. */
export interface FlushResult {
  ships: number;
  nodes: number;
  durationMs: number;
}

export interface PersistOptions {
  /** Interval for saving dirty ships (default 5000 ms). */
  intervalMs?: number;
  /** Timer source (default: real timers). */
  scheduler?: Scheduler;
  /** Monotonic millisecond clock used for flush timings (default: performance.now). */
  clock?: () => number;
  /** Called with failures of background flushes and with dropped (missing) ships. */
  onError?: (error: unknown) => void;
}
