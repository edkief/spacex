-- TASK-55: per-player settings persistence (players.settings JSON).
-- Shape: {"quality":"high"|"medium"|"low","sensitivity":0.5..2.0,
--         "reduced-motion":boolean} — zod-validated at the repository
-- boundary (@shared/settings), never by the DB.
ALTER TABLE players ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
