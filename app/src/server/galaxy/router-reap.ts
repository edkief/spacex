import { Shard } from '../shard/shard';
import { persistService } from '../persist';

export async function reapEmpty(systemId: string, shard: Shard): Promise<void> {
  // 1. Flush all ships to DB
  await persistService.onShardShutdown(systemId, shard);

  // 2. Stop simulation
  shard.stop();

  // 3. Emit empty presence frame if needed (handled by Router)
}
