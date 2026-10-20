-- TASK-55: per-player settings (quality preset, mouse sensitivity, reduced motion).
-- Nullable JSON so a pre-TASK-55 row reads as "defaults" via the repo loader.
ALTER TABLE players ADD COLUMN settings TEXT;
