-- Drift — SQLite deposits table (TASK-37).
-- Persists resource deposit state per system. The seed-derived
-- placement lives in `@shared/world/deposits.ts`; this table stores
-- the mutable deltas (`remaining`, `discovered`) only, so the DB
-- stays tiny and the seed remains the source of truth (PRD §6).
--
-- Primary key is `(system_id, deposit_seq)` so the table can hold
-- multiple deposits with the same seed-derived id (the id is per-
-- planet and only unique within a planet). `deposit_seq` is the
-- ordinal position in the deterministic placement list, scoped to
-- the system, so a single upsert can both insert and update.
--
-- Rows are inserted lazily — the first time a player mines a
-- deposit, `upsertDepositState` writes a row carrying the initial
-- `remaining`. Subsequent mines update the same row in place.
--
-- `pos` and `resource_id` are stored for debugability but the runtime
-- recomputes them from the seed on every read.

CREATE TABLE IF NOT EXISTS deposits (
    id            TEXT NOT NULL,
    system_id     TEXT NOT NULL,
    planet_id     TEXT NOT NULL,
    pos           TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    remaining     INTEGER NOT NULL CHECK (remaining >= 0),
    discovered    INTEGER NOT NULL DEFAULT 0 CHECK (discovered IN (0, 1)),
    deposit_seq   INTEGER NOT NULL,
    PRIMARY KEY (system_id, deposit_seq)
);
CREATE INDEX IF NOT EXISTS deposits_planet_id_idx ON deposits (planet_id);
CREATE INDEX IF NOT EXISTS deposits_system_id_idx ON deposits (system_id);