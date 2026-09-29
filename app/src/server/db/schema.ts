import { sql } from 'drizzle-orm';
import { check, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  boolean as pgBoolean,
  check as pgCheck,
  integer as pgInteger,
  jsonb,
  pgEnum,
  pgTable,
  real as pgReal,
  text as pgText,
  timestamp as pgTimestamp,
  uniqueIndex as pgUniqueIndex,
} from 'drizzle-orm/pg-core';

// Drift persists only mutable state (PRD §8). Geometry — stars, planets,
// terrain, node *positions* — is derived from GALAXY_SEED and never stored.

export const SHIP_STATES = ['docked', 'flying', 'onfoot', 'destroyed'] as const;
export type ShipState = (typeof SHIP_STATES)[number];

export const SHIP_CLASS_IDS = ['scout', 'freighter', 'interceptor'] as const;
export type ShipClassId = (typeof SHIP_CLASS_IDS)[number];

export type Vec3 = { x: number; y: number; z: number };
export type ShipPosition = { systemId: string; x: number; y: number; z: number };
/** Three paint slots, hex strings (shared contract, TASK-21). */
export type Livery = { hull: string; accent: string; trim: string };

export interface PlayerRow {
  id: string;
  callsign: string;
  credits: number;
  homeSystemId: string;
  createdAt: string;
}

export interface ShipRow {
  id: string;
  ownerId: string;
  classId: string;
  livery: Livery;
  hull: number;
  shields: number;
  position: ShipPosition;
  velocity: Vec3;
  state: ShipState;
  updatedAt: string;
}

export interface CargoRow {
  id: string;
  shipId: string;
  resourceType: string;
  quantity: number;
}

export interface SessionRow {
  tokenHash: string;
  playerId: string;
  systemId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface NodeStateRow {
  nodeId: string;
  quantityRemaining: number;
  respawnAt: string | null;
}

export interface SystemRow {
  systemId: string;
  name: string;
  shardActive: boolean;
  lastActiveAt: string | null;
}

/** timestamptz stored as ISO-8601 strings on both drivers so the
 *  repository layer can treat timestamps identically across dialects. */
const timestamptz = (name: string) => pgTimestamp(name, { withTimezone: true, mode: 'string' });

// Tables are individual consts (not one big object literal) so drizzle's
// column-type inference stays resolvable across the FK self-references.

// ── SQLite dialect ─────────────────────────────────────────────────────────

export const players = sqliteTable('players', {
  id: text('id').primaryKey(),
  callsign: text('callsign').notNull().unique(),
  credits: integer('credits').notNull().default(500),
  homeSystemId: text('home_system_id').notNull(),
  createdAt: text('created_at').notNull(),
});

export const ships = sqliteTable(
  'ships',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => players.id),
    classId: text('class_id').notNull(),
    livery: text('livery', { mode: 'json' })
      .$type<Livery>()
      .notNull()
      .default({ hull: '#000000', accent: '#000000', trim: '#000000' }),
    hull: real('hull').notNull().default(100),
    shields: real('shields').notNull().default(100),
    position: text('position', { mode: 'json' }).$type<ShipPosition>().notNull(),
    velocity: text('velocity', { mode: 'json' })
      .$type<Vec3>()
      .notNull()
      .default({ x: 0, y: 0, z: 0 }),
    state: text('state', { enum: SHIP_STATES }).notNull().default('docked'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [check('chk_ships_state', sql`${t.state} IN ('docked', 'flying', 'onfoot', 'destroyed')`)],
);

export const cargoItems = sqliteTable(
  'cargo_items',
  {
    id: text('id').primaryKey(),
    shipId: text('ship_id')
      .notNull()
      .references(() => ships.id),
    resourceType: text('resource_type').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => [uniqueIndex('uq_cargo_items_ship_resource').on(t.shipId, t.resourceType)],
);

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  playerId: text('player_id')
    .notNull()
    .references(() => players.id),
  systemId: text('system_id'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const resourceNodeState = sqliteTable('resource_node_state', {
  nodeId: text('node_id').primaryKey(),
  quantityRemaining: integer('quantity_remaining').notNull(),
  respawnAt: text('respawn_at'),
});

export const systemRegistry = sqliteTable('system_registry', {
  systemId: text('system_id').primaryKey(),
  name: text('name').notNull(),
  shardActive: integer('shard_active', { mode: 'boolean' }).notNull().default(false),
  lastActiveAt: text('last_active_at'),
});

export const sqliteTables = {
  players,
  ships,
  cargoItems,
  sessions,
  resourceNodeState,
  systemRegistry,
};

export type SqliteSchema = typeof sqliteTables;

// ── Postgres dialect ───────────────────────────────────────────────────────

const shipStateEnum = pgEnum('ship_state', SHIP_STATES);

export const pgPlayers = pgTable('players', {
  id: pgText('id').primaryKey(),
  callsign: pgText('callsign').notNull().unique(),
  credits: pgInteger('credits').notNull().default(500),
  homeSystemId: pgText('home_system_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const pgShips = pgTable(
  'ships',
  {
    id: pgText('id').primaryKey(),
    ownerId: pgText('owner_id')
      .notNull()
      .references(() => pgPlayers.id),
    classId: pgText('class_id').notNull(),
    livery: jsonb('livery')
      .$type<Livery>()
      .notNull()
      .default({ hull: '#000000', accent: '#000000', trim: '#000000' }),
    hull: pgReal('hull').notNull().default(100),
    shields: pgReal('shields').notNull().default(100),
    position: jsonb('position').$type<ShipPosition>().notNull(),
    velocity: jsonb('velocity').$type<Vec3>().notNull().default({ x: 0, y: 0, z: 0 }),
    state: shipStateEnum('state').notNull().default('docked'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    pgCheck('chk_ships_state', sql`${t.state} IN ('docked', 'flying', 'onfoot', 'destroyed')`),
  ],
);

export const pgCargoItems = pgTable(
  'cargo_items',
  {
    id: pgText('id').primaryKey(),
    shipId: pgText('ship_id')
      .notNull()
      .references(() => pgShips.id),
    resourceType: pgText('resource_type').notNull(),
    quantity: pgInteger('quantity').notNull(),
  },
  (t) => [pgUniqueIndex('uq_cargo_items_ship_resource').on(t.shipId, t.resourceType)],
);

export const pgSessions = pgTable('sessions', {
  tokenHash: pgText('token_hash').primaryKey(),
  playerId: pgText('player_id')
    .notNull()
    .references(() => pgPlayers.id),
  systemId: pgText('system_id'),
  createdAt: timestamptz('created_at').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
});

export const pgResourceNodeState = pgTable('resource_node_state', {
  nodeId: pgText('node_id').primaryKey(),
  quantityRemaining: pgInteger('quantity_remaining').notNull(),
  respawnAt: timestamptz('respawn_at'),
});

export const pgSystemRegistry = pgTable('system_registry', {
  systemId: pgText('system_id').primaryKey(),
  name: pgText('name').notNull(),
  shardActive: pgBoolean('shard_active').notNull().default(false),
  lastActiveAt: timestamptz('last_active_at'),
});

export const pgTables = {
  players: pgPlayers,
  ships: pgShips,
  cargoItems: pgCargoItems,
  sessions: pgSessions,
  resourceNodeState: pgResourceNodeState,
  systemRegistry: pgSystemRegistry,
};

export type PgSchema = typeof pgTables;

/** Both dialect schemas expose the same six tables with the same column
 *  names; the repository layer is written once against this shape. */
export type Schema = SqliteSchema | PgSchema;
