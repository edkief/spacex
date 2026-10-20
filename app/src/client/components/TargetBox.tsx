/**
 * TargetBox — TASK-50 step 1.
 *
 * A bracket box drawn around the locked target's projected screen
 * position, with the target's callsign (or AI name + `AI` tag),
 * live range, hull + shield bars, and a weapon-locked indicator
 * when the target has locked us (TASK-44 `targetedBy`).
 *
 * **Performance contract**: the box's *contents* render at the
 * 10 Hz snapshot cadence (the `TargetingStore` push rate), while
 * the *screen position* is updated from a `requestAnimationFrame`
 * loop that writes `style.transform` + `style.display` onto a
 * ref'd node. No per-frame React re-render, no state churn — just
 * one style write inside the `hud` frame-monitor budget.
 *
 * @see ../combat/hud/projection.ts for the world → screen math.
 * @see ../combat/targeting.ts for the store this reads.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import type * as React from "react";

import { SHIP_CLASSES, type ShipClassId } from "@shared/ships.js";
import type { Vec3Like } from "../camera/types.js";
import type { TargetBoxEntry, TargetingStore } from "../combat/targeting.js";
import {
  TARGET_BOX_MAX_RANGE_M,
  barRatio,
  projectTargetToScreen,
} from "../combat/hud/projection.js";
import { timeHudWork } from "../combat/hud/timing.js";
import type { FrameMonitor } from "../perf/frameMonitor.js";

/** Fallback max hull / shield when the target's class is unknown. */
export const FALLBACK_TARGET_MAX_HULL = 100;
export const FALLBACK_TARGET_MAX_SHIELD = 50;

/** Bracket box footprint in CSS pixels. */
export const TARGET_BOX_W = 180;
export const TARGET_BOX_H = 90;

/**
 * Dev / e2e screen-position seam. `App.tsx` exposes this object on
 * `window.__driftCombatHud` so a Playwright run can pin the box to
 * a fixed screen point without a live target in the cone. Production
 * never writes to it (the box falls back to the live projection).
 */
export const targetBoxScreenOverride: { current: { x: number; y: number } | null } = {
  current: null,
};

/** A single live sample of the world-space data the box needs. */
export interface TargetBoxSample {
  /** Camera world position. */
  camPos: Vec3Like;
  /** Camera forward unit vector. */
  camForward: Vec3Like;
  /** Locked target world position. */
  targetPos: Vec3Like;
  /** True when the locked target currently has us locked. */
  lockedByTarget?: boolean;
  /** Viewport size in CSS pixels. */
  viewportW: number;
  viewportH: number;
}

/** Source of live world-space samples for the box. */
export type TargetBoxSource = () => TargetBoxSample | null;

/** Props for the `TargetBox`. */
export interface TargetBoxProps {
  /** Targeting store (server-driven lock + live target stats). */
  store: TargetingStore;
  /** Live world-space sampler. Returns `null` when unknown. */
  source: TargetBoxSource;
  /** Optional frame monitor for the `hud` budget check. */
  monitor?: FrameMonitor | null;
  /**
   * Dev / e2e seam — force a fixed screen position (pixels) so a
   * Playwright run can screenshot the bracket without a live
   * target. Production never sets this.
   */
  screenOverride?: { x: number; y: number } | null;
}

/**
 * Absolute max hull / shield for a target class id. Unknown class
 * ids fall back to the constants above so the bars still render.
 */
export function targetMaxStats(classId: string | null): { hull: number; shields: number } {
  if (classId === null) {
    return { hull: FALLBACK_TARGET_MAX_HULL, shields: FALLBACK_TARGET_MAX_SHIELD };
  }
  const entry = SHIP_CLASSES[classId as ShipClassId];
  if (!entry) return { hull: FALLBACK_TARGET_MAX_HULL, shields: FALLBACK_TARGET_MAX_SHIELD };
  return { hull: entry.hull, shields: entry.shieldCapacity };
}

/** Display name for the locked row: callsign, or AI name + tag. */
export function targetDisplayName(entry: TargetBoxEntry): { name: string; isAi: boolean } {
  if (entry.callsign) return { name: entry.callsign, isAi: entry.classId === null };
  const name = entry.classId ? `${entry.classId.toUpperCase()} WING` : "UNKNOWN CONTACT";
  return { name, isAi: true };
}

/** The bracket + readout. Returns `null` when nothing is locked. */
export function TargetBox(props: TargetBoxProps): React.JSX.Element | null {
  const entry = useSyncExternalStore(
    (listener) => props.store.subscribe(listener),
    () => props.store.getLocked(),
    () => props.store.getLocked(),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const distanceRef = useRef<HTMLSpanElement | null>(null);

  // rAF driver: one style write per frame, no React state.
  useEffect(() => {
    if (entry === null) return;
    const node = rootRef.current;
    if (node === null) return;
    let raf = 0;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      timeHudWork(
        () => {
          let screen: { x: number; y: number; visible: boolean } | null = null;
          if (props.screenOverride ?? targetBoxScreenOverride.current) {
            const override = props.screenOverride ?? targetBoxScreenOverride.current;
            if (override) screen = { ...override, visible: true };
          } else {
            const sample = props.source();
            if (sample !== null) {
              const projection = projectTargetToScreen({
                camPos: sample.camPos,
                camForward: sample.camForward,
                targetPos: sample.targetPos,
                viewportW: sample.viewportW,
                viewportH: sample.viewportH,
              });
              screen = { x: projection.x, y: projection.y, visible: projection.visible };
              if (projection.visible && distanceRef.current) {
                distanceRef.current.textContent = `${Math.round(projection.distanceM)} m`;
              }
            }
          }
          if (screen === null || node === null) return;
          node.style.display = screen.visible ? "block" : "none";
          node.style.transform = `translate3d(${Math.round(screen.x - TARGET_BOX_W / 2)}px, ${Math.round(screen.y - TARGET_BOX_H / 2)}px, 0)`;
        },
        { monitor: props.monitor ?? null },
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [entry, props]);

  if (entry === null) return null;

  const max = targetMaxStats(entry.classId);
  const hullRatio = barRatio(entry.hull, max.hull);
  const shieldRatio = barRatio(entry.shields, max.shields);
  const display = targetDisplayName(entry);
  const lockedByTarget = props.source()?.lockedByTarget === true;

  return (
    <div
      ref={rootRef}
      data-testid="drift-target-box"
      data-hide-reason={null}
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: TARGET_BOX_W,
        height: TARGET_BOX_H,
        pointerEvents: "none",
        zIndex: 900,
        fontFamily: "system-ui, sans-serif",
        color: "#e6edf3",
        border: "1px solid rgba(245, 185, 77, 0.85)",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.35)",
        background: "rgba(12, 16, 24, 0.35)",
        userSelect: "none",
      }}
    >
      <div
        data-testid="drift-target-box-name"
        style={{
          fontSize: 11,
          letterSpacing: "0.08em",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          padding: "2px 6px",
        }}
      >
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {display.name}
          {display.isAi ? (
            <span data-testid="drift-target-box-ai-tag" style={{ marginLeft: 4, opacity: 0.8 }}>
              AI
            </span>
          ) : null}
        </span>
        <span
          ref={distanceRef}
          data-testid="drift-target-box-distance"
          style={{ whiteSpace: "nowrap" }}
        >
          {Math.round(entry.range)} m
        </span>
      </div>
      <div style={{ padding: "0 6px" }}>
        <div style={{ height: 4, background: "#1b1f29", marginTop: 4 }}>
          <div
            data-testid="drift-target-box-hull"
            style={{
              height: "100%",
              width: `${(hullRatio * 100).toFixed(1)}%`,
              background: hullRatio > 0.35 ? "#6ee7a8" : "#f5b94d",
            }}
          />
        </div>
        <div style={{ height: 4, background: "#1b1f29", marginTop: 3 }}>
          <div
            data-testid="drift-target-box-shield"
            style={{
              height: "100%",
              width: `${(shieldRatio * 100).toFixed(1)}%`,
              background: shieldRatio > 0.35 ? "#7cc7ff" : "#f5b94d",
            }}
          />
        </div>
      </div>
      {lockedByTarget ? (
        <div
          data-testid="drift-target-box-locked"
          style={{
            position: "absolute",
            bottom: -18,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 10,
            letterSpacing: "0.14em",
            color: "#ff6b6b",
            whiteSpace: "nowrap",
          }}
        >
          WEAPON LOCKED
        </div>
      ) : null}
      {/* Hide-range constant re-exported for the tests / HUD docs. */}
      <span style={{ display: "none" }}>{TARGET_BOX_MAX_RANGE_M}</span>
    </div>
  );
}
