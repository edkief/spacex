/**
 * ThreatPingHud — TASK-50 step 2 (threat ping).
 *
 * A red arc pinned to the **screen edge** pointing at the bearing
 * of the last attacker (TASK-44 `threatPings`), fading over the
 * 3 s `THREAT_PING_TTL_MS` window. It is a DOM element (a
 * `conic-gradient` wedge), not a world-anchored marker — the arc
 * lives on the frame so it stays readable even when the attacker
 * is behind the player.
 *
 * The wedge's rotation + opacity come from `threatWedgeState` so
 * the geometry is unit-testable without a browser.
 */

import { useEffect, useRef } from "react";
import type * as React from "react";

import { selectStrongestPing, type TargetingStore, type ThreatPing } from "../combat/targeting.js";
import {
  THREAT_WEDGE_ARC_DEG,
  threatWedgeGradient,
  threatWedgeState,
} from "../combat/hud/threatPing.js";
import type { FrameMonitor } from "../perf/frameMonitor.js";
import { settingsStore } from "../a11y/settings.js";

/** Props for the `ThreatPingHud`. */
export interface ThreatPingHudProps {
  /** Targeting store (source of the threat pings). */
  store: TargetingStore;
  /** Optional frame monitor for the `hud` budget check. */
  monitor?: FrameMonitor | null;
  /** Edge inset of the wedge in px. */
  insetPx?: number;
  /** Test seam — fixed clock. */
  nowMs?: number;
}

/** Size of the wedge block in px (the visible arc is a slice). */
const WEDGE_SIZE_PX = 120;

/**
 * Screen-edge threat arc. Renders nothing when there is no ping
 * inside the TTL — the store's `strongestRecent` picks the
 * most-recent attacker within `THREAT_PING_RECENT_MS`.
 */
export function ThreatPingHud(props: ThreatPingHudProps): React.JSX.Element | null {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const ping: ThreatPing | null = selectStrongestPing(
    props.store.getThreatPings(),
    props.nowMs ?? Date.now(),
  );

  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || ping === null) return;
    // TASK-54: reduced motion replaces the animated wedge with a
    // static icon (no rAF loop, no rotation, no fade).
    if (settingsStore.getSnapshot().reducedMotion) {
      node.style.opacity = "0.9";
      node.style.transform = `rotate(${ping.bearing.toFixed(2)}deg)`;
      return;
    }
    let raf = 0;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      const wedge = threatWedgeState(ping.bearing, (props.nowMs ?? Date.now()) - ping.ts);
      if (!wedge.live) {
        node.style.opacity = "0";
      } else {
        node.style.opacity = wedge.opacity.toFixed(3);
        node.style.transform = `rotate(${wedge.rotationDeg.toFixed(2)}deg)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [ping, props]);

  if (ping === null) return null;
  const inset = props.insetPx ?? 0;
  const reducedMotion = settingsStore.getSnapshot().reducedMotion;
  const gradient = threatWedgeGradient(THREAT_WEDGE_ARC_DEG);
  return (
    <div
      ref={nodeRef}
      data-testid="drift-threat-ping"
      data-slot="threatPing"
      data-bearing={ping.bearing.toFixed(2)}
      style={{
        position: "fixed",
        left: `calc(50% - ${WEDGE_SIZE_PX / 2}px)`,
        top: inset,
        width: WEDGE_SIZE_PX,
        height: WEDGE_SIZE_PX,
        borderRadius: "50%",
        background: reducedMotion ? "#ff4040" : gradient,
        maskImage: reducedMotion
          ? "none"
          : "radial-gradient(circle at 50% 50%, transparent 42%, black 46%, black 62%, transparent 66%)",
        WebkitMaskImage: reducedMotion
          ? "none"
          : "radial-gradient(circle at 50% 50%, transparent 42%, black 46%, black 62%, transparent 66%)",
        opacity: 0,
        pointerEvents: "none",
        zIndex: 930,
      }}
    />
  );
}
