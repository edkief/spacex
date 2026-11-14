import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import type { Livery, Position, Velocity } from './json.ts';

/**
 * The single, canonical table definition (SQLite flavour). The Postgres schema in schema.pg.ts is
 * derived from these tables by introspection (derive.ts), so the two dialects cannot drift.
 * Mapping on the Postgres side: integer ms timestamps -> timestamptz, json text -> jsonb,
 * real -> double precision, integer booleans -> boolean. UUIDs are text in both.
 */
export const SHIP_STATES = ['docked', 'flying', 'onfoot', 'destroyed'] as const;
export type ShipState = (typeof SHIP_STATES)[number];

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const players = sqliteTable(
  'players',
  {
    id: text('id').primaryKey(),
    callsign: text('callsign').notNull().unique(),
    credits: integer('credits').notNull().default(500),
    homeSystemId: text('home_system_id').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [check('players_credits_nonneg', sql`${t.credits} >= 0`)],
);

export const ships = sqliteTable(
  'ships',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    classId: text('class_id').notNull(),
    livery: text('livery', { mode: 'json' }).$type<Livery>().notNull(),
    hull: real('hull').notNull(),
    shields: real('shields').notNull(),
    position: text('position', { mode: 'json' }).$type<Position>().notNull(),
    velocity: text('velocity', { mode: 'json' }).$type<Velocity>().notNull(),
    state: text('state').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    index('ships_owner_idx').on(t.ownerId),
    check('ships_class_valid', sql`${t.classId} in ('scout', 'freighter', 'interceptor')`),
    check('ships_state_valid', sql`${t.state} in (${quoted(SHIP_STATES)})`),
    check('ships_stats_nonneg', sql`${t.hull} >= 0 and ${t.shields} >= 0`),
  ],
);

export const cargoItems = sqliteTable(
  'cargo_items',
  {
    id: text('id').primaryKey(),
    shipId: text('ship_id')
      .notNull()
      .references(() => ships.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    unique('cargo_items_ship_resource_unique').on(t.shipId, t.resourceType),
    check('cargo_items_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    systemId: text('system_id'),
    createdAt: timestamp('created_at').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (t) => [
    index('sessions_player_idx').on(t.playerId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

/** `systemId` is an addition to PRD section 8: listNodeStates(systemId) needs it. */
export const resourceNodeState = sqliteTable(
  'resource_node_state',
  {
    nodeId: text('node_id').primaryKey(),
    systemId: text('system_id').notNull(),
    quantityRemaining: integer('quantity_remaining').notNull(),
    respawnAt: timestamp('respawn_at'),
  },
  (t) => [
    index('resource_node_state_system_idx').on(t.systemId),
    check('resource_node_state_quantity_nonneg', sql`${t.quantityRemaining} >= 0`),
  ],
);

export const systemRegistry = sqliteTable('system_registry', {
  systemId: text('system_id').primaryKey(),
  name: text('name').notNull(),
  shardActive: integer('shard_active', { mode: 'boolean' }).notNull().default(false),
  lastActiveAt: timestamp('last_active_at'),
});

export const tables = { players, ships, cargoItems, sessions, resourceNodeState, systemRegistry };
export type Tables = typeof tables;
