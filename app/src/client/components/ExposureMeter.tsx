/**
 * Exposure meter — TASK-48.
 *
 * Bottom-right HUD widget that surfaces the player's personal
 * exposure pool. Spec:
 *
 *   - A horizontal bar (width = exposure / 50, colour
 *     yellow → red → flashing red near 0).
 *   - When recovering is set, a "RECOVERING" badge replaces the
 *     numeric readout.
 *   - When the meter is below 10 % the bar flashes red
 *     (`pulse-red` keyframe — 0.6 s cycle, 50 % opacity dim).
 *   - When in a hazard cell, a small triangle hazard icon lights up
 *     to the left of the bar.
 *
 * The component is dumb — it reads from the `HazardStore` via
 * `useSyncExternalStore`. The store is the source of truth for
 * exposure / recovering / in-hazard; the React layer doesn't
 * manage timers or GC.
 *
 * Position: bottom-right, above the WeightBar (TASK-34) which
 * sits in the same slot. We offset by 56 px so the two widgets
 * don't overlap.
 */

import { useSyncExternalStore } from "react";
import type * as React from "react";

import type { HazardStore } from "../world/hazards.js";
import { HAZARD_EXPOSURE_MAX } from "@shared/world/hazards.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExposureMeterProps {
  /** Live hazard store. */
  store: HazardStore;
  /** Optional override for the bottom offset (px). */
  bottomPx?: number;
  /** Test seam — render with no live store. */
  initialEmpty?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Bottom-right exposure meter. Renders nothing when the store's
 * state hasn't been populated yet (so the slot stays invisible
 * for players who never enter a hazard cell — most matches will
 * not have the player landing on a hazard cell right away).
 *
 * The component is mounted unconditionally at the App level so
 * a future warp into a hazard system surfaces it on the same
 * frame the state lands.
 */
export function ExposureMeter(props: ExposureMeterProps): React.JSX.Element | null {
  const { store } = props;
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.snapshot(),
    () => store.snapshot(),
  );

  // The "freshly mounted" state has `receivedAtMs: Date.now()` —
  // a player who hasn't seen a hazard_update yet has full
  // exposure. We always render the bar so the player sees the
  // meter's presence; the only suppression case is the test
  // seam.
  if (props.initialEmpty) {
    return null;
  }

  const { state } = snapshot;
  const exposureFraction = state.exposure / HAZARD_EXPOSURE_MAX;
  const isRecovering = state.recoveringUntilMs > Date.now();
  const isLow = exposureFraction < 0.2;
  const isCritical = exposureFraction < 0.1;
  const barColor = isCritical ? "#ff3344" : isLow ? "#f59e0b" : "#34d399";

  return (
    <div
      data-testid="drift-exposure-meter"
      style={{
        position: "fixed",
        bottom: (props.bottomPx ?? 16) + 56,
        right: 16,
        width: 220,
        padding: "8px 10px",
        background: "rgba(20, 24, 32, 0.85)",
        border: isCritical
          ? "1px solid rgba(255, 51, 68, 0.7)"
          : "1px solid rgba(255, 255, 255, 0.12)",
        borderRadius: 6,
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        letterSpacing: "0.06em",
        zIndex: 900,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span
          data-testid="drift-exposure-label"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {/* Hazard triangle icon — lights up when inside a cell. */}
          <span
            data-testid="drift-exposure-hazard-icon"
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderBottom: state.inHazard
                ? "9px solid #ff3344"
                : "9px solid rgba(255, 255, 255, 0.25)",
            }}
            aria-hidden="true"
          />
          EXPOSURE
        </span>
        {isRecovering ? (
          <span
            data-testid="drift-exposure-recovering-badge"
            style={{
              color: "#ff3344",
              fontWeight: 600,
              letterSpacing: "0.12em",
              animation: "drift-recovering-pulse 0.8s ease-in-out infinite",
            }}
          >
            SHIELD BURN
          </span>
        ) : (
          <span
            data-testid="drift-exposure-readout"
            style={{
              fontVariantNumeric: "tabular-nums",
              color: barColor,
            }}
          >
            {Math.round(state.exposure)} / {HAZARD_EXPOSURE_MAX}
          </span>
        )}
      </div>
      {/* Bar track + fill. */}
      <div
        data-testid="drift-exposure-track"
        style={{
          position: "relative",
          height: 8,
          background: "rgba(255, 255, 255, 0.08)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          data-testid="drift-exposure-fill"
          data-low={isLow ? "true" : "false"}
          style={{
            position: "absolute",
            inset: 0,
            width: `${Math.max(0, Math.min(1, exposureFraction)) * 100}%`,
            background: barColor,
            borderRadius: 4,
            transition: "width 80ms linear, background 200ms linear",
            animation: isCritical ? "drift-meter-pulse 0.6s ease-in-out infinite" : undefined,
          }}
        />
      </div>
    </div>
  );
}
