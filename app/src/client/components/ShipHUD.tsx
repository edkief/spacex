/**
 * ShipHUD — TASK-51 assembly.
 *
 * The five pilot-facing regions:
 *
 *   | region        | slot            | source                            |
 *   |---------------|-----------------|-----------------------------------|
 *   | speed         | bottom-left     | local predictor `state.vel` m/s   |
 *   | altitude      | bottom-left     | `pos.y − planet.radiusKm*1000`    |
 *   | regime tag    | bottom-left     | predictor `state.regime`          |
 *   | docked tag    | top-left        | predictor `state.onPad`           |
 *   | nav readout   | top-right       | chart selection or nearest dock   |
 *   | vitals bar    | under chat      | predictor `state.{hull,shields}`  |
 *
 * Layout discipline is enforced by `combat/hud/layout.ts`. The HUD
 * state updates at the 10 Hz snapshot cadence; the only per-frame
 * work is the nav-readout chevron (`transform: rotate(...)` on a
 * ref'd node) and the vitals-bar hit flash (CSS class toggle).
 */

import { useEffect, useState } from "react";
import type * as React from "react";

import { HUD_STATE_POLL_MS } from "../combat/hud/layout.js";
import type { HitFlashController } from "../combat/hud/vitals.js";
import type { FrameMonitor } from "../perf/frameMonitor.js";
import { AltitudeReadout, RegimeTag } from "./AltitudeReadout.js";
import { DockedTag } from "./DockedTag.js";
import { NavReadout, type NavReadoutInputs } from "./NavReadout.js";
import { SpeedReadout } from "./SpeedReadout.js";
import { VitalsBar } from "./VitalsBar.js";

/**
 * Drive a 100 ms tick that re-reads the hit-flash controller. We
 * keep this hook local so the ShipHUD doesn't import a hook from
 * the VitalsBar component file (the VitalsBar itself owns the
 * polling utility, but here we need a "every 100 ms tick this
 * getter" type, not a useState-bound one).
 */
function useFlashTick(controller: HitFlashController, onTick: () => void): void {
  useEffect(() => {
    const id = window.setInterval(onTick, HUD_STATE_POLL_MS);
    return () => window.clearInterval(id);
  }, [controller, onTick]);
}

/** The local ship's snapshot — the seed for every ship HUD read. */
export interface ShipHudSnapshot {
  /** Position in world coordinates. */
  pos: { x: number; y: number; z: number };
  /** Velocity (drives the speed readout). */
  vel: { x: number; y: number; z: number };
  /** Orientation quaternion (drives the nav bearing). */
  quat: { x: number; y: number; z: number; w: number };
  /** Wire regime: `space | orbit | atmosphere | surface`. */
  regime: string;
  /** Hull HP. */
  hull: number;
  /** Shield HP. */
  shields: number;
  /** Pad id when landed; `null` otherwise. */
  onPad: string | null;
  /** Ship class id (drives the max HP table). */
  classId: string | null;
  /** Throttle normalised to `[-1, 1]`. */
  throttle: number | null;
}

/** Per-snapshot dock fallback target (system pads). */
export interface ShipHudDockFallback {
  /** Pad id the fallback would represent. */
  padId: string;
  /** World-space position of the pad centre. */
  pos: { x: number; y: number; z: number };
  /** Optional human-readable station name. */
  stationName?: string;
}

/** Props for the assembled ship HUD. */
export interface ShipHUDProps {
  /** Latest server snapshot (null when not yet hydrated). */
  snapshot: ShipHudSnapshot | null;
  /** Optional chart selection — the world position of the star system. */
  chartTargetPos?: { x: number; y: number; z: number } | null;
  /** Nearest-dock fallback when no chart target is selected. */
  dockFallback?: ShipHudDockFallback | null;
  /** Hit-flash controller wired by App.tsx via `combat_event` frames. */
  flashController: HitFlashController;
  /** Optional frame monitor for the HUD per-frame budget. */
  monitor?: FrameMonitor | null;
  /** When `false`, the entire HUD collapses to `null` (for tests). */
  enabled?: boolean;
}

/** Compute the speed magnitude (m/s) from the local-ship velocity. */
export function magnitudeMps(vel: { x: number; y: number; z: number } | null | undefined): number {
  if (vel === null || vel === undefined) return 0;
  const len = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  return Number.isFinite(len) ? len : 0;
}

/**
 * The ship HUD host. Mounted by `App.tsx` next to `<CombatHUD>` —
 * the two HUDs share the layout table (`combat/hud/layout.ts`)
 * so they can't collide with each other.
 */
export function ShipHUD(props: ShipHUDProps): React.JSX.Element | null {
  const enabled = props.enabled ?? true;
  // The flash flag is polled at the 10 Hz HUD cadence (same
  // cadence as the snapshot) so the React layer only ticks when
  // the underlying state actually shifts. We seed the initial
  // flash read from the controller so the very first paint also
  // reflects a flash that landed before the HUD mounted. Hooks
  // before the early-return so the rule of unconditional ordering
  // is preserved.
  const [flash, setFlash] = useState<boolean>(() => props.flashController.isFlashing(Date.now()));
  useFlashTick(props.flashController, () => setFlash(props.flashController.isFlashing(Date.now())));
  if (!enabled) return null;
  const snap = props.snapshot;
  if (snap === null) return null;
  const isSpace = snap.regime === "space" || snap.regime === "orbit";
  const speed = magnitudeMps(snap.vel);
  const throttle = snap.throttle ?? 0;
  const inputs: NavReadoutInputs = {
    shipPos: snap.pos,
    shipQuat: snap.quat,
    chartTargetPos: props.chartTargetPos ?? null,
    dockTargetPos: props.dockFallback?.pos ?? null,
    isSpace,
  };
  const stationName =
    snap.onPad !== null && snap.onPad !== undefined
      ? (props.dockFallback?.stationName ?? snap.onPad)
      : null;
  return (
    <div data-testid="drift-ship-hud" data-poll-ms={HUD_STATE_POLL_MS} data-regime={snap.regime}>
      <SpeedReadout speedMps={speed} throttle={throttle} />
      <AltitudeReadout regime={snap.regime} altitudeM={snap.pos.y} />
      <RegimeTag regime={snap.regime} />
      <DockedTag
        padId={snap.onPad}
        stationName={stationName}
        actions={["exit_ship", "cargo", "dock"]}
      />
      <NavReadout inputs={inputs} monitor={props.monitor ?? null} />
      <VitalsBar hull={snap.hull} shields={snap.shields} classId={snap.classId} flashing={flash} />
    </div>
  );
}
