/**
 * Cargo transfer view — TASK-53 (TASK-39).
 *
 * The two-column transfer table (backpack ↔ ship hold). Extracted
 * from the original `CargoPanel` modal so the ship panel's Cargo
 * tab and the standalone cargo modal share ONE implementation.
 */
import { useCallback, useMemo } from "react";
import type * as React from "react";

import type { CargoHold, CargoResourceType } from "@shared/world/cargo.js";
import { CARGO_RESOURCE_TYPES, CARGO_WEIGHT_PER_UNIT } from "@shared/world/cargo.js";
import type { Inventory } from "@shared/world/inventory.js";

import type { DriftClient } from "../../net/wsClient.js";

/** Per-row weight unit colour cue so the eye can spot rare-earths. */
const RESOURCE_COLOURS: Readonly<Record<CargoResourceType, string>> = {
  iron: "#9aa6b2",
  copper: "#d18a4f",
  "rare-earths": "#b48cf8",
  crystal: "#7adfff",
};

/** Props for the transfer view. */
export interface CargoTransferViewProps {
  /** Drift client (fires `cargo_transfer` frames). */
  client: DriftClient | null;
  /** On-foot inventory (`null` while it is still loading). */
  inventory: Inventory | null;
  /** Ship cargo hold (`null` while it is still loading). */
  cargo: CargoHold | null;
  /** Test-id prefix for the host surface. */
  testIdPrefix: string;
}

/**
 * The transfer table. Works with `null` inputs so the panel can
 * render the tab while the authoritative state is still loading.
 */
export function CargoTransferView({
  client,
  inventory,
  cargo,
  testIdPrefix,
}: CargoTransferViewProps): React.JSX.Element {
  const moveOne = useCallback(
    (resourceId: CargoResourceType, from: "inv" | "hold") => {
      client?.sendCargoTransfer(resourceId, 1, from);
    },
    [client],
  );

  const moveAll = useCallback(
    (resourceId: CargoResourceType, from: "inv" | "hold") => {
      const source = from === "inv" ? inventory : cargo;
      const amount = source?.stacks[resourceId] ?? 0;
      if (amount <= 0) return;
      client?.sendCargoTransfer(resourceId, amount, from);
    },
    [client, inventory, cargo],
  );

  const allResources = useMemo(() => {
    const set = new Set<CargoResourceType>(CARGO_RESOURCE_TYPES);
    if (inventory !== null) {
      for (const key of Object.keys(inventory.stacks) as CargoResourceType[]) set.add(key);
    }
    if (cargo !== null) {
      for (const key of Object.keys(cargo.stacks) as CargoResourceType[]) set.add(key);
    }
    return [...set].sort();
  }, [inventory, cargo]);

  const invFill = inventory === null ? 0 : Math.min(1, inventory.weightUsed / 40);
  const cargoFill =
    cargo === null ? 0 : Math.min(1, cargo.weightUsed / Math.max(1, cargo.capacity));

  return (
    <div data-testid={`${testIdPrefix}-cargo`}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 1fr", gap: 12 }}>
        <Column
          title={`Backpack ${inventory?.weightUsed ?? 0}/40`}
          fill={invFill}
          accent="#f5b94d"
          testId={`${testIdPrefix}-inventory`}
        >
          {allResources.map((id) => {
            const amount = inventory?.stacks[id] ?? 0;
            return (
              <ResourceRow
                key={`in-${id}`}
                resourceId={id}
                amount={amount}
                weightPerUnit={CARGO_WEIGHT_PER_UNIT[id]}
                colour={RESOURCE_COLOURS[id]}
                empty={amount <= 0}
                actions={
                  amount > 0 ? (
                    <button
                      type="button"
                      onClick={() => moveAll(id, "inv")}
                      aria-label={`Move all ${id} from backpack`}
                      style={actionButtonStyle}
                    >
                      → all
                    </button>
                  ) : (
                    <span style={{ opacity: 0.4, fontSize: 10 }}>—</span>
                  )
                }
              />
            );
          })}
        </Column>

        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 28 }}>
          {allResources.map((id) => {
            const invAmount = inventory?.stacks[id] ?? 0;
            const holdAmount = cargo?.stacks[id] ?? 0;
            return (
              <div
                key={`bridge-${id}`}
                style={{
                  display: "flex",
                  gap: 2,
                  alignItems: "center",
                  justifyContent: "center",
                  height: 24,
                }}
              >
                <button
                  type="button"
                  onClick={() => moveOne(id, "inv")}
                  disabled={invAmount <= 0}
                  aria-label={`Move 1 ${id} to hold`}
                  style={arrowButtonStyle(invAmount > 0)}
                >
                  →
                </button>
                <button
                  type="button"
                  onClick={() => moveOne(id, "hold")}
                  disabled={holdAmount <= 0}
                  aria-label={`Move 1 ${id} to backpack`}
                  style={arrowButtonStyle(holdAmount > 0)}
                >
                  ←
                </button>
              </div>
            );
          })}
        </div>

        <Column
          title={`Hold ${cargo?.weightUsed ?? 0}/${cargo?.capacity ?? 0}`}
          fill={cargoFill}
          accent="#7adfff"
          testId={`${testIdPrefix}-hold`}
        >
          {allResources.map((id) => {
            const amount = cargo?.stacks[id] ?? 0;
            return (
              <ResourceRow
                key={`hold-${id}`}
                resourceId={id}
                amount={amount}
                weightPerUnit={CARGO_WEIGHT_PER_UNIT[id]}
                colour={RESOURCE_COLOURS[id]}
                empty={amount <= 0}
                actions={
                  amount > 0 ? (
                    <button
                      type="button"
                      onClick={() => moveAll(id, "hold")}
                      aria-label={`Move all ${id} from hold`}
                      style={actionButtonStyle}
                    >
                      ← all
                    </button>
                  ) : (
                    <span style={{ opacity: 0.4, fontSize: 10 }}>—</span>
                  )
                }
              />
            );
          })}
        </Column>
      </div>
    </div>
  );
}

import { actionButtonStyle, arrowButtonStyle, Column, ResourceRow } from "./cargoRows.js";
