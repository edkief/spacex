/**
 * Cargo panel — TASK-39 ship cargo transfer UI.
 *
 * A DOM modal that mounts when the on-foot player presses the
 * cargo hotkey (`C`) at their docked ship. Two columns (backpack
 * stacks vs ship hold stacks) with per-row "Move 1" / "Move all"
 * buttons so the player can transfer resources in either
 * direction.
 *
 * ## Wire contract
 *
 *   - Send `cargo_transfer { resourceId, amount, from }` per
 *     click. The server validates ownership, proximity, and the
 *     destination cap before persisting either side.
 *   - Listen for `cargo_update` (the ack) to refresh the local
 *     cache. The hook reads `client.getCargo()` (or
 *     `client.getInventory()`) so the panel mirrors the same
 *     authoritative state the rest of the HUD uses.
 *
 * The panel hides when `open === false`. The "in flight, docked"
 * stub reachability is owned by the parent shell (TASK-51 owns
 * the ship HUD's Cargo button; TASK-39 owns the on-foot `[C]`
 * prompt which the EnterShipPanel enqueues).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type * as React from "react";

import type { CargoHold, CargoResourceType } from "@shared/world/cargo.js";
import { CARGO_RESOURCE_TYPES, CARGO_WEIGHT_PER_UNIT } from "@shared/world/cargo.js";
import type { Inventory } from "@shared/world/inventory.js";

import type { DriftClient } from "../net/wsClient.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Poll cadence for the cargo HUD — mirrors the weight bar (TASK-34). */
const POLL_MS = 250;

/** Per-row weight unit colour cue so the eye can spot rare-earths at a glance. */
const RESOURCE_COLOURS: Readonly<Record<CargoResourceType, string>> = {
  iron: "#9aa6b2",
  copper: "#d18a4f",
  "rare-earths": "#b48cf8",
  crystal: "#7adfff",
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Read the latest cargo hold off the DriftClient's HUD-friendly
 * accessor. Returns `null` until the first `cargo_update` frame
 * lands so the HUD doesn't briefly render an "infinite" bar.
 *
 * Polls every `POLL_MS` to mirror the inventory / weight-bar
 * cadence (TASK-34 / TASK-29). The DriftClient exposes a typed
 * `getCargo()` seam on the dev hook so the panel reads the
 * authoritative value without a separate copy.
 */
export function useOwnCargo(): CargoHold | null {
  const [cargo, setCargo] = useState<CargoHold | null>(null);
  useEffect(() => {
    const read = (): void => {
      const w = window as unknown as {
        __driftClient?: { getCargo?: () => CargoHold | null };
      };
      const next = w.__driftClient?.getCargo?.() ?? null;
      setCargo((prev) => {
        if (prev === null && next === null) return prev;
        if (prev === null || next === null) return next;
        if (
          prev.weightUsed !== next.weightUsed ||
          prev.capacity !== next.capacity ||
          !sameStacks(prev.stacks, next.stacks)
        ) {
          return next;
        }
        return prev;
      });
    };
    read();
    const id = window.setInterval(read, POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return cargo;
}

function sameStacks(
  a: Readonly<Partial<Record<CargoResourceType, number>>>,
  b: Readonly<Partial<Record<CargoResourceType, number>>>,
): boolean {
  const keys = Object.keys(a) as CargoResourceType[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Panel component
// ---------------------------------------------------------------------------

export interface CargoPanelProps {
  /** Drift client used to fire `cargo_transfer` frames. */
  client: DriftClient | null;
  /** Authoritative on-foot inventory (TASK-34). */
  inventory: Inventory | null;
  /** Authoritative ship cargo hold (TASK-39). */
  cargo: CargoHold | null;
  /** Whether the panel is open. */
  open: boolean;
  /** Close callback (typically wired to the `C` key handler). */
  onClose: () => void;
}

/**
 * Two-column modal. The left column is the player's inventory
 * (the "from" for `inv → hold` transfers); the right column is the
 * ship's hold (the "from" for `hold → inventory` transfers).
 * Per-row `→` / `←` buttons fire one `cargo_transfer` per click;
 * `→ all` / `← all` moves the entire stack.
 *
 * The panel is intentionally keyboard-friendly — `Esc` closes
 * it via the parent's `onClose` (the parent owns the hotkey
 * surface so the panel can mount at any time without stealing
 * focus from the main canvas).
 */
export function CargoPanel({
  client,
  inventory,
  cargo,
  open,
  onClose,
}: CargoPanelProps): React.JSX.Element | null {
  if (!open) return null;
  if (inventory === null || cargo === null) return null;

  const moveOne = useCallback(
    (resourceId: CargoResourceType, from: "inv" | "hold") => {
      if (!client) return;
      client.sendCargoTransfer(resourceId, 1, from);
    },
    [client],
  );
  const moveAll = useCallback(
    (resourceId: CargoResourceType, from: "inv" | "hold") => {
      if (!client) return;
      const source = from === "inv" ? inventory : cargo;
      const amount = source.stacks[resourceId] ?? 0;
      if (amount <= 0) return;
      client.sendCargoTransfer(resourceId, amount, from);
    },
    [client, inventory, cargo],
  );

  // Build the union of resource ids so the two columns line up.
  const allResources = useMemo(() => {
    const set = new Set<CargoResourceType>(CARGO_RESOURCE_TYPES);
    for (const key of Object.keys(inventory.stacks) as CargoResourceType[]) set.add(key);
    for (const key of Object.keys(cargo.stacks) as CargoResourceType[]) set.add(key);
    return [...set].sort();
  }, [inventory, cargo]);

  const invFill = Math.min(1, inventory.weightUsed / 40);
  const cargoFill = Math.min(1, cargo.weightUsed / Math.max(1, cargo.capacity));

  return (
    <div
      data-testid="drift-cargo-panel"
      role="dialog"
      aria-label="Cargo transfer"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,6,12,0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        fontFamily: "system-ui, sans-serif",
        color: "#e6edf3",
      }}
      onClick={(e) => {
        // Click on the backdrop closes the panel.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 720,
          maxWidth: "92vw",
          background: "#0b1018",
          border: "1px solid rgba(255,255,255,0.15)",
          padding: 16,
          fontFamily: "monospace",
          fontSize: 12,
          color: "#e6edf3",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            Cargo transfer
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cargo panel"
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.25)",
              color: "#e6edf3",
              padding: "4px 10px",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: 11,
            }}
          >
            Esc
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 1fr", gap: 12 }}>
          {/* Inventory column. */}
          <Column
            title={`Backpack ${inventory.weightUsed}/40`}
            fill={invFill}
            accent="#f5b94d"
            testId="drift-cargo-panel-inventory"
          >
            {allResources.map((id) => {
              const amount = inventory.stacks[id] ?? 0;
              const colour = RESOURCE_COLOURS[id];
              return (
                <ResourceRow
                  key={`in-${id}`}
                  resourceId={id}
                  amount={amount}
                  weightPerUnit={weightPerUnitFor(id)}
                  colour={colour}
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

          {/* Spacer column with `→` / `←` per-row buttons. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 28 }}>
            {allResources.map((id) => {
              const invAmount = inventory.stacks[id] ?? 0;
              const holdAmount = cargo.stacks[id] ?? 0;
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

          {/* Cargo column. */}
          <Column
            title={`Hold ${cargo.weightUsed}/${cargo.capacity}`}
            fill={cargoFill}
            accent="#7adfff"
            testId="drift-cargo-panel-cargo"
          >
            {allResources.map((id) => {
              const amount = cargo.stacks[id] ?? 0;
              const colour = RESOURCE_COLOURS[id];
              return (
                <ResourceRow
                  key={`hold-${id}`}
                  resourceId={id}
                  amount={amount}
                  weightPerUnit={weightPerUnitFor(id)}
                  colour={colour}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — split so the parent stays under the AGENTS.md line cap.
// ---------------------------------------------------------------------------

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

function weightPerUnitFor(id: CargoResourceType): number {
  return CARGO_WEIGHT_PER_UNIT[id];
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
