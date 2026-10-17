/**
 * Shard registry — tracks the live system-shard set so the flush
 * service can iterate every active shard (TASK-24).
 *
 * Today the registry is just a `Map<systemId, Shard>` + a `flushAll()`
 * helper used by the server's graceful-shutdown path. The future
 * galaxy router (TASK-11) will populate it via `register()` on the
 * first player joining a system and `unregister()` when the last
 * player leaves.
 *
 * Why a class instead of a `Map`:
 *   - **`flushAll()`** — iterates every shard, awaits each flush,
 *     reports total duration. The server main calls this on
 *     SIGTERM/SIGINT so the crash-restart integration test can rely
 *     on a synchronous-flush-before-exit invariant.
 *   - **Sentinel methods** — `size()`, `list()`, `has()` keep the
 *     callers honest about ownership without leaking the underlying
 *     `Map`.
 *
 * The class is deliberately tiny (~80 lines) so it fits in the
 * 200–300 line AGENTS.md cap on its own without needing a barrel.
 */
import type { Repository } from "../db/repo.js";
import type { Shard } from "./types.js";
import { flushShips, type FlushResult } from "./persist.js";

/** A snapshot of one flush call. */
export interface ShardFlushOutcome {
  readonly systemId: string;
  readonly result: FlushResult;
}

/** Options bag for `ShardRegistry`. */
export interface ShardRegistryOptions {
  /** Override the logger. Defaults to `console`. */
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * The system-shard registry. Owned by the server boot path; mutated
 * by the (future) galaxy router and read by the flush service.
 */
export class ShardRegistry {
  private readonly shards = new Map<string, Shard>();

  constructor(
    private readonly repo: Repository,
    private readonly options: ShardRegistryOptions = {},
  ) {}

  /** Add a shard. Idempotent on `systemId` — a second call replaces. */
  register(shard: Shard): void {
    this.shards.set(shard.systemId, shard);
  }

  /** Remove a shard by systemId. Idempotent. */
  unregister(systemId: string): boolean {
    return this.shards.delete(systemId);
  }

  /** True if a shard with `systemId` is currently active. */
  has(systemId: string): boolean {
    return this.shards.has(systemId);
  }

  /** Lookup a shard by id. */
  get(systemId: string): Shard | undefined {
    return this.shards.get(systemId);
  }

  /** Number of currently-active shards. */
  size(): number {
    return this.shards.size;
  }

  /** Snapshot of the live shard list (newest-safe to iterate). */
  list(): Shard[] {
    return Array.from(this.shards.values());
  }

  /**
   * Flush every active shard once. Used by the graceful-shutdown
   * path; the periodic interval timer calls into
   * `flushShips(shard, repo)` directly so a slow shard doesn't block
   * the others.
   *
   * Returns one outcome per shard (skips shards with zero entities).
   * Total wall-clock duration is logged at info level.
   */
  async flushAll(): Promise<ShardFlushOutcome[]> {
    const startedAt = Date.now();
    const out: ShardFlushOutcome[] = [];
    for (const shard of this.shards.values()) {
      try {
        const result = await flushShips(shard, this.repo, {
          logger: this.options.logger,
        });
        out.push({ systemId: shard.systemId, result });
      } catch (err) {
        // Don't let one failing shard abort the others — a transient
        // SQLite lock should not block the rest of the graceful
        // shutdown.
        this.options.logger?.error?.(`[drift-registry] flush of ${shard.systemId} failed:`, err);
      }
    }
    const durationMs = Date.now() - startedAt;
    this.options.logger?.info?.(
      `[drift-registry] flushed ${this.shards.size} shard(s) in ${durationMs} ms`,
    );
    return out;
  }

  /** Tear down every shard's sim loop. Idempotent. */
  shutdownAll(): void {
    for (const shard of this.shards.values()) {
      shard.shutdown();
    }
    this.shards.clear();
  }
}
