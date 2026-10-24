CREATE TABLE players (
  id TEXT PRIMARY KEY,
  callsign TEXT UNIQUE NOT NULL,
  credits INTEGER DEFAULT 500 NOT NULL,
  home_system_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE ships (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES players(id),
  class_id TEXT NOT NULL,
  livery TEXT,
  hull REAL NOT NULL,
  shields REAL NOT NULL,
  position TEXT NOT NULL,
  velocity TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE cargo_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_id TEXT REFERENCES ships(id),
  resource_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  UNIQUE(ship_id, resource_type)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT REFERENCES players(id),
  system_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE resource_node_state (
  node_id TEXT PRIMARY KEY,
  quantity_remaining INTEGER NOT NULL,
  respawn_at INTEGER
);

CREATE TABLE system_registry (
  system_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shard_active INTEGER DEFAULT 0 NOT NULL,
  last_active_at INTEGER
);
