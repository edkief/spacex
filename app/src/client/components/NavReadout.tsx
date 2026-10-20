/**
 * NavReadout — TASK-51.
 *
 * Floating top-right HUD widget that shows the pilot's nav
 * readout to a selected chart target (TASK-7) or, when no chart
 * target is set, the implicit dock target (the nearest station).
 *
 * The component renders:
 *   - **Bearing glyph** — `↑` / `↗` / `↘` etc. rotating around the
 *     ship's yaw (the chevron's `transform: rotate(Ydeg)`).
 *   - **Distance label** — `12.4 km` or `342 m` (formatted via
 *     `formatNavDistance`).
 *
 * Performance contract: the chevron's rotation is written once
 * per `requestAnimationFrame` onto a ref'd node — no React
 * re-render, only one style write. The state-driven updates (target
 * selection swap / distance label change) come from the 10 Hz HUD
 * cadence so the React layer only ticks when the underlying data
 * shifts.
 *
 * @see ../combat/hud/nav.ts for the bearing math.
 */
import { useEffect, useRef } from "react";
import type * as React from "react";

import type { Vec3Like } from "../camera/types.js";
import { cardinalGlyphFor, navReadoutFor, type NavReadout } from "../combat/hud/nav.js";
import { timeHudWork } from "../combat/hud/timing.js";
import type { FrameMonitor } from "../perf/frameMonitor.js";

/** Bearing-glyph size in CSS pixels. */
export const NAV_GLYPH_PX = 24;

/** Box footprint. */
const BOX_WIDTH = 220;
const BOX_HEIGHT = 44;

/** Inputs for the nav readout. */
export interface NavReadoutInputs {
  /** Local ship's world position. */
  shipPos: Vec3Like | null;
  /** Local ship's orientation quaternion. */
  shipQuat: { x: number; y: number; z: number; w: number } | null;
  /** Selected chart target world position (system centre). */
  chartTargetPos: Vec3Like | null;
  /** Implicit dock fallback world position. */
  dockTargetPos: Vec3Like | null;
  /** True when the regime is `space` (vertical component enabled). */
  isSpace: boolean;
}

export interface NavReadoutProps {
  inputs: NavReadoutInputs;
  monitor?: FrameMonitor | null;
}

/**
 * Compute the effective target — chart target first, dock fallback
 * second. Exported so the unit suite can exercise the heuristic
 * without a real frame loop.
 */
export function selectNavTarget(
  inputs: NavReadoutInputs,
): { pos: Vec3Like; source: "chart" | "dock" } | null {
  if (inputs.chartTargetPos !== null && inputs.chartTargetPos !== undefined) {
    return { pos: inputs.chartTargetPos, source: "chart" };
  }
  if (inputs.dockTargetPos !== null && inputs.dockTargetPos !== undefined) {
    return { pos: inputs.dockTargetPos, source: "dock" };
  }
  return null;
}

/** Compute the readout math from inputs. */
export function readoutForInputs(inputs: NavReadoutInputs): {
  readout: NavReadout;
  source: "chart" | "dock" | null;
} {
  const target = selectNavTarget(inputs);
  if (target === null) {
    return {
      readout: { bearingDeg: 0, verticalDeg: 0, distanceM: 0, distanceLabel: "—", valid: false },
      source: null,
    };
  }
  if (inputs.shipPos === null || inputs.shipQuat === null) {
    return {
      readout: { bearingDeg: 0, verticalDeg: 0, distanceM: 0, distanceLabel: "—", valid: false },
      source: target.source,
    };
  }
  const readout = navReadoutFor({
    shipPos: inputs.shipPos,
    shipQuat: inputs.shipQuat,
    targetPos: target.pos,
    isSpace: inputs.isSpace,
  });
  return { readout, source: target.source };
}

/**
 * The nav widget — chevron + distance + (optionally) tag label.
 */
export function NavReadout(props: NavReadoutProps): React.JSX.Element | null {
  const { readout, source } = readoutForInputs(props.inputs);
  const chevronRef = useRef<HTMLSpanElement | null>(null);
  const distanceRef = useRef<HTMLSpanElement | null>(null);
  const verticalRef = useRef<HTMLSpanElement | null>(null);

  // Chevron rAF: 1 style write per frame (rotation + vertical lift).
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      timeHudWork(
        () => {
          if (!readout.valid) return;
          const node = chevronRef.current;
          if (node === null) return;
          node.style.transform = `translate(-50%, -50%) rotate(${readout.bearingDeg.toFixed(1)}deg) translateY(${-readout.verticalDeg.toFixed(1)}px)`;
          const d = distanceRef.current;
          if (d !== null) d.textContent = readout.distanceLabel;
        },
        { monitor: props.monitor ?? null },
      );
      raf = requestAnimationFrame(tick);
    };
    if (readout.valid) {
      raf = requestAnimationFrame(tick);
    } else if (distanceRef.current !== null) {
      // Render `—` when invalid so the placeholder doesn't visibly churn.
      distanceRef.current.textContent = "—";
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [
    readout.bearingDeg,
    readout.distanceLabel,
    readout.valid,
    readout.verticalDeg,
    props.monitor,
  ]);

  if (!readout.valid || source === null) {
    return null;
  }
  return (
    <div
      data-testid="drift-ship-nav-readout"
      data-nav-source={source}
      style={{
        position: "fixed",
        right: 16,
        top: 60,
        width: BOX_WIDTH,
        height: BOX_HEIGHT,
        padding: "4px 10px",
        background: "rgba(12, 16, 24, 0.55)",
        border: "1px solid rgba(230, 237, 243, 0.18)",
        borderRadius: 4,
        color: "#e6edf3",
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        letterSpacing: "0.04em",
        display: "flex",
        alignItems: "center",
        gap: 8,
        pointerEvents: "none",
        zIndex: 850,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          width: NAV_GLYPH_PX,
          height: NAV_GLYPH_PX,
          flex: "0 0 auto",
        }}
      >
        <span
          ref={verticalRef}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            ref={chevronRef}
            data-testid="drift-ship-nav-chevron"
            data-glyph={cardinalGlyphFor(readout.bearingDeg)}
            style={{
              display: "inline-block",
              fontSize: 24,
              lineHeight: "24px",
              transformOrigin: "center",
              color: "#7cc7ff",
              textShadow: "0 0 4px rgba(124, 199, 255, 0.6)",
              willChange: "transform",
            }}
          >
            {cardinalGlyphFor(readout.bearingDeg)}
          </span>
        </span>
      </span>
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          fontSize: 10,
          letterSpacing: "0.06em",
        }}
      >
        <span
          style={{
            opacity: 0.6,
            fontSize: 9,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          {source === "chart" ? "NAV → CHART" : "NAV → STATION"}
        </span>
        <span
          ref={distanceRef}
          data-testid="drift-ship-nav-distance"
          style={{
            fontSize: 14,
            letterSpacing: "0.04em",
            color: "#e6edf3",
          }}
        >
          {readout.distanceLabel}
        </span>
      </span>
    </div>
  );
}
