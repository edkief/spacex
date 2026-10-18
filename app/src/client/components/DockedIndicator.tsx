/**
 * Docked indicator — TASK-29 step 3 acceptance.
 *
 * Single DOM node that mounts only when the local ship is docked
 * on a landing pad (the server reports `onPad !== null` in the
 * `entity_update` frame). The full ship HUD (target card,
 * shields, weapons, etc.) is TASK-51; here we only need a single
 * "DOCKED" pill that the e2e can assert.
 *
 * The component is intentionally tiny — a single styled span —
 * so it doesn't burn frames when hidden (`return null`). The
 * `data-testid="drift-docked-indicator"` data attribute is the
 * e2e selector.
 */
import { useEffect, useState } from "react";
import type * as React from "react";

export interface DockedIndicatorProps {
  /**
   * The owning entity's current `onPad` value (from the predictor's
   * server snapshot). `null` / `undefined` → indicator hidden.
   */
  padId: string | null | undefined;
}

export function DockedIndicator(props: DockedIndicatorProps): React.JSX.Element | null {
  // Render directly off props — the parent (App.tsx) holds the
  // authoritative state and re-renders on each `entity_update`.
  if (props.padId == null) return null;
  return (
    <span
      data-testid="drift-docked-indicator"
      style={{
        position: "absolute",
        top: 60,
        left: 16,
        padding: "4px 10px",
        background: "rgba(46, 160, 67, 0.85)",
        color: "#ffffff",
        borderRadius: 4,
        fontSize: 11,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        fontFamily: "system-ui, sans-serif",
        pointerEvents: "none",
      }}
    >
      DOCKED
    </span>
  );
}

/**
 * Subscribe to the DriftClient's entity state and surface the
 * current `onPad` value. Lives in its own hook so the indicator
 * stays a dumb component and the WS store doesn't need a new
 * event type.
 *
 * The store is `useSyncExternalStore`-friendly — the predictor
 * already exposes its `state()` snapshot, so we poll on the
 * 200 ms animation frame (cheap; no per-frame churn unless the
 * state actually changes).
 */
export function useOwnShipOnPad(): string | null | undefined {
  const [padId, setPadId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const w = window as unknown as {
        __driftClient?: { predictor?: { state(): { onPad?: string | null } } };
      };
      const state = w.__driftClient?.predictor?.state();
      const next = state?.onPad ?? null;
      setPadId((prev) => (prev === next ? prev : next));
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return padId;
}
