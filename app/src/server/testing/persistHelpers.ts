import type { Repository } from '../db/types.ts';
import type { Scheduler } from '../persist/scheduler.ts';

/** A scheduler whose "time" only advances when a test calls `tick`. */
export class FakeScheduler implements Scheduler {
  readonly intervals: { callback: () => void; ms: number; active: boolean }[] = [];

  setInterval(callback: () => void, ms: number): unknown {
    const entry = { callback, ms, active: true };
    this.intervals.push(entry);
    return entry;
  }

  clearInterval(handle: unknown): void {
    (handle as { active: boolean }).active = false;
  }

  /** Fires every active interval once. */
  tick(): void {
    for (const entry of this.intervals) if (entry.active) entry.callback();
  }

  get activeCount(): number {
    return this.intervals.filter((entry) => entry.active).length;
  }
}

export interface Spy {
  repo: Repository;
  /** Call counts by method name; `transaction` counts top-level transactions. */
  calls: Record<string, number>;
  reset(): void;
}

/** Wraps a repository so every method call (including inside transactions) is counted. */
export function spyOnRepository(real: Repository, failTransactions = { remaining: 0 }): Spy {
  const calls: Record<string, number> = {};
  const wrap = (target: Repository, topLevel: boolean): Repository =>
    new Proxy(target, {
      get(obj, prop: string) {
        const value = (obj as unknown as Record<string, unknown>)[prop];
        if (typeof value !== 'function') return value;
        if (prop === 'transaction') {
          return (fn: (tx: Repository) => Promise<unknown>) => {
            calls['transaction'] = (calls['transaction'] ?? 0) + 1;
            if (topLevel && failTransactions.remaining > 0) {
              failTransactions.remaining -= 1;
              return Promise.reject(new Error('injected transaction failure'));
            }
            return obj.transaction((tx) => fn(wrap(tx, false)));
          };
        }
        return (...args: unknown[]) => {
          calls[prop] = (calls[prop] ?? 0) + 1;
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      },
    });
  return {
    repo: wrap(real, true),
    calls,
    reset: () => {
      for (const key of Object.keys(calls)) delete calls[key];
    },
  };
}
