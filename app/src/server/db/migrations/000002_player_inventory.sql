-- TASK-34: player inventory persistence (players.inventory JSON).
-- Stacks of resource units ({iron:3,crystal:1}); weight-capped at the
-- application layer (@shared/inventory), never by the DB.
ALTER TABLE players ADD COLUMN inventory TEXT NOT NULL DEFAULT '{}';
