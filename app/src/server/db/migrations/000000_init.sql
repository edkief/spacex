-- Drift initial schema (SQLite dialect).
-- Mirrors src/server/db/schema.ts (sqliteTables). Postgres DDL is generated
-- separately by drizzle-kit (see drizzle.config.ts) for parity.
-- Only mutable state is stored; geometry is derived from the galaxy seed.

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  callsign TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL DEFAULT 500,
  home_system_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ships (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES players(id),
  class_id TEXT NOT NULL,
  livery TEXT NOT NULL DEFAULT '{}',
  hull REAL NOT NULL DEFAULT 100,
  shields REAL NOT NULL DEFAULT 100,
  position TEXT NOT NULL,
  velocity TEXT NOT NULL DEFAULT '{"x":0,"y":0,"z":0}',
  state TEXT NOT NULL DEFAULT 'docked',
  updated_at TEXT NOT NULL,
  CONSTRAINT chk_ships_state CHECK (state IN ('docked', 'flying', 'onfoot', 'destroyed'))
);
CREATE INDEX IF NOT EXISTS idx_ships_owner ON ships (owner_id);

CREATE TABLE IF NOT EXISTS cargo_items (
  id TEXT PRIMARY KEY,
  ship_id TEXT NOT NULL REFERENCES ships(id),
  resource_type TEXT NOT NULL,
  quantity INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cargo_items_ship_resource
  ON cargo_items (ship_id, resource_type);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  system_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions (player_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS resource_node_state (
  node_id TEXT PRIMARY KEY,
  quantity_remaining INTEGER NOT NULL,
  respawn_at TEXT
);

CREATE TABLE IF NOT EXISTS system_registry (
  system_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shard_active INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT
);
