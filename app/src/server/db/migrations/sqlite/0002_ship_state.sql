-- Drift — SQLite ship-state additions (TASK-24).
-- Adds the per-tick flight fields the sim needs to persist so a server
-- restart can resume every ship at its exact last-saved position
-- (acceptance: "ship is within 1 u of its last position" after kill -9).
--
--   quat               — orientation quaternion (4-tuple JSON, ±unit length).
--   regime             — flight regime tag (space / atmosphere / surface).
--   on_pad             — landing pad id when landed (NULL otherwise).
--   wreck_expires_at   — wall-clock ms when a wreck should be cleaned up.
--
-- All four are nullable because every pre-TASK-24 row exists today and
-- the boot path is offline-migration; the column defaults are chosen so
-- backfilling reads as "in space at origin facing +Z" — i.e. the safest
-- possible continuity invariant for ships whose schema migration
-- hasn't run yet.

ALTER TABLE ships ADD COLUMN quat TEXT;
ALTER TABLE ships ADD COLUMN regime TEXT
    CHECK (regime IS NULL OR regime IN ('space','atmosphere','surface'));
ALTER TABLE ships ADD COLUMN on_pad TEXT;
ALTER TABLE ships ADD COLUMN wreck_expires_at TEXT;
