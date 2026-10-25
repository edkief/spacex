import { Shard } from '../shard/shard';
import { repo } from '../db/repo';
import { RouterOptions } from './router-types';
import { ServerShipState } from '../shard/types';

export async function loadAndRegister(systemId: string, options: RouterOptions): Promise<Shard> {
  const seed = process.env.GALAXY_SEED || 'DRIFT-SEED-DEFAULT';
  const shard = new Shard(systemId, seed);

  // 1. Load ships from DB
  const { ships } = await repo.loadSystemState(systemId);

  for (const ship of ships) {
    shard.entities.set(ship.id, {
      id: ship.id,
      kind: 'ship',
      pos: JSON.parse(ship.position),
      vel: JSON.parse(ship.velocity),
      quat: JSON.parse(ship.quat),
      regime: ship.regime as any,
      hull: ship.hull,
      shields: ship.shields,
      destroyed: ship.state === 'destroyed',
      classId: ship.class_id,
      lastAppliedSeq: 0,
    } as ServerShipState);
  }

  // 2. Set up broadcaster if provided
  if (options.connSender) {
    shard.on('send', (connId, type, data) => {
      options.connSender!(connId, type, data);
    });
  }

  shard.start();
  return shard;
}
