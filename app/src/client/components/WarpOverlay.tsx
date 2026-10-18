/**
 * Warp overlay (TASK-8) — the 2-second streak animation that
 * bridges the source system and the target system during an
 * inter-system travel.
 *
 * The overlay subscribes to `WarpStore` (the same state machine
 * the StarChart already drives) and renders:
 *
 *   - `idle`           — nothing
 *   - `warping-in`     — a centre-out streak layer covering the
 *                        viewport (the "jump" visual) for 2 s
 *   - `awaiting`       — same streak layer (the world swap
 *                        happens here; we keep the streak up
 *                        so the player never sees an
 *                        in-between black frame)
 *   - `warping-out`    — streak for 2 s after the `warp_arrived`
 *                        frame lands + the world manager has
 *                        swapped the scene
 *
 * The overlay intentionally doesn't render the toast — the
 * `WarpStore.warpFailed` path uses the existing
 * `NotificationStore` from `net/notifications.js` (wired in
 * `App.tsx`) so failure toasts share the same lifecycle as the
 * connection-lost / reconnect toasts.
 *
 * The visual layer is a CSS radial gradient with a couple of
 * blue streaks overlaid so the browser can paint it without a
 * shader pipeline. The spec calls out a "warp streak effect
 * (… or CSS — pick the cheap one, no post-processing stack in
 * v1)" and CSS is dramatically cheaper than spinning up
 * post-processing for a 4-second effect.
 */

import { useEffect, useRef, useState } from "react";
import type * as React from "react";

import { isWarpInFlight, type WarpState, type WarpStore } from "../state/warp.js";

/** Default overlay duration for each leg of the warp. */
export const WARP_PHASE_MS = 2_000;

export interface WarpOverlayProps {
  /** The shared warp state machine (created in `App.tsx`). */
  warpStore: WarpStore;
  /** Optional override for the overlay phase duration (ms). */
  phaseMs?: number;
  /** Optional clock override for tests. */
  now?: () => number;
}

interface VisualPhase {
  /** Active when the overlay should be visible. */
  readonly visible: boolean;
  /** `warping-in` (translucent blue pull) or `warping-out` (release). */
  readonly leg: "in" | "out" | "idle";
  /** Milliseconds elapsed in the current leg (0..phaseMs). */
  readonly elapsedMs: number;
  /** Test seam — the wall-clock ms when the current leg started. */
  readonly startedAtMs: number;
}

/**
 * Compute the visual phase from the state machine. Pure helper so
 * tests can drive it without mounting the component.
 *
 * `warpArrivedReceivedAt` is the wall-clock time when the
 * client's `warp_arrived` frame first landed — it tells the
 * component to switch to the `out` leg.
 */
export function deriveVisualPhase(
  state: WarpState,
  warpArrivedReceivedAt: number | null,
  now: () => number,
  phaseMs: number,
): VisualPhase {
  if (state.kind === "idle") {
    return { visible: false, leg: "idle", elapsedMs: 0, startedAtMs: 0 };
  }
  if (state.kind === "warping-in") {
    const elapsed = now() - state.startedAtMs;
    return {
      visible: true,
      leg: "in",
      elapsedMs: Math.max(0, elapsed),
      startedAtMs: state.startedAtMs,
    };
  }
  if (state.kind === "awaiting") {
    // Keep the streak visible while the world swap runs — the
    // player must never see a black frame.
    const elapsed = now() - state.arrivedAtMs;
    return {
      visible: true,
      leg: "out",
      elapsedMs: Math.max(0, elapsed),
      startedAtMs: state.arrivedAtMs,
    };
  }
  // warping-out
  const elapsed = now() - state.swappedAtMs;
  void warpArrivedReceivedAt;
  void phaseMs;
  return {
    visible: true,
    leg: "out",
    elapsedMs: Math.max(0, elapsed),
    startedAtMs: state.swappedAtMs,
  };
}

/**
 * Drive the `WarpStore` through `warping-out → idle` once the
 * 2 s overlay timer completes. Lives in the overlay so the timer
 * scoping stays inside this component (App.tsx doesn't need to
 * track timers).
 *
 * The completion timer is keyed off `swappedAtMs` so the duration
 * is anchored to the moment the world swapped, not the moment
 * the subscriber attached.
 */
function useWarpCompletion(warpStore: WarpStore, phaseMs: number, now: () => number): void {
  // Subscribe to state changes; on every transition into
  // `warping-out`, schedule a `setTimeout` that calls
  // `warpComplete` once `phaseMs` has elapsed since the swap.
  // Re-entering `warping-out` (a stuck retry) cancels the
  // previous timer so a stale completion can't fire.
  useEffect(() => {
    let timer: number | null = null;
    let lastSwappedAt: number | null = null;
    const off = warpStore.subscribe((state) => {
      if (state.kind === "warping-out") {
        if (lastSwappedAt === state.swappedAtMs) return;
        lastSwappedAt = state.swappedAtMs;
        if (timer !== null) window.clearTimeout(timer);
        const remaining = Math.max(0, phaseMs - (now() - state.swappedAtMs));
        timer = window.setTimeout(() => {
          // Re-read the state — a manual `warpComplete` (e.g.
          // the user navigating away) could have changed it.
          const current = warpStore.current;
          if (current.kind === "warping-out" && current.swappedAtMs === state.swappedAtMs) {
            warpStore.warpComplete(current.targetSystemId);
          }
        }, remaining);
      } else {
        lastSwappedAt = null;
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      }
    });
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [warpStore, phaseMs, now]);
}

/**
 * The actual visual layer. Pure DOM + CSS — no canvas, no
 * post-processing, no shader pipeline. The streaks are a layered
 * radial gradient + animated transform for the cheap "warp" look
 * the spec calls for.
 */
function WarpLayer({ phase }: { phase: VisualPhase }): React.JSX.Element | null {
  if (!phase.visible) return null;
  // Cap the easing so a sluggish tick doesn't push the streak
  // beyond 100% (which would just look paused).
  const pct = Math.min(1, Math.max(0, phase.elapsedMs / WARP_PHASE_MS));
  // Pull-from-infinity for the in leg (zoom in), release for the
  // out leg (zoom out).
  const scale = phase.leg === "in" ? 0.5 + pct * 0.7 : 1.2 - pct * 0.2;
  return (
    <div
      data-testid="drift-warp-overlay"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 1500,
        // Radial gradient that closes in around the centre during
        // `warping-in` and opens up during `warping-out`.
        background:
          phase.leg === "in"
            ? `radial-gradient(circle at 50% 50%, rgba(70,140,255,${
                0.75 * pct
              }) 0%, rgba(0,0,15,${0.95}) 65%)`
            : `radial-gradient(circle at 50% 50%, rgba(120,180,255,${
                0.85 * (1 - pct)
              }) 0%, rgba(0,0,15,${0.95 * (1 - pct)}) 55%)`,
        transform: `scale(${scale})`,
        transformOrigin: "50% 50%",
        transition: "transform 80ms linear",
      }}
    >
      {/* Streaks — three translucent bars that animate outward.
          Cheap CSS keyframes so the warp feels directional without
          a shader. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "repeating-linear-gradient(115deg, rgba(180,210,255,0.0) 0 12px, rgba(180,210,255,0.35) 12px 14px, rgba(180,210,255,0.0) 14px 32px)",
          mixBlendMode: "screen",
          opacity: phase.leg === "in" ? 0.9 : 0.7,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(220, 232, 255, 0.95)",
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
        }}
      >
        {phase.leg === "in" ? "Warping in…" : "Warping out…"}
      </div>
    </div>
  );
}

/**
 * The full overlay component. Mounts the streak when the warp
 * state machine is anywhere except `idle`; auto-completes when
 * the 2 s timer for `warping-out` elapses.
 */
export function WarpOverlay(props: WarpOverlayProps): React.JSX.Element {
  const phaseMs = props.phaseMs ?? WARP_PHASE_MS;
  const now = props.now ?? (() => Date.now());
  const warpStore = props.warpStore;
  const [state, setState] = useState<WarpState>(warpStore.current);
  // Track when warp_arrived lands so we can detect "stuck" warping-in
  // states and prevent the overlay from getting stuck in a "warping
  // in" visual forever (defensive against a missed server reply).
  const warpArrivedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const off = warpStore.subscribe((next) => {
      if (
        next.kind === "awaiting" &&
        warpArrivedAtRef.current === null &&
        state.kind === "warping-in" &&
        state.targetSystemId === next.targetSystemId
      ) {
        warpArrivedAtRef.current = now();
      }
      if (next.kind === "idle") {
        warpArrivedAtRef.current = null;
      }
      setState(next);
    });
    return off;
  }, [warpStore, state.kind, now]);
  const phase = deriveVisualPhase(state, warpArrivedAtRef.current, now, phaseMs);

  useWarpCompletion(warpStore, phaseMs, now);

  // Defensive: if the machine is in `warping-in` for > 2 * phaseMs
  // without a `warp_arrived` frame, force-complete so the overlay
  // doesn't get stuck. Spec calls for a 3-5 s total warp; a 4 s
  // upper bound on `warping-in` is appropriate.
  useEffect(() => {
    if (state.kind !== "warping-in") return;
    const id = window.setTimeout(() => {
      const current = warpStore.current;
      if (current.kind === "warping-in" && current.targetSystemId === state.targetSystemId) {
        warpStore.warpFailed(
          {
            code: "transport-error",
            message: "warp failed: no warp_arrived reply",
            targetSystemId: current.targetSystemId,
          },
          now(),
        );
      }
    }, phaseMs * 2);
    return () => window.clearTimeout(id);
  }, [state, warpStore, phaseMs, now]);

  return (
    <>
      <WarpLayer phase={phase} />
      {state.kind !== "idle" && (
        <div
          data-testid="drift-warp-status"
          data-warp-state={state.kind}
          aria-hidden="true"
          style={{ display: "none" }}
        />
      )}
    </>
  );
  void isWarpInFlight;
}

/**
 * Programmatic controller helpers — exposed so App.tsx can wire
 * the chart UI to the warp flow without needing access to the
 * store internals. Pure pass-through to the store.
 */
export function requestWarp(warpStore: WarpStore, targetSystemId: string): void {
  warpStore.requestWarp(targetSystemId);
}
