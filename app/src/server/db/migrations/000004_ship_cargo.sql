-- TASK-39: ship cargo hold persistence (ships.cargo JSON).
-- The hold lives ON THE SHIP: stacks of resource units ({iron:10}) in the
-- same sparse shape as players.inventory. weightUsed + capacity are derived
-- at read time (@shared/cargo — capacity = class.cargoSlots × 10), never
-- stored. NULL = no cargo written yet (treated as empty; a flush with no
-- cargo in memory keeps the stored value via COALESCE in the upsert).
ALTER TABLE ships ADD COLUMN cargo TEXT;
