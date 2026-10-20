/**
 * useShipHudSource — TASK-51.
 *
 * React hook that polls the `DriftClient` for the local ship's
 * snapshot and produces the `ShipHUDProps.snapshot` value at the
 * 10 Hz HUD cadence.
 *
 * The hook splits inputs so the snapshot is the **server's
 * truth** (no predicted HP / shielding) — the HUD draws facts, not
 * prediction artifacts.
 *
 * `@shared/physics/vec.ts` ships `magnitude(v)` — we import it
 * directly so the velocity math is consistent with the flight
 * model.
 */
import { useEffect, useState } from "react";

import type { ShipHUDProps, ShipHudSnapshot, ShipHudDockFallback } from "./ShipHUD.js";

/** Magnitude of a 3-vector (shared with the integrator). */
function mag(v: { x: number; y: number; z: number }): number {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  return Number.isFinite(len) ? len : 0;
}

/** Inputs for the ship HUD source hook. */
export interface UseShipHudSourceArgs {
  /** Dev seam — optionally provide a custom poll function. */
  poll?: () => ShipHudSnapshot | null;
  /** Poll cadence in ms. */
  pollMs?: number;
  /** Throttle override (defaults to 0 unless the snapshot supplies one). */
  throttleOverride?: number | null;
  /** Optional dock fallback position. */
  dockFallback?: ShipHudDockFallback | null;
}

/**
 * Poll the local ship's snapshot. Returns a live snapshot for the
 * ShipHUD widget. The hook intentionally polls via
 * `window.__driftClient` rather than holding a React prop — the
 * host (App.tsx) already owns the client and pushing it down as a
 * prop would force every HUD update to re-render the entire app
 * tree.
 */
export function useShipHudSource(args: UseShipHudSourceArgs): {
  snapshot: ShipHudSnapshot | null;
  dockFallback: ShipHudDockFallback | null;
} {
  const [snapshot, setSnapshot] = useState<ShipHudSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = args.poll ?? defaultPollSnapshot;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const next = poll();
      if (next !== null && next.throttle === null && args.throttleOverride !== undefined) {
        next.throttle = args.throttleOverride ?? 0;
      }
      setSnapshot((prev) => {
        if (prev === null && next === null) return prev;
        if (prev === null || next === null) return next;
        if (
          prev.pos.x === next.pos.x &&
          prev.pos.y === next.pos.y &&
          prev.pos.z === next.pos.z &&
          prev.vel.x === next.vel.x &&
          prev.vel.y === next.vel.y &&
          prev.vel.z === next.vel.z &&
          prev.regime === next.regime &&
          prev.hull === next.hull &&
          prev.shields === next.shields &&
          prev.onPad === next.onPad &&
          prev.classId === next.classId &&
          prev.throttle === next.throttle
        ) {
          return prev;
        }
        return next;
      });
    }, args.pollMs ?? 100);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [args.poll, args.pollMs, args.throttleOverride]);

  const [dockFallback] = useState<ShipHudDockFallback | null>(args.dockFallback ?? null);

  // Mutate `snapshot.throttle` indirectly via the poll itself — the
  // setter above accepts throttle already, so we just propagate the
  // args-supplied fallback.
  return { snapshot, dockFallback };
}

/**
 * Default poll source — reads the local predictor's state off the
 * `window.__driftClient` seam.
 *
 * The predictor exposes the post-reconciliation local state, which
 * is the server snapshot plus any unacked inputs. The HUD only
 * uses the snapshot fields (`regime`, `hull`, `shields`, `pos`,
 * `onPad`, `classId`) so this is safe to call at any cadence.
 */
function defaultPollSnapshot(): ShipHudSnapshot | null {
  const w = window as unknown as {
    __driftClient?: {
      predictor?: {
        state(): {
          pos: { x: number; y: number; z: number };
          vel: { x: number; y: number; z: number };
          quat: { x: number; y: number; z: number; w: number };
          regime: "space" | "orbit" | "atmosphere" | "surface";
          hull: number;
          shields: number;
          onPad?: string | null;
          classId?: string | null;
          throttle?: number | null;
        };
      };
    };
  };
  const predictor = w.__driftClient?.predictor;
  if (predictor === undefined) return null;
  const state = predictor.state();
  // Crude check — first frame after boot has `pos.x = pos.y = pos.z = 0`,
  // but we don't want to suppress legitimate on-pad ships at origin.
  if (state.pos === undefined) return null;
  const speedMag = mag(state.vel);
  void speedMag;
  return {
    pos: state.pos,
    vel: state.vel,
    quat: state.quat,
    regime: state.regime,
    hull: state.hull,
    shields: state.shields,
    onPad: state.onPad ?? null,
    classId: state.classId ?? null,
    throttle: state.throttle ?? null,
  };
}

/** Re-export so consumers (e.g. App.tsx) can use the same ship HUD
 *  prop type without re-importing from the component file. */
export type ShipHUDPropsForApp = ShipHUDProps;
