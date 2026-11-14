import { cargoRepo } from './cargo.ts';
import type { ContextDeps, RepoContext } from './context.ts';
import { createContext } from './context.ts';
import type { DbHandle } from './connection.ts';
import { nodeStateRepo } from './nodeState.ts';
import { playersRepo } from './players.ts';
import { sessionsRepo } from './sessions.ts';
import { shipsRepo } from './ships.ts';
import { systemsRepo } from './systems.ts';
import type { Repository } from './types.ts';

export type { Repository } from './types.ts';
export * from './errors.ts';

/** Assembles the repository from the aggregate modules over one context. */
function build(ctx: RepoContext): Repository {
  return {
    ...playersRepo(ctx),
    ...shipsRepo(ctx),
    ...cargoRepo(ctx),
    ...sessionsRepo(ctx),
    ...nodeStateRepo(ctx),
    ...systemsRepo(ctx),
    transaction: (fn) => ctx.transaction((tx) => fn(build(tx))),
  };
}

/** Creates the async repository over an open database handle (SQLite or Postgres alike). */
export function createRepository(handle: DbHandle, deps: ContextDeps = {}): Repository {
  return build(createContext(handle, deps));
}
