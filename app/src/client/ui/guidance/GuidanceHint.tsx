/**
 * GuidanceHint overlay — TASK-56 first-launch UX.
 *
 * A bottom-centred hint line that sits above the chat prompt during
 * the first session. Steps auto-advance as the player progresses
 * through docking, disembarking, mining, and selling; the player can
 * skip the line at any time with the X button or with the `X` key.
 *
 * The store + step table live in `../guidance.ts`; this component
 * is a thin React wrapper that subscribes via `useSyncExternalStore`
 * and renders the matching copy.
 *
 * Lifecycle:
 *   - Mounts when the player has a callsign (the boot session is
 *     `authenticated`/`ready`). The host gates the mount on
 *     `boot.kind === "authenticated" || "ready"`.
 *   - The first frame after auth_ok lands, we read the current
 *     step from the store and render the matching copy. If the
 *     store says `step: null`, nothing is shown.
 *   - The X button calls `recordEvent("dismiss")` on the store.
 *   - The finale (step 3) auto-hides after 5 s.
 *
 * Acceptance covered:
 *   - TASK-56 AC #3: the hint line + the four-step progression.
 *   - TASK-56 AC #3 final clause: the finale auto-hides after 5 s.
 *
 * @see ../guidance.ts for the state machine + persistence.
 * @see ./*.test.tsx for the component tests.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

import {
  FINALE_AUTOHIDE_MS,
  GUIDANCE_STEPS,
  type GuidanceStore,
  STEP_FINALE,
  type GuidanceState,
} from "../guidance.js";

/** Use the store's snapshot via `useSyncExternalStore`. */
function useGuidanceStore(store: GuidanceStore): GuidanceState {
  const [snapshot, setSnapshot] = useState<GuidanceState>(store.getSnapshot());
  useEffect(() => {
    return store.subscribe((next) => {
      setSnapshot(next);
    });
  }, [store]);
  return snapshot;
}

/** Props for `<GuidanceHint>`. */
export interface GuidanceHintProps {
  /** The store wiring the overlay. The host owns the lifecycle. */
  store: GuidanceStore;
}

/**
 * The bottom-centred hint line. Conditionally rendered: returns
 * `null` when the store reports no current step (the player is past
 * the finale or has dismissed the hint).
 */
export function GuidanceHint({ store }: GuidanceHintProps): React.JSX.Element | null {
  const snapshot = useGuidanceStore(store);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Schedule a hide when the finale lands. The store already moved
  // `step = 3`; we just need to clear the visible hint after
  // FINALE_AUTOHIDE_MS.
  useEffect(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (snapshot.step === STEP_FINALE && snapshot.finaleStartedAtMs !== null) {
      hideTimer.current = setTimeout(() => {
        store.hide();
      }, FINALE_AUTOHIDE_MS);
    }
    return () => {
      if (hideTimer.current !== null) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [snapshot.step, snapshot.finaleStartedAtMs, store]);

  const onDismiss = useCallback(() => {
    store.recordEvent("dismiss");
  }, [store]);

  if (snapshot.step === null || snapshot.dismissed) return null;
  const text = GUIDANCE_STEPS[snapshot.step];
  if (text === undefined) return null;

  return (
    <div
      data-testid="drift-guidance-hint"
      data-step={snapshot.step}
      style={{
        position: "fixed",
        bottom: 96,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "8px 14px",
        background: "rgba(20, 24, 32, 0.94)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: 6,
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        letterSpacing: "0.04em",
        display: "flex",
        alignItems: "center",
        gap: 10,
        zIndex: 1000,
        maxWidth: 480,
        boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
      }}
    >
      <span data-testid="drift-guidance-hint-text">{text}</span>
      <button
        type="button"
        aria-label="Dismiss guidance"
        data-testid="drift-guidance-hint-dismiss"
        onClick={onDismiss}
        style={{
          background: "transparent",
          border: "none",
          color: "#9aa3ad",
          fontSize: 12,
          cursor: "pointer",
          padding: 0,
          letterSpacing: "0.04em",
        }}
      >
        ×
      </button>
    </div>
  );
}
