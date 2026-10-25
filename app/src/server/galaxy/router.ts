import { Shard } from '../shard/shard';
import { ConnState } from '../shard/types';
import {
  RouterOptions,
  RouterStats,
  RouterShardStats,
  JoinResult,
  JoinRejection,
} from './router-types';
import { loadAndRegister } from './router-load';
import { reapEmpty } from './router-reap';
import { MAX_PLAYERS_PER_SYSTEM } from '../../shared/galaxy/config';

export class Router {
  private shards = new Map<string, Shard>();
  private pendingSpawns = new Map<string, Promise<Shard>>();
  private reapDeadlines = new Map<string, number>();
  private spawnTimes = new Map<string, number>();
  private generations = new Map<string, number>();

  constructor(private options: RouterOptions = {}) {}

  public async getShard(systemId: string): Promise<Shard> {
    const existing = this.shards.get(systemId);
    if (existing) return existing;

    const pending = this.pendingSpawns.get(systemId);
    if (pending) return pending;

    const spawnPromise = loadAndRegister(systemId, this.options)
      .then((shard) => {
        const gen = (this.generations.get(systemId) || 0) + 1;
        shard.generation = gen;
        this.generations.set(systemId, gen);

        this.shards.set(systemId, shard);
        this.spawnTimes.set(systemId, Date.now());
        this.pendingSpawns.delete(systemId);
        return shard;
      })
      .catch((err) => {
        this.pendingSpawns.delete(systemId);
        throw err;
      });

    this.pendingSpawns.set(systemId, spawnPromise);
    return spawnPromise;
  }

  public async joinSystem(
    systemId: string,
    connId: string,
    conn: ConnState,
  ): Promise<JoinResult | JoinRejection> {
    const shard = await this.getShard(systemId);

    if (shard.connections.size >= MAX_PLAYERS_PER_SYSTEM) {
      return { code: 'system-full', message: 'System is at maximum capacity' };
    }

    shard.addConnection(connId, conn);
    return { shard, systemId, snapshot: shard.getSnapshot() };
  }

  public leaveSystem(systemId: string, connId: string) {
    const shard = this.shards.get(systemId);
    if (!shard) return;
    shard.removeConnection(connId);
    this.startReapGrace(systemId);
  }

  private startReapGrace(systemId: string) {
    const deadline = Date.now() + (this.options.reapGraceMs || 60000);
    this.reapDeadlines.set(systemId, deadline);
  }

  public async reapEmptyLoop() {
    const now = Date.now();
    for (const [systemId, shard] of this.shards) {
      if (shard.connections.size === 0) {
        const deadline = this.reapDeadlines.get(systemId);
        if (!deadline) {
          this.startReapGrace(systemId);
        } else if (now >= deadline) {
          await this.processReap(systemId);
        }
      } else {
        this.reapDeadlines.delete(systemId);
      }
    }
  }

  private async processReap(systemId: string) {
    const shard = this.shards.get(systemId);
    if (!shard) return;

    if (shard.connections.size > 0) {
      this.reapDeadlines.delete(systemId);
      return;
    }

    await reapEmpty(systemId, shard);
    this.shards.delete(systemId);
    this.spawnTimes.delete(systemId);
    this.reapDeadlines.delete(systemId);
  }

  public startReapCycle() {
    setInterval(() => this.reapEmptyLoop(), 5000);
  }

  public getStats(): RouterStats {
    const shards: RouterShardStats[] = Array.from(this.shards.entries()).map(
      ([systemId, shard]) => ({
        systemId,
        name: `System ${systemId}`,
        players: shard.connections.size,
        uptimeMs: Date.now() - (this.spawnTimes.get(systemId) || Date.now()),
      }),
    );

    return { shards };
  }

  public async shutdownAll() {
    for (const [systemId, shard] of this.shards) {
      await reapEmpty(systemId, shard);
    }
    this.shards.clear();
    this.reapDeadlines.clear();
  }
}
