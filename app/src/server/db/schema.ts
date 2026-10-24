import {
  sqliteTable,
  text as sqliteText,
  integer as sqliteInteger,
  real as sqliteReal,
  unique as sqliteUnique,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  real as pgReal,
  uuid as pgUuid,
  jsonb as pgJsonb,
  timestamp as pgTimestamp,
  boolean as pgBoolean,
  pgEnum,
  unique as pgUnique,
} from 'drizzle-orm/pg-core';

export type Driver = 'sqlite' | 'postgres';

// Define the ship state enum for PG
export const shipStateEnum = pgEnum('ship_state', ['docked', 'flying', 'onfoot', 'destroyed']);

export interface TableDefinitions {
  players: any;
  ships: any;
  cargo_items: any;
  sessions: any;
  resource_node_state: any;
  system_registry: any;
  [key: string]: any;
}

export function createSchema(driver: Driver): TableDefinitions {
  if (driver === 'sqlite') {
    const players = sqliteTable('players', {
      id: sqliteText('id').primaryKey(),
      callsign: sqliteText('callsign').unique().notNull(),
      credits: sqliteInteger('credits').default(500).notNull(),
      home_system_id: sqliteText('home_system_id'),
      created_at: sqliteInteger('created_at', { mode: 'timestamp' }).notNull(),
    });
    const ships = sqliteTable('ships', {
      id: sqliteText('id').primaryKey(),
      owner_id: sqliteText('owner_id').references(() => players.id),
      class_id: sqliteText('class_id').notNull(),
      livery: sqliteText('livery'),
      hull: sqliteReal('hull').notNull(),
      shields: sqliteReal('shields').notNull(),
      position: sqliteText('position').notNull(),
      velocity: sqliteText('velocity').notNull(),
      system_id: sqliteText('system_id').notNull(),
      state: sqliteText('state').notNull(),
      updated_at: sqliteInteger('updated_at', { mode: 'timestamp' }).notNull(),
    });
    const cargo_items = sqliteTable(
      'cargo_items',
      {
        id: sqliteInteger('id').primaryKey({ autoIncrement: true }),
        ship_id: sqliteText('ship_id').references(() => ships.id),
        resource_type: sqliteText('resource_type').notNull(),
        quantity: sqliteInteger('quantity').notNull(),
      },
      (t) => ({
        ship_resource_unique: sqliteUnique('ship_resource_unique').on(t.ship_id, t.resource_type),
      }),
    );
    const sessions = sqliteTable('sessions', {
      token_hash: sqliteText('token_hash').primaryKey(),
      player_id: sqliteText('player_id').references(() => players.id),
      system_id: sqliteText('system_id'),
      created_at: sqliteInteger('created_at', { mode: 'timestamp' }).notNull(),
      expires_at: sqliteInteger('expires_at', { mode: 'timestamp' }).notNull(),
    });
    const resource_node_state = sqliteTable('resource_node_state', {
      node_id: sqliteText('node_id').primaryKey(),
      system_id: sqliteText('system_id').notNull(),
      quantity_remaining: sqliteInteger('quantity_remaining').notNull(),
      respawn_at: sqliteInteger('respawn_at', { mode: 'timestamp' }),
    });
    const system_registry = sqliteTable('system_registry', {
      system_id: sqliteText('system_id').primaryKey(),
      name: sqliteText('name').notNull(),
      shard_active: sqliteInteger('shard_active', { mode: 'boolean' }).default(false).notNull(),
      last_active_at: sqliteInteger('last_active_at', { mode: 'timestamp' }),
    });
    return { players, ships, cargo_items, sessions, resource_node_state, system_registry };
  } else {
    const players = pgTable('players', {
      id: pgUuid('id').primaryKey(),
      callsign: pgText('callsign').unique().notNull(),
      credits: pgInteger('credits').default(500).notNull(),
      home_system_id: pgUuid('home_system_id'),
      created_at: pgTimestamp('created_at').notNull(),
    });
    const ships = pgTable('ships', {
      id: pgUuid('id').primaryKey(),
      owner_id: pgUuid('owner_id').references(() => players.id),
      class_id: pgText('class_id').notNull(),
      livery: pgJsonb('livery'),
      hull: pgReal('hull').notNull(),
      shields: pgReal('shields').notNull(),
      position: pgJsonb('position').notNull(),
      velocity: pgJsonb('velocity').notNull(),
      system_id: pgUuid('system_id').notNull(),
      state: shipStateEnum('state').notNull(),
      updated_at: pgTimestamp('updated_at').notNull(),
    });
    const cargo_items = pgTable(
      'cargo_items',
      {
        id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
        ship_id: pgUuid('ship_id').references(() => ships.id),
        resource_type: pgText('resource_type').notNull(),
        quantity: pgInteger('quantity').notNull(),
      },
      (t) => ({
        ship_resource_unique: pgUnique('ship_resource_unique').on(t.ship_id, t.resource_type),
      }),
    );
    const sessions = pgTable('sessions', {
      token_hash: pgText('token_hash').primaryKey(),
      player_id: pgUuid('player_id').references(() => players.id),
      system_id: pgUuid('system_id'),
      created_at: pgTimestamp('created_at').notNull(),
      expires_at: pgTimestamp('expires_at').notNull(),
    });
    const resource_node_state = pgTable('resource_node_state', {
      node_id: pgUuid('node_id').primaryKey(),
      system_id: pgUuid('system_id').notNull(),
      quantity_remaining: pgInteger('quantity_remaining').notNull(),
      respawn_at: pgTimestamp('respawn_at'),
    });
    const system_registry = pgTable('system_registry', {
      system_id: pgUuid('system_id').primaryKey(),
      name: pgText('name').notNull(),
      shard_active: pgBoolean('shard_active').default(false).notNull(),
      last_active_at: pgTimestamp('last_active_at'),
    });
    return { players, ships, cargo_items, sessions, resource_node_state, system_registry };
  }
}
