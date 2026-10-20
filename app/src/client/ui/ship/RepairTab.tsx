/**
 * Repair tab — TASK-53 (TASK-23 cost preview + dock repair).
 *
 * The tab shows the live repair cost for the player's ship
 * (`repairCost` from `@shared/physics/damage` — the same formula
 * the server uses) and a Repair button that is only enabled while
 * the ship is docked. When the ship is in flight the button is
 * disabled and the reason is spelled out.
 */
import { useCallback, useState } from "react";
import type * as React from "react";

import { repairCost } from "@shared/physics/damage.js";
import { SHIP_CLASSES } from "@shared/ships.js";

import type { ShipInfo } from "./shipApi.js";

/** Props for the repair tab. */
export interface RepairTabProps {
  /** The player's ship row. */
  ship: ShipInfo | null;
  /** Current credit balance (the server rejects over-spends). */
  balance: number;
  /** Called when the player presses Repair. */
  onRepair: () => void | Promise<void>;
  /** Test-id prefix for the host panel. */
  testIdPrefix: string;
}

/**
 * The repair body. The cost preview is derived from the live ship
 * row so it updates the moment the ship takes damage.
 */
export function RepairTab({
  ship,
  balance,
  onRepair,
  testIdPrefix,
}: RepairTabProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const docked = ship?.state === "docked";
  const cost =
    ship === null ? 0 : repairCost({ hull: ship.hull, shields: ship.shields }, ship.classId);
  const affordable = cost <= balance;

  const reason = ((): string | null => {
    if (ship === null) return "Ship data unavailable";
    if (!docked) return "Must be docked at a station to repair";
    if (!affordable) return "Not enough credits";
    if (cost <= 0) return "Ship is already fully repaired";
    return null;
  })();

  const press = useCallback(async () => {
    setBusy(true);
    try {
      await onRepair();
    } finally {
      setBusy(false);
    }
  }, [onRepair]);

  return (
    <div data-testid={`${testIdPrefix}-repair`}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span>Repair cost</span>
        <span data-testid={`${testIdPrefix}-repair-cost`} style={{ color: "#7adfff" }}>
          {cost} cr
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4 }}>
        <span>Balance</span>
        <span data-testid={`${testIdPrefix}-repair-balance`}>{balance.toLocaleString()} cr</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4 }}>
        <span>Hull</span>
        <span>
          {ship?.hull ?? 0} / {ship === null ? 0 : SHIP_CLASSES[ship.classId].hull}
        </span>
      </div>
      <button
        type="button"
        data-testid={`${testIdPrefix}-repair-button`}
        disabled={busy || reason !== null}
        onClick={() => {
          void press();
        }}
        style={{
          marginTop: 12,
          background: "transparent",
          border: "1px solid rgba(255,255,255,0.25)",
          color: reason === null ? "#e6edf3" : "rgba(230,237,243,0.3)",
          padding: "6px 14px",
          cursor: reason === null ? "pointer" : "not-allowed",
          fontFamily: "monospace",
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        {busy ? "Repairing…" : "Repair"}
      </button>
      {reason !== null ? (
        <p
          data-testid={`${testIdPrefix}-repair-reason`}
          style={{ marginTop: 8, fontSize: 10, opacity: 0.7 }}
        >
          {reason}
        </p>
      ) : null}
    </div>
  );
}
