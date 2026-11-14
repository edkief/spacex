import { derivePgTables } from './derive.ts';
import { tables } from './schema.ts';

/** Postgres tables, derived from the canonical definitions in schema.ts (see derive.ts). */
const derived = derivePgTables(tables);

export const players = derived.players;
export const ships = derived.ships;
export const cargoItems = derived.cargoItems;
export const sessions = derived.sessions;
export const resourceNodeState = derived.resourceNodeState;
export const systemRegistry = derived.systemRegistry;
export const pgTables = derived;
