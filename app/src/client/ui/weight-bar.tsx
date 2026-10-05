import React from 'react';

import { inventory, inventorySubscribe, type InventoryView } from '@client/state/inventory';
import { INVENTORY_MAX_WEIGHT, listStacks, RESOURCE_WEIGHTS } from '@shared/inventory';

/**
 * Inventory weight bar (TASK-34) — the compact #weight-bar HUD, bottom-right:
 * a 120 px bar filled by weightUsed/40. Fill color: default up to 70% of the
 * cap, AMBER near the cap (≥ 70%), RED at the cap (100% — no room left).
 * Hovering the bar lists the stacks ('iron x3 (3u)') — item counts on hover.
 *
 * Driven by state/inventory (the server's self entity_update — the bar
 * updates within one snapshot of any pickup/drop). Cosmetic only; null
 * (unmounted) until the server reports an inventory for the player.
 */

/** Fill fraction at which the bar turns amber (the "near the cap" band). */
export const WEIGHT_NEAR_CAP_FRACTION = 0.7;

/** Pure fill color for a weight value (testable without a DOM). */
export function weightBarColor(weightUsed: number, max: number = INVENTORY_MAX_WEIGHT): string {
  const fraction = max > 0 ? weightUsed / max : 0;
  if (fraction >= 1) return '#ef4444'; // red at the cap
  if (fraction >= WEIGHT_NEAR_CAP_FRACTION) return '#f59e0b'; // amber near the cap
  return '#67e8f9'; // default
}

/** The hover tooltip lines: one per non-empty stack (catalog order). */
export function weightBarHoverLines(inv: InventoryView | null): string[] {
  if (!inv) return [];
  return listStacks(inv.stacks).map(
    (s) => `${s.resourceId} x${s.amount} (${s.amount * RESOURCE_WEIGHTS[s.resourceId]}u)`,
  );
}

function useInventory(): InventoryView | null {
  const [inv, setInv] = React.useState(inventory); // lazy init: current value
  React.useEffect(() => inventorySubscribe(setInv), []);
  return inv;
}

const BAR_WIDTH_PX = 120;

export function WeightBar(): React.ReactElement | null {
  const inv = useInventory();
  const [hover, setHover] = React.useState(false);
  if (!inv) return null;
  const fraction = Math.min(1, inv.weightUsed / INVENTORY_MAX_WEIGHT);
  const lines = weightBarHoverLines(inv);
  return (
    <div
      id="weight-bar"
      role="status"
      aria-label={`weight ${inv.weightUsed} of ${INVENTORY_MAX_WEIGHT}`}
      style={{
        position: 'fixed',
        bottom: '2rem',
        right: '2rem',
        zIndex: 85, // above canvas (0) + re-entry tint (80); below the star chart (90)
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.7rem',
        color: '#9fb0c3',
        pointerEvents: 'auto',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {hover && lines.length > 0 && (
        <div
          style={{
            marginBottom: 4,
            textAlign: 'right',
            background: 'rgba(17, 21, 31, 0.92)',
            border: '1px solid #2a3346',
            borderRadius: 4,
            padding: '0.25rem 0.5rem',
            lineHeight: 1.4,
          }}
        >
          {lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      <div style={{ marginBottom: 2, textAlign: 'right' }}>
        {inv.weightUsed}/{INVENTORY_MAX_WEIGHT}u
      </div>
      <div
        style={{
          width: BAR_WIDTH_PX,
          height: 8,
          border: '1px solid #2a3346',
          borderRadius: 3,
          background: 'rgba(17, 21, 31, 0.85)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${fraction * 100}%`,
            height: '100%',
            background: weightBarColor(inv.weightUsed),
            transition: 'width 120ms linear, background 120ms linear',
          }}
        />
      </div>
    </div>
  );
}
