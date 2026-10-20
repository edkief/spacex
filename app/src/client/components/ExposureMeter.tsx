/**
 * Exposure meter — TASK-52 on-foot HUD.
 *
 * Bottom-right **vertical** bar that surfaces the player's hazard
 * exposure pool (TASK-48 server-timed). Sits above the WeightBar
 * (TASK-34) so the two bottom-right widgets never overlap.
 *
 * Spec:
 *
 *   - Vertical bar, 50 max.
 *   - Fill drops as exposure is drained; colour per
 *     `exposureBarColor`: green > 25, amber 10-25, red < 10.
 *   - The bar **flashes red** when the pool is below 10 or the
 *     player is recovering (CSS keyframe `drift-meter-pulse`).
 *   - **Recovering state**: when `recoveringUntilMs > now` the bar
 *     freezes, the readout swaps to "RECOVERING 5s" (counts down),
 *     and the border pulses red (`drift-recovering-pulse`).
 *   - **Hazard icon** to the left of the bar:
 *       - Radiation glyph (`☢`) when inside a radzone.
 *       - Storm swirl glyph (`🌀`) when inside a storm cell.
 *       - Drone glyph (`◆`) when inside a drones cell.
 *       - Neutral triangle when out of every hazard.
 *   - `initialEmpty` test seam keeps the meter hidden in unit tests
 *     that don't mount the live store.
 *
 * The component is dumb — it reads from the `HazardStore` via
 * `useSyncExternalStore`. The store owns the per-tick `now`
 * re-renders (TASK-52's "snapshot-driven" rule); this file does
 * not own timers.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type * as React from "react";

import type { HazardStore } from "../world/hazards.js";
import {
  EXPOSURE_MAX,
  exposureBarColor,
  exposureBarFraction,
  hazardGlyph,
  recoveringState,
  shouldFlashExposure,
} from "../combat/hud/onFoot.js";

/** Bottom-of-screen offset (px) — the meter sits above the weight bar. */
const EXPOSURE_BAR_HEIGHT_PX = 156;
const EXPOSURE_BAR_WIDTH_PX = 38;

/**
 * Local "now" tick used to drive the recovering countdown. The
 * store re-renders the snapshot only when a wire frame lands; we
 * need a 1-Hz local heartbeat so the seconds slot refreshes while
 * the bar itself stays frozen (the bar fill tracks `state.exposure`
 * which is held at 0 during recovery — only the seconds readout
 * needs the per-second tick).
 */
const RECOVERING_TICK_MS = 250;

/** Recovering-countdown pulse keyframes already registered in TASK-48. */
const PULSE_KEYFRAME_NAME = "drift-meter-pulse";
const RECOVERING_KEYFRAME_NAME = "drift-recovering-pulse";

/** Test seam — pretend the store hasn't been populated yet. */
export interface ExposureMeterProps {
  /** Live hazard store. */
  store: HazardStore;
  /** Override the bottom offset (px). */
  bottomPx?: number;
  /** Right offset (px). */
  rightPx?: number;
  /** Skip render — used by unit tests that don't mount the store. */
  initialEmpty?: boolean;
}

/**
 * Render the vertical exposure bar. Returns `null` for the test
 * `initialEmpty` path so callers can mount `<ExposureMeter>` once
 * at the App level without flashing a stub.
 */
export function ExposureMeter(props: ExposureMeterProps): React.JSX.Element | null {
  const { store } = props;
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.snapshot(),
    () => store.snapshot(),
  );

  // Local heartbeat so the countdown re-renders once a second
  // while the store's snapshot stays referentially stable. We
  // tear it down on unmount to avoid stray intervals.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), RECOVERING_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  if (props.initialEmpty) return null;

  const { state } = snapshot;
  const now = Date.now();
  const { recovering, secondsRemaining } = recoveringState(state.recoveringUntilMs, now);
  const fraction = exposureBarFraction(state.exposure);
  const color = exposureBarColor(state.exposure);
  const flashing = shouldFlashExposure(state.exposure, state.recoveringUntilMs, now);
  const glyph = hazardGlyph(state.currentHazard);

  // The bar height is animated via `height` on the fill rect — that
  // is a transform-level property the GPU can promote, so this costs
  // < 0.1 ms/frame on commodity hardware.
  return (
    <div
      data-testid="drift-exposure-meter"
      data-recovering={recovering ? "true" : "false"}
      data-current-hazard-kind={state.currentHazard?.kind ?? "none"}
      style={{
        position: "fixed",
        bottom: (props.bottomPx ?? 16) + 56,
        right: props.rightPx ?? 16,
        width: EXPOSURE_BAR_WIDTH_PX + 26,
        padding: "8px 10px",
        background: "rgba(20, 24, 32, 0.85)",
        border: recovering
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
        animation: recovering ? `${RECOVERING_KEYFRAME_NAME} 0.8s ease-in-out infinite` : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 4,
        }}
      >
        <HazardIcon family={glyph.family} color={glyph.color} />
        <span
          data-testid="drift-exposure-label"
          style={{ letterSpacing: "0.12em", textTransform: "uppercase" }}
        >
          EXPOSURE
        </span>
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "stretch",
        }}
      >
        {/* Vertical track + fill. */}
        <div
          data-testid="drift-exposure-track"
          style={{
            position: "relative",
            width: EXPOSURE_BAR_WIDTH_PX,
            height: EXPOSURE_BAR_HEIGHT_PX,
            background: "rgba(255, 255, 255, 0.08)",
            borderRadius: 4,
            overflow: "hidden",
            // Bottom-anchored fill: the empty bar gets taller as
            // exposure drops (so the player sees the bar drain
            // upward, mirroring a battery-style icon).
            display: "flex",
            alignItems: "flex-end",
          }}
        >
          <div
            data-testid="drift-exposure-fill"
            data-low={flashing ? "true" : "false"}
            style={{
              width: "100%",
              height: `${fraction * 100}%`,
              background: color,
              borderRadius: 4,
              transition: recovering
                ? "background 200ms linear"
                : "height 80ms linear, background 200ms linear",
              animation: flashing ? `${PULSE_KEYFRAME_NAME} 0.6s ease-in-out infinite` : undefined,
              opacity: recovering ? 0.6 : 1,
            }}
          />
        </div>
        {/* Vertical readout column: numeric exposure, or the
            recovering countdown. The component re-renders every
            tick so the seconds slot counts down without any
            additional rAF loop. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            alignItems: "flex-start",
            minWidth: 50,
          }}
        >
          {recovering ? (
            <div
              data-testid="drift-exposure-recovering-badge"
              style={{
                color: "#ff3344",
                fontWeight: 700,
                letterSpacing: "0.12em",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>RECOVERING</span>
              <span
                data-testid="drift-exposure-recovering-countdown"
                style={{ fontSize: 18, fontFamily: "monospace" }}
              >
                {secondsRemaining}s
              </span>
            </div>
          ) : (
            <span
              data-testid="drift-exposure-readout"
              style={{
                fontFamily: "monospace",
                fontVariantNumeric: "tabular-nums",
                color,
                fontSize: 14,
                lineHeight: 1.1,
              }}
            >
              {Math.round(state.exposure)}/{EXPOSURE_MAX}
            </span>
          )}
          <span
            data-testid="drift-exposure-max"
            style={{ fontFamily: "monospace", color: "rgba(230,237,243,0.5)", fontSize: 10 }}
          >
            0 / {EXPOSURE_MAX}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hazard icon — pure SVG so the unit test can assert by data-attribute.
// ---------------------------------------------------------------------------

function HazardIcon({
  family,
  color,
}: {
  family: ReturnType<typeof hazardGlyph>["family"];
  color: string;
}): React.JSX.Element {
  if (family === "radiation") {
    return (
      <svg
        data-testid="drift-exposure-hazard-icon"
        data-kind="radzone"
        viewBox="0 0 14 14"
        width={14}
        height={14}
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="2" fill={color} />
        <path d="M7 1 L9.5 6 L7 5 L4.5 6 Z" fill={color} />
        <path d="M7 13 L4.5 8 L7 9 L9.5 8 Z" fill={color} />
        <path d="M1 7 L6 4.5 L5 7 L6 9.5 Z" fill={color} />
        <path d="M13 7 L8 9.5 L9 7 L8 4.5 Z" fill={color} />
      </svg>
    );
  }
  if (family === "storm") {
    return (
      <svg
        data-testid="drift-exposure-hazard-icon"
        data-kind="storm"
        viewBox="0 0 14 14"
        width={14}
        height={14}
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth={1.5} />
        <circle cx="7" cy="7" r="1.5" fill={color} />
      </svg>
    );
  }
  if (family === "drones") {
    return (
      <svg
        data-testid="drift-exposure-hazard-icon"
        data-kind="drones"
        viewBox="0 0 14 14"
        width={14}
        height={14}
        aria-hidden="true"
      >
        <path
          d="M7 1 L13 7 L7 13 L1 7 Z"
          fill={color}
          fillOpacity={0.7}
          stroke={color}
          strokeWidth={1}
        />
      </svg>
    );
  }
  // Neutral hazard triangle (also used when out of every hazard).
  return (
    <span
      data-testid="drift-exposure-hazard-icon"
      data-kind="neutral"
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderLeft: "6px solid transparent",
        borderRight: "6px solid transparent",
        borderBottom: `10px solid ${color}`,
      }}
      aria-hidden="true"
    />
  );
}
