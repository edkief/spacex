-- Drift — SQLite initial schema (TASK-62 / TASK-63 bootstrap).
-- Mirrors the table definitions in `src/server/db/schema.sqlite.ts` so
-- `client.ts` can apply it once on first boot and tests can spin up an
-- in-memory DB without drizzle-kit.
--
-- Geometry (stars/planets/terrain) is derived from seed and never stored;
-- only the six mutable tables from PRD §8 live here.

CREATE TABLE IF NOT EXISTS players (
    id              TEXT PRIMARY KEY NOT NULL,
    callsign        TEXT NOT NULL,
    credits         INTEGER NOT NULL DEFAULT 500,
    home_system_id  TEXT,
    created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS players_callsign_unique
    ON players (callsign);

CREATE TABLE IF NOT EXISTS ships (
    id           TEXT PRIMARY KEY NOT NULL,
    owner_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    class_id     TEXT NOT NULL
                 CHECK (class_id IN ('scout','freighter','interceptor')),
    livery       TEXT NOT NULL,
    hull         INTEGER NOT NULL,
    shields      INTEGER NOT NULL,
    position     TEXT NOT NULL,
    velocity     TEXT NOT NULL,
    state        TEXT NOT NULL
                 CHECK (state IN ('docked','flying','onfoot','destroyed')),
    updated_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS ships_owner_id_idx ON ships (owner_id);

CREATE TABLE IF NOT EXISTS cargo_items (
    id            TEXT PRIMARY KEY NOT NULL,
    ship_id       TEXT NOT NULL REFERENCES ships(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL,
    quantity      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cargo_items_ship_resource_unique
    ON cargo_items (ship_id, resource_type);
CREATE INDEX IF NOT EXISTS cargo_items_ship_id_idx ON cargo_items (ship_id);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY NOT NULL,
    player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    system_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_player_id_idx ON sessions (player_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS resource_node_state (
    node_id             TEXT PRIMARY KEY NOT NULL,
    quantity_remaining  INTEGER NOT NULL,
    respawn_at          TEXT,
    system_id           TEXT
);
CREATE INDEX IF NOT EXISTS resource_node_state_system_id_idx
    ON resource_node_state (system_id);

CREATE TABLE IF NOT EXISTS system_registry (
    system_id        TEXT PRIMARY KEY NOT NULL,
    name             TEXT NOT NULL,
    shard_active     INTEGER NOT NULL, -- 0 = false, 1 = true
    last_active_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- Drizzle bookkeeping table — single-row, single-column sentinel used by
-- `migrateSqlite()` to record which migration filenames have been applied.
CREATE TABLE IF NOT EXISTS _drift_migrations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    applied_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
