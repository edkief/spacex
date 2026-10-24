import { Shard } from './shard';

export class ShardManager {
  private shards = new Map<string, Shard>();

  getShard(systemId: string): Shard {
    let shard = this.shards.get(systemId);
    if (!shard) {
      shard = new Shard(systemId);
      this.shards.set(systemId, shard);
      shard.start();
      console.log(`Started shard for system ${systemId}`);
    }
    return shard;
  }

  stopAll() {
    for (const shard of this.shards.values()) {
      shard.stop();
    }
    this.shards.clear();
  }
}

export const shardManager = new ShardManager();
