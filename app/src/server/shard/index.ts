/** TASK-13: the authoritative per-system simulation (20 Hz tick, 10 Hz snapshots). */
export {
  SystemShard,
  inputToShipInput,
  entityToState,
  TICK_DT_MS,
  SNAPSHOT_EVERY_TICKS,
  SNAPSHOT_WARN_BYTES,
} from './shard';
export { SimLoop } from './sim';
export { TickHistogram } from './histogram';
export { TerrainContext } from './terrain';
export {
  createShardPersist,
  startShardFlushTimer,
  validRegime,
  type FlushSummary,
  type LoadedWreck,
  type ShardPersist,
  type ShipsLoad,
} from './persist';
export type { ConnState, Shard, ShardLogger, SimEntity } from './types';
