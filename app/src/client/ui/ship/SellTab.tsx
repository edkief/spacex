/**
 * Sell tab — TASK-53 (TASK-40 dock sales).
 *
 * The resource table with the per-row price, the combined sellable
 * amount (ship hold + on-foot backpack) and the "Sell 1" /
 * "Sell all" buttons. Extracted from the original `DockPanel`
 * (TASK-40) so the dock panel and the ship panel can share ONE
 * implementation.
 */
import type * as React from "react";

import type { CargoResourceType } from "@shared/world/cargo.js";
import { CARGO_WEIGHT_PER_UNIT } from "@shared/world/cargo.js";
import type { ResourceId } from "@shared/resources.js";

/** Per-row colour cue so the eye can spot the resource type. */
const RESOURCE_COLOURS: Readonly<Record<CargoResourceType, string>> = {
  iron: "#9aa6b2",
  copper: "#d18a4f",
  "rare-earths": "#b48cf8",
  crystal: "#7adfff",
};

/** One row of the sell table. */
export interface SellRow {
  id: CargoResourceType;
  /** Combined sellable amount (hold + backpack). */
  total: number;
  /** Amount on foot. */
  invAmount: number;
  /** Amount in the ship's hold. */
  cargoAmount: number;
  /** Base price per unit. */
  price: number;
}

/** Props for the sell tab. */
export interface SellTabProps {
  rows: readonly SellRow[];
  onSellOne: (id: ResourceId, amount: number) => void;
  onSellAll: (id: ResourceId, total: number) => void;
  /** False while the client is offline (buttons disabled). */
  canSell: boolean;
  /** Test-id prefix for the host panel. */
  testIdPrefix: string;
}

/**
 * The sell table body.
 */
export function SellTab({
  rows,
  onSellOne,
  onSellAll,
  canSell,
  testIdPrefix,
}: SellTabProps): React.JSX.Element {
  return (
    <div data-testid={`${testIdPrefix}-sell`}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.18)" }}>
            <th style={headerCell}>Resource</th>
            <th style={{ ...headerCell, textAlign: "right" }}>Price</th>
            <th style={{ ...headerCell, textAlign: "right" }}>Sellable</th>
            <th style={{ ...headerCell, textAlign: "right" }}>Earn (max)</th>
            <th style={headerCell}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const maxEarn = row.total * row.price;
            const weightPerUnit = CARGO_WEIGHT_PER_UNIT[row.id];
            return (
              <tr key={row.id} data-testid={`${testIdPrefix}-row-${row.id}`}>
                <td style={cell}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      background: RESOURCE_COLOURS[row.id],
                      marginRight: 6,
                      border: "1px solid rgba(255,255,255,0.18)",
                    }}
                  />
                  {row.id}
                  <span style={{ marginLeft: 6, opacity: 0.5, fontSize: 10 }}>
                    ({weightPerUnit}u)
                  </span>
                </td>
                <td style={{ ...cell, textAlign: "right" }}>{row.price} cr</td>
                <td style={{ ...cell, textAlign: "right" }}>
                  {row.total > 0 ? (
                    <>
                      {row.total}
                      <span style={{ opacity: 0.5, fontSize: 10, marginLeft: 6 }}>
                        ({row.invAmount}i + {row.cargoAmount}h)
                      </span>
                    </>
                  ) : (
                    <span style={{ opacity: 0.5 }}>—</span>
                  )}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  {maxEarn > 0 ? `${maxEarn} cr` : "—"}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() => onSellOne(row.id, 1)}
                      disabled={!canSell || row.total <= 0}
                      aria-label={`Sell 1 ${row.id}`}
                      style={actionButtonStyle(row.total > 0 && canSell)}
                    >
                      Sell 1
                    </button>
                    <button
                      type="button"
                      onClick={() => onSellAll(row.id, row.total)}
                      disabled={!canSell || row.total <= 0}
                      aria-label={`Sell all ${row.id}`}
                      style={actionButtonStyle(row.total > 0 && canSell)}
                    >
                      Sell all
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ marginTop: 12, opacity: 0.7, fontSize: 10 }}>
        Sell price = base price from the resource catalog. The catalog is the single source of
        truth; no per-station variation in v1.
      </p>
    </div>
  );
}

const headerCell: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  opacity: 0.7,
};

const cell: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

function actionButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.25)",
    color: enabled ? "#e6edf3" : "rgba(230,237,243,0.3)",
    padding: "3px 8px",
    cursor: enabled ? "pointer" : "not-allowed",
    fontFamily: "monospace",
    fontSize: 10,
  };
}
