/**
 * WeightBar — TASK-34 on-foot inventory HUD.
 *
 * A compact 120 px-wide strip showing the player's carry weight
 * (`weightUsed` / 40). Sits at the bottom-right so it doesn't
 * collide with the existing interaction prompt (bottom-centre) or
 * the player list (bottom-left).
 *
 * Colour bar:
 *   - default: light grey
 *   - 70-95 %  : amber (#f5b94d)
 *   - ≥ 95 %  : red (#d04848)
 *
 * The component pulls the inventory through `useOwnInventory`, a
 * tiny polling hook that mirrors the pattern used by
 * `useOwnShipOnPad` / `useInteractables` (TASK-29 / TASK-33). The
 * WS layer pushes `inventory_update` frames which the Drift
 * client applies via `applyInventoryUpdate`; the hook re-reads
 * the latest snapshot every 250 ms.
 *
 * Acceptance criterion (TASK-34):
 *   "Inventory HUD: a compact weight bar (weightUsed/40) bottom-right
 *    + item counts on hover; updates on every inventory change within
 *    one snapshot"
 */
import { useEffect, useState } from "react";
import type * as React from "react";
import type { Inventory } from "@shared/world/inventory.js";
import { INVENTORY_WEIGHT_CAP } from "@shared/world/inventory.js";

const POLL_MS = 250;

/**
 * Read the latest inventory off the DriftClient's HUD-friendly
 * accessor. The hook returns `null` until the first
 * `inventory_update` frame lands so the HUD doesn't briefly render
 * an "infinite" bar.
 */
export function useOwnInventory(): Inventory | null {
  const [inv, setInv] = useState<Inventory | null>(null);
  useEffect(() => {
    const read = (): void => {
      const w = window as unknown as { __driftClient?: { getInventory?: () => Inventory | null } };
      const next = w.__driftClient?.getInventory?.() ?? null;
      setInv((prev) => {
        if (prev === null && next === null) return prev;
        if (prev === null || next === null) return next;
        if (prev.weightUsed !== next.weightUsed || !sameStacks(prev.stacks, next.stacks)) {
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
  return inv;
}

function sameStacks(
  a: Readonly<Partial<Record<string, number>>>,
  b: Readonly<Partial<Record<string, number>>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  }
  return true;
}

/**
 * Decide the bar colour per spec:
 *   red  : weightUsed / cap >= 0.95
 *   amber: weightUsed / cap >= 0.70
 *   grey : otherwise
 */
function barColour(weightUsed: number): string {
  const ratio = weightUsed / INVENTORY_WEIGHT_CAP;
  if (ratio >= 0.95) return "#d04848";
  if (ratio >= 0.7) return "#f5b94d";
  return "#9aa6b2";
}

export interface WeightBarProps {
  inventory: Inventory | null;
}

/**
 * Bottom-right weight bar. Renders a 120 px wide strip with the
 * numeric `weightUsed/40` reads on top. On hover a tooltip lists
 * every non-zero stack with its amount.
 *
 * Hidden when `inventory === null` (mid-handshake) so the HUD
 * doesn't flicker.
 */
export function WeightBar({ inventory }: WeightBarProps): React.JSX.Element | null {
  const [hover, setHover] = useState(false);
  if (inventory === null) return null;
  const used = inventory.weightUsed;
  const fill = Math.min(1, Math.max(0, used / INVENTORY_WEIGHT_CAP));
  const colour = barColour(used);
  const stacks = (Object.entries(inventory.stacks) as Array<[string, number]>)
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    <div
      data-testid="drift-weight-bar"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        width: 120,
        fontFamily: "system-ui, sans-serif",
        color: "#e6edf3",
        userSelect: "none",
        pointerEvents: "auto",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          opacity: 0.75,
          marginBottom: 4,
          fontFamily: "monospace",
        }}
      >
        Carry {used}/{INVENTORY_WEIGHT_CAP}
      </div>
      <div
        style={{
          height: 6,
          border: "1px solid rgba(255,255,255,0.25)",
          background: "rgba(0,0,0,0.4)",
          position: "relative",
        }}
        aria-label="carry-weight"
      >
        <div
          style={{
            width: `${fill * 100}%`,
            height: "100%",
            background: colour,
            transition: "width 120ms ease-out, background-color 120ms",
          }}
        />
      </div>
      {hover && stacks.length > 0 ? (
        <div
          data-testid="drift-weight-bar-tooltip"
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "rgba(0,0,0,0.7)",
            border: "1px solid rgba(255,255,255,0.18)",
            fontFamily: "monospace",
            fontSize: 11,
            lineHeight: 1.4,
            borderRadius: 4,
          }}
        >
          {stacks.map(([id, amount]) => (
            <div key={id}>
              {id} ×{amount}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default WeightBar;
