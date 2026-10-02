-- TASK-37: deposit state — deltas only (remaining, discovered).
-- Deposit POSITIONS are derived from the galaxy seed (src/shared/world/deposits.ts)
-- and never stored; the (system_id, deposit_seq) key maps each row back to the
-- deterministic deposit list (deposit_id = "${system_id}:${deposit_seq}").
-- Rows are created lazily on first mine; depleted deposits keep their row
-- with remaining = 0 (the entity despawns, the state does not).

CREATE TABLE IF NOT EXISTS deposits (
  system_id TEXT NOT NULL,
  deposit_seq INTEGER NOT NULL,
  deposit_id TEXT NOT NULL,
  planet_id TEXT NOT NULL,
  pos TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  discovered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (system_id, deposit_seq)
);
