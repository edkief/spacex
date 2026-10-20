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
import { useEffect, useState } from "react";
import type * as React from "react";

import type { CargoHold, CargoResourceType } from "@shared/world/cargo.js";
import type { Inventory } from "@shared/world/inventory.js";

import type { DriftClient } from "../net/wsClient.js";
import { CargoTransferView } from "../ui/ship/CargoTransferView.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Poll cadence for the cargo HUD — mirrors the weight bar (TASK-34). */
const POLL_MS = 250;

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

        <CargoTransferView
          client={client}
          inventory={inventory}
          cargo={cargo}
          testIdPrefix="drift-cargo-panel"
        />
      </div>
    </div>
  );
}
