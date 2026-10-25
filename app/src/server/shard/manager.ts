import { Shard } from './shard';
import { repo } from '../db/repo';
import { ServerShipState } from './types';

export class ShardManager {
  private shards = new Map<string, Shard>();

  async getShard(systemId: string): Promise<Shard> {
    let shard = this.shards.get(systemId);
    if (!shard) {
      // Load state from DB
      const { ships } = await repo.loadSystemState(systemId);

      const seed = process.env.GALAXY_SEED || 'DRIFT-SEED-DEFAULT';
      shard = new Shard(systemId, seed);

      // Initialize entities from saved state
      console.log(`Loading ships for system ${systemId}...`);
      for (const ship of ships) {
        console.log(`Loading ship ${ship.id} (state: ${ship.state})`);
        shard.entities.set(ship.id, {
          id: ship.id,
          kind: ship.state === 'destroyed' ? 'wreck' : 'ship',
          pos: JSON.parse(ship.position),
          vel: JSON.parse(ship.velocity),
          quat: JSON.parse(ship.quat),
          regime: ship.regime,
          hull: ship.hull,
          shields: ship.shields,
          destroyed: ship.state === 'destroyed',
          classId: ship.class_id,
          targetId: null,
          wreckExpiresAt: ship.wreck_expires_at ? ship.wreck_expires_at.getTime() : undefined,
        } as ServerShipState);
      }
      console.log(`Loaded ${ships.length} ships`);

      this.shards.set(systemId, shard);
      shard.start();
      console.log(`Started shard for system ${systemId} with ${ships.length} ships`);
    }
    return shard;
  }

  stopAll() {
    for (const shard of this.shards.values()) {
      shard.stop();
    }
    this.shards.clear();
  }

  getShards() {
    return this.shards;
  }
}

export const shardManager = new ShardManager();
