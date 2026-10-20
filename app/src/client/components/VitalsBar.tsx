/**
 * VitalsBar — TASK-51.
 *
 * Top-left HUD widget showing the local ship's hull + shield bars
 * (200 px wide, two stacked tracks). Numbers fade in on hover so
 * the column stays clean in flight.
 *
 * A 300 ms CSS class flash fires on every self-directed `hit` /
 * `damaged` combat event (TASK-42). The flash math lives in
 * `combat/hud/vitals.ts`; this component is a pure renderer of
 * `(hullRatio, shieldRatio, flashing, hullText, shieldText)`.
 *
 * The bar reacts to:
 *   - **Server snapshot** — the local predictor's `state.hull /
 *     state.shields` are sourced straight from the simulator's
 *     authoritative state (TASK-23). The HUD never renders
 *     predicted values, per the spec.
 *   - **Self-hit flash** — `HitFlashController.recordSelfHit()` is
 *     invoked by an App-level subscription that filters incoming
 *     `combat_event` frames against the local ship id.
 */
import { useEffect, useRef, useState } from "react";
import type * as React from "react";

import {
  HitFlashController,
  VITALS_BAR_HEIGHT_PX,
  VITALS_BAR_WIDTH_PX,
  type LocalShipId,
  hullFillColor,
  shieldFillColor,
  vitalsRatio,
} from "../combat/hud/vitals.js";

/** Ship-side class max-hull / shield table (local-imported to avoid a
 *  circular import back into the shared barrel from the HUD math). */
import { SHIP_CLASSES, type ShipClassId } from "@shared/ships.js";

/** Props for the `VitalsBar`. */
export interface VitalsBarProps {
  /** Current hull HP (server snapshot). */
  hull: number | null;
  /** Current shield HP (server snapshot). */
  shields: number | null;
  /** Ship class id (drives the max HP table). */
  classId?: ShipClassId | string | null;
  /** When `true`, the 300 ms red flash overlay is active. */
  flashing?: boolean;
  /** Max hull when classId is unknown / null. */
  maxHullFallback?: number;
  /** Max shield when classId is unknown / null. */
  maxShieldFallback?: number;
}

/** Compute max hull / shield from a class id (with sane fallbacks). */
export function vitalsMaxFor(
  classId: ShipClassId | string | null | undefined,
  maxHullFallback: number,
  maxShieldFallback: number,
): { maxHull: number; maxShield: number } {
  if (classId === null || classId === undefined) {
    return { maxHull: maxHullFallback, maxShield: maxShieldFallback };
  }
  const entry = SHIP_CLASSES[classId as ShipClassId];
  if (entry === undefined) {
    return { maxHull: maxHullFallback, maxShield: maxShieldFallback };
  }
  return { maxHull: entry.hull, maxShield: entry.shieldCapacity };
}

/**
 * Top-left vitals bar (shield over hull). Hover-tooltip on each
 * track shows the exact numeric HP.  When `flashing === true` the
 * whole bar gets a 300 ms red overlay via the
 * `drift-ship-vitals-flash` class — the consumer is responsible
 * for setting the class and clearing it on time.
 */
export function VitalsBar(props: VitalsBarProps): React.JSX.Element {
  const { maxHull, maxShield } = vitalsMaxFor(
    props.classId ?? null,
    props.maxHullFallback ?? 100,
    props.maxShieldFallback ?? 50,
  );
  const hullValue = props.hull ?? 0;
  const shieldValue = props.shields ?? 0;
  const hullRatio = vitalsRatio(hullValue, maxHull);
  const shieldRatio = vitalsRatio(shieldValue, maxShield);
  const shieldColor = shieldFillColor(shieldRatio);
  const hullColor = hullFillColor(hullRatio);
  return (
    <div
      data-testid="drift-ship-vitals-bar"
      data-flash={props.flashing ? "active" : "idle"}
      style={{
        position: "fixed",
        top: 280,
        left: 16,
        width: VITALS_BAR_WIDTH_PX,
        height: VITALS_BAR_HEIGHT_PX,
        padding: "4px 8px",
        background: "rgba(12, 16, 24, 0.55)",
        border: "1px solid rgba(230, 237, 243, 0.18)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 2,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        color: "#e6edf3",
        pointerEvents: "auto",
        zIndex: 850,
      }}
    >
      <div
        data-testid="drift-ship-shield-bar"
        title={`Shields ${Math.round(shieldValue)} / ${maxShield}`}
        style={{
          position: "relative",
          width: "100%",
          height: 8,
          background: "rgba(255, 255, 255, 0.08)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <span
          data-testid="drift-ship-shield-fill"
          style={{
            display: "block",
            height: "100%",
            width: `${(shieldRatio * 100).toFixed(1)}%`,
            background: shieldColor,
            transition: "width 80ms linear, background 80ms linear",
          }}
        />
        <span
          data-testid="drift-ship-shield-label"
          style={{
            position: "absolute",
            left: 4,
            top: -2,
            fontSize: 9,
            letterSpacing: "0.14em",
            color: "rgba(255, 255, 255, 0.7)",
            textTransform: "uppercase",
          }}
        >
          SHD {Math.round(shieldValue)}
        </span>
      </div>
      <div
        data-testid="drift-ship-hull-bar"
        title={`Hull ${Math.round(hullValue)} / ${maxHull}`}
        style={{
          position: "relative",
          width: "100%",
          height: 8,
          background: "rgba(255, 255, 255, 0.08)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <span
          data-testid="drift-ship-hull-fill"
          style={{
            display: "block",
            height: "100%",
            width: `${(hullRatio * 100).toFixed(1)}%`,
            background: hullColor,
            transition: "width 80ms linear, background 80ms linear",
          }}
        />
        <span
          data-testid="drift-ship-hull-label"
          style={{
            position: "absolute",
            left: 4,
            top: -2,
            fontSize: 9,
            letterSpacing: "0.14em",
            color: "rgba(255, 255, 255, 0.7)",
            textTransform: "uppercase",
          }}
        >
          HULL {Math.round(hullValue)}
        </span>
      </div>
    </div>
  );
}

/** CSS keyframes block for the 300 ms flash. Appended to
 *  `index.html` once at app load; the App.tsx mount wires it.
 *  Exposed here so tests + dev seams can reference it. */
export const VITALS_FLASH_CLASS = "drift-ship-vitals-flash";
export const VITALS_FLASH_KEYFRAMES = `
@keyframes drift-vitals-flash {
  0%   { background-color: rgba(208, 72, 72, 0.85); }
  60%  { background-color: rgba(208, 72, 72, 0.55); }
  100% { background-color: rgba(12, 16, 24, 0.55); }
}
.${VITALS_FLASH_CLASS} {
  animation: drift-vitals-flash ${300}ms ease-out;
  border-color: rgba(208, 72, 72, 0.85) !important;
}
`;

/**
 * Install the flash keyframes + class on document load. Idempotent.
 * Returns the singleton CSSStyleElement so the e2e can assert it
 * was added.
 */
let installedStyle: HTMLStyleElement | null = null;
export function installVitalsFlashStyle(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  if (installedStyle !== null) return installedStyle;
  const style = document.createElement("style");
  style.dataset.driftVitalsFlash = "true";
  style.textContent = VITALS_FLASH_KEYFRAMES;
  document.head.appendChild(style);
  installedStyle = style;
  return installedStyle;
}

/**
 * React driver for `HitFlashController`. Polls the controller at
 * the 10 Hz HUD cadence so the React state flip matches the
 * frame-monitor's per-budget tick.
 */
export function useHitFlashState(
  controller: HitFlashController,
  now: () => number = () => Date.now(),
  pollMs: number = 100,
): boolean {
  const [flashing, setFlashing] = useState<boolean>(false);
  const [tick, setTick] = useState<number>(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);
  useEffect(() => {
    setFlashing(controller.isFlashing(now()));
  }, [tick, controller, now]);
  return flashing;
}

/** Convenience hook to construct a controller and wire self-hit events. */
export function useHitFlashController(): HitFlashController {
  const ref = useRef<HitFlashController | null>(null);
  if (ref.current === null) ref.current = new HitFlashController();
  return ref.current;
}

/** Helper for callers who need to translate a `combat_event` source id
 *  into a local-ship id (the wire shape uses `entity:<shipId>` for
 *  player ships; the player's own id resolved at auth time is the
 *  matching string for self-hit detection). */
export function localSelfIdFor(
  playerId: string | null,
  callsign: string | null,
): LocalShipId | null {
  if (callsign !== null && callsign.length > 0) return `entity:${callsign.toLowerCase()}`;
  if (playerId !== null && playerId.length > 0) return `entity:${playerId.toLowerCase()}`;
  return null;
}
