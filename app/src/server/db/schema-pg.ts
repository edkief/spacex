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

export const shipStateEnum = pgEnum('ship_state', ['docked', 'flying', 'onfoot', 'destroyed']);

export const players = pgTable('players', {
  id: pgUuid('id').primaryKey(),
  callsign: pgText('callsign').unique().notNull(),
  credits: pgInteger('credits').default(500).notNull(),
  home_system_id: pgUuid('home_system_id'),
  created_at: pgTimestamp('created_at').notNull(),
});

export const ships = pgTable('ships', {
  id: pgUuid('id').primaryKey(),
  owner_id: pgUuid('owner_id').references(() => players.id),
  class_id: pgText('class_id').notNull(),
  livery: pgJsonb('livery'),
  hull: pgReal('hull').notNull(),
  shields: pgReal('shields').notNull(),
  position: pgJsonb('position').notNull(),
  velocity: pgJsonb('velocity').notNull(),
  state: shipStateEnum('state').notNull(),
  updated_at: pgTimestamp('updated_at').notNull(),
});

export const cargo_items = pgTable(
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

export const sessions = pgTable('sessions', {
  token_hash: pgText('token_hash').primaryKey(),
  player_id: pgUuid('player_id').references(() => players.id),
  system_id: pgUuid('system_id'),
  created_at: pgTimestamp('created_at').notNull(),
  expires_at: pgTimestamp('expires_at').notNull(),
});

export const resource_node_state = pgTable('resource_node_state', {
  node_id: pgUuid('node_id').primaryKey(),
  quantity_remaining: pgInteger('quantity_remaining').notNull(),
  respawn_at: pgTimestamp('respawn_at'),
});

export const system_registry = pgTable('system_registry', {
  system_id: pgUuid('system_id').primaryKey(),
  name: pgText('name').notNull(),
  shard_active: pgBoolean('shard_active').default(false).notNull(),
  last_active_at: pgTimestamp('last_active_at'),
});
