-- Drift — SQLite player inventory column (TASK-34).
-- One JSON column on the players table holding the on-foot inventory.
-- Storing as JSON keeps the per-pickup / per-drop write a single UPDATE,
-- matching the TASK-63 AC ("one UPDATE per save point, no per-row fanout").
--
-- The column is nullable so pre-TASK-34 rows backfill to NULL; the
-- repository replaces NULL with the empty inventory on load.

ALTER TABLE players ADD COLUMN inventory TEXT;
