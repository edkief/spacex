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

interface ColumnProps {
  title: string;
  fill: number;
  accent: string;
  testId: string;
  children: React.ReactNode;
}

function Column({ title, fill, accent, testId, children }: ColumnProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      style={{
        border: "1px solid rgba(255,255,255,0.12)",
        padding: 8,
        background: "rgba(0,0,0,0.3)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          marginBottom: 6,
          opacity: 0.85,
        }}
      >
        {title}
      </div>
      <div
        style={{
          height: 4,
          border: "1px solid rgba(255,255,255,0.15)",
          marginBottom: 8,
          position: "relative",
        }}
      >
        <div
          style={{
            width: `${fill * 100}%`,
            height: "100%",
            background: accent,
            transition: "width 120ms ease-out",
          }}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}

interface ResourceRowProps {
  resourceId: CargoResourceType;
  amount: number;
  weightPerUnit: number;
  colour: string;
  empty: boolean;
  actions: React.ReactNode;
}

function ResourceRow({
  resourceId,
  amount,
  weightPerUnit,
  colour,
  empty,
  actions,
}: ResourceRowProps): React.JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto auto",
        gap: 8,
        alignItems: "center",
        padding: "4px 6px",
        background: empty ? "transparent" : "rgba(255,255,255,0.04)",
        opacity: empty ? 0.45 : 1,
        height: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            background: colour,
            border: "1px solid rgba(255,255,255,0.18)",
          }}
        />
        <span style={{ minWidth: 70 }}>{resourceId}</span>
      </div>
      <div style={{ minWidth: 60, textAlign: "right" }}>
        {amount > 0 ? `${amount} (${amount * weightPerUnit}u)` : "—"}
      </div>
      <div style={{ minWidth: 56, textAlign: "right" }}>{actions}</div>
    </div>
  );
}

const actionButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.25)",
  color: "#e6edf3",
  padding: "2px 6px",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 10,
};

function arrowButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.25)",
    color: enabled ? "#e6edf3" : "rgba(230,237,243,0.3)",
    cursor: enabled ? "pointer" : "not-allowed",
    width: 22,
    height: 22,
    padding: 0,
    fontFamily: "monospace",
    fontSize: 12,
  };
}
