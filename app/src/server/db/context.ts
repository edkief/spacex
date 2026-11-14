import { randomUUID } from 'node:crypto';
import type { Db, DbHandle } from './connection.ts';
import type { Tables } from './schema.ts';

/** Everything a repository module needs: tables, access, transactions, clock and id source. */
export interface RepoContext {
  readonly handle: DbHandle;
  readonly t: Tables;
  run<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Runs `fn` with a context bound to one transaction (or the current one when nested). */
  transaction<T>(fn: (ctx: RepoContext) => Promise<T>): Promise<T>;
  now(): Date;
  newId(): string;
}

export interface ContextDeps {
  /** Clock for created_at/updated_at; injectable for tests. */
  now?: () => Date;
  /** Id source (UUIDs by default); injectable for tests. */
  newId?: () => string;
}

/** Creates the root (non-transactional) context over an open database handle. */
export function createContext(handle: DbHandle, deps: ContextDeps = {}): RepoContext {
  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? ((): string => randomUUID());

  const bound = (inTx: Db | undefined): RepoContext => {
    const ctx: RepoContext = {
      handle,
      t: handle.tables,
      run: (fn) => (inTx ? fn(inTx) : handle.run(fn)),
      transaction: (fn) => (inTx ? fn(ctx) : handle.transaction((tx) => fn(bound(tx)))),
      now,
      newId,
    };
    return ctx;
  };
  return bound(undefined);
}
