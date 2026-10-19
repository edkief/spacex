-- Drift — SQLite ship cargo hold column (TASK-39).
-- Adds the persistent cargo hold JSON column the ship carries across
-- restarts and across warp transitions. The shape mirrors the
-- on-foot inventory (TASK-34) but lives on the ship because the
-- cargo persists with the ship, not the player.
--
--   cargo  — JSON `{stacks: {resourceId: amount}, weightUsed, capacity}`
--            where `capacity = class.cargoSlots * 10` (scout 40,
--            interceptor 20, freighter 120 — see `@shared/world/cargo`).
--
-- NULL is the safe default for pre-TASK-39 rows; the loader replaces
-- NULL with an empty hold using the class-derived capacity. A
-- malformed payload (e.g. partial write) is also replaced with an
-- empty hold rather than crashing the boot.

ALTER TABLE ships ADD COLUMN cargo TEXT;