/**
 * SpeedReadout — TASK-51.
 *
 * Bottom-left HUD row, above the player list. Reads:
 *
 *   - **Speed** in m/s with one decimal place (spec: "speed in m/s
 *     (1 decimal)") — sourced from the local predictor's `state.vel`
 *     magnitude (server-authoritative — the spec calls out that
 *     "the HUD is for facts; prediction is for feel").
 *   - A small **thrust vector bar** that grows upward (positive
 *     throttle) or downward (reverse). Sits inline with the
 *     number, baseline-aligned.
 *
 * Polled at the 10 Hz HUD cadence — the rAF driver is only used
 * for the nav arrow + the target-box projection per
 * `combat/hud/timing.ts`.
 *
 * @see ../../shared/physics/vec.ts for `Vec3.magnitude`.
 */

import { useEffect, useState } from "react";
import type * as React from "react";

import { formatSpeed, thrustIndicatorFor } from "../combat/hud/shipReadout.js";

/** Props for the `SpeedReadout`. */
export interface SpeedReadoutProps {
  /** Local ship's speed in m/s (server snapshot). */
  speedMps: number | null;
  /** Local ship's throttle, normalised to `[-1, 1]`. */
  throttle: number | null;
}

/**
 * Format the speed's `SPD` label. The bar slot reserves 28 px for
 * the chevron + 4 px of right padding before the number.
 */
const BAR_HEIGHT_PX = 28;
const BAR_WIDTH_PX = 8;

/**
 * Bottom-left speed row. Shows the current ship speed in m/s with
 * one decimal place, plus a small vertical bar that grows from the
 * baseline in the thrust direction.
 */
export function SpeedReadout(props: SpeedReadoutProps): React.JSX.Element {
  const speed = props.speedMps ?? 0;
  const throttle = props.throttle ?? 0;
  const indicator = thrustIndicatorFor(throttle);
  return (
    <div
      data-testid="drift-ship-speed-readout"
      style={{
        position: "fixed",
        bottom: 264,
        left: 16,
        display: "flex",
        alignItems: "flex-end",
        gap: 8,
        padding: "4px 10px",
        background: "rgba(12, 16, 24, 0.55)",
        border: "1px solid rgba(230, 237, 243, 0.18)",
        borderRadius: 4,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        letterSpacing: "0.04em",
        color: "#e6edf3",
        pointerEvents: "none",
        zIndex: 850,
      }}
    >
      <span
        style={{
          fontSize: 10,
          letterSpacing: "0.18em",
          opacity: 0.65,
          paddingBottom: 4,
        }}
      >
        SPD
      </span>
      <span
        data-testid="drift-ship-speed-value"
        style={{
          minWidth: 56,
          textAlign: "right",
          paddingBottom: 4,
        }}
      >
        {formatSpeed(speed)}
      </span>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          position: "relative",
          width: BAR_WIDTH_PX,
          height: BAR_HEIGHT_PX,
          background: "rgba(230, 237, 243, 0.18)",
          borderRadius: 2,
        }}
      >
        <span
          data-testid="drift-ship-thrust-bar"
          data-positive={indicator.offsetPx >= 0 ? "true" : "false"}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            ...(indicator.offsetPx >= 0
              ? { top: 0, height: `${indicator.lengthPx}px` }
              : { bottom: `${-indicator.offsetPx}px`, height: `${indicator.lengthPx}px` }),
            background: indicator.offsetPx >= 0 ? "#7cc7ff" : "#f5b94d",
            borderRadius: 2,
            transition: "top 80ms linear, bottom 80ms linear, height 80ms linear",
          }}
        />
      </span>
    </div>
  );
}

/** Re-export the polled speed indicator hook so the host (App.tsx)
 *  drives the snapshot cadence in one place. */
export function useShipSpeedReadout(
  poll: () => { speedMps: number; throttle: number } | null,
  pollMs: number = 100,
): { speedMps: number; throttle: number } | null {
  const [value, setValue] = useState<{ speedMps: number; throttle: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const next = poll();
      setValue((prev) => {
        if (
          prev !== null &&
          next !== null &&
          prev.speedMps === next.speedMps &&
          prev.throttle === next.throttle
        ) {
          return prev;
        }
        return next;
      });
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [poll, pollMs]);
  return value;
}
