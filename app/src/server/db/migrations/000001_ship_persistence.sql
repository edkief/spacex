-- TASK-24: shard flush + restart-load persistence columns.
-- The sim persists {pos, vel, quat, regime, hull, shields, livery, onPad} per
-- ship; destroyed_at drives the wreck ttl so a restarted shard can rebuild
-- unexpired wrecks and clean up expired ones (no orphan rows).
ALTER TABLE ships ADD COLUMN rotation TEXT NOT NULL DEFAULT '{"x":0,"y":0,"z":0,"w":1}';
ALTER TABLE ships ADD COLUMN regime TEXT NOT NULL DEFAULT 'space';
ALTER TABLE ships ADD COLUMN on_pad TEXT;
ALTER TABLE ships ADD COLUMN destroyed_at TEXT;

-- v1 invariant: exactly one ship per player (dock purchase deletes the old
-- row before inserting the new one). The shard flush upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ships_owner ON ships (owner_id);
