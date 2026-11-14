import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import type { Star } from '@shared/galaxy/types.ts';
import type { Repository } from '../db/types.ts';
import type { JoinResult, SystemDirectory } from '../directory.ts';
import type { Timers } from '../timers.ts';
import { Shard, TICK_MS } from './shard.ts';
import { SimLoop } from './simLoop.ts';

/** Players per system before `system-full`. */
export const MAX_PLAYERS_PER_SYSTEM = 16;
/** An empty shard is stopped (after saving its ships) this long after its last player left. */
export const REAP_GRACE_MS = 60_000;

export interface RouterOptions {
  seed: string;
  repo: Repository;
  timers: Timers;
  /** Monotonic milliseconds for the sim loops (default: performance.now). */
  now?: () => number;
  capacity?: number;
  onError?: (error: unknown) => void;
}

interface Running {
  shard: Shard;
  loop: SimLoop;
  startedAt: number;
  reaper: unknown;
}

export interface ShardStats {
  systemId: string;
  players: number;
  uptimeMs: number;
  tick: number;
  tickP95Ms: number;
}

export type ShardRouter = SystemDirectory & {
  /** The running shard of a system, if any. */
  shard(systemId: string): Shard | undefined;
  stats(): ShardStats[];
  /** Stops every shard after saving its ships. */
  shutdown(): Promise<void>;
};

/**
 * Hosts the system shards of one process: a shard (with its 20 Hz loop) is created on first
 * join, capped at 16 players, and reaped 60 s after it empties. This is the real implementation
 * of the SystemDirectory seam the connection layer talks to.
 */
export function createShardRouter(options: RouterOptions): ShardRouter {
  const capacity = options.capacity ?? MAX_PLAYERS_PER_SYSTEM;
  const now = options.now ?? ((): number => performance.now());
  const running = new Map<string, Running>();
  let stars: Map<string, Star> | undefined;

  /** System id -> star, built once (ids are hashes, so the chart must be scanned). */
  const starOf = (systemId: string): Star | undefined => {
    stars ??= new Map(
      generateStars(options.seed).map((star) => [
        generateSystemForStar(options.seed, star).systemId,
        star,
      ]),
    );
    return stars.get(systemId);
  };

  const start = (systemId: string, star: Star): Running => {
    const system = generateSystemForStar(options.seed, star);
    const shard = new Shard({
      seed: options.seed,
      system,
      repo: options.repo,
      ...(options.onError ? { onError: options.onError } : {}),
    });
    const loop = new SimLoop({
      tickMs: TICK_MS,
      now,
      timers: options.timers,
      onTick: () => shard.tick(),
    });
    loop.start();
    const entry: Running = { shard, loop, startedAt: now(), reaper: undefined };
    running.set(systemId, entry);
    return entry;
  };

  const stop = async (systemId: string): Promise<void> => {
    const entry = running.get(systemId);
    if (!entry) return;
    running.delete(systemId);
    entry.loop.stop();
    if (entry.reaper !== undefined) options.timers.clearTimeout(entry.reaper);
    await entry.shard.flush();
  };

  const scheduleReap = (systemId: string, entry: Running): void => {
    if (entry.reaper !== undefined) options.timers.clearTimeout(entry.reaper);
    entry.reaper = options.timers.setTimeout(() => {
      entry.reaper = undefined;
      if (entry.shard.playerCount === 0) void stop(systemId).catch(options.onError);
    }, REAP_GRACE_MS);
  };

  return {
    async join(systemId, player): Promise<JoinResult> {
      const star = starOf(systemId);
      if (!star) return { ok: false, code: 'system-not-found', message: 'no such system' };
      const entry = running.get(systemId) ?? start(systemId, star);
      if (!entry.shard.has(player.playerId) && entry.shard.playerCount >= capacity) {
        return { ok: false, code: 'system-full', message: 'system is full' };
      }
      if (entry.reaper !== undefined) {
        options.timers.clearTimeout(entry.reaper);
        entry.reaper = undefined;
      }
      return { ok: true, snapshot: await entry.shard.join(player) };
    },

    async leave(systemId, playerId, sink) {
      const entry = running.get(systemId);
      if (!entry) return;
      await entry.shard.leave(playerId, sink);
      if (entry.shard.playerCount === 0) scheduleReap(systemId, entry);
    },

    input(systemId, playerId, input) {
      running.get(systemId)?.shard.input(playerId, input);
    },

    shard: (systemId) => running.get(systemId)?.shard,

    stats: () =>
      [...running.entries()].map(([systemId, entry]) => ({
        systemId,
        players: entry.shard.playerCount,
        uptimeMs: now() - entry.startedAt,
        tick: entry.shard.tickNumber,
        tickP95Ms: entry.loop.percentile(0.95),
      })),

    async shutdown() {
      await Promise.all([...running.keys()].map((systemId) => stop(systemId)));
    },
  };
}
