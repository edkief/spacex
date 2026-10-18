/**
 * ToastStack — TASK-15 transient join/leave toasts + TASK-17
 * reconnect notifications.
 *
 * Subscribes to a `PresenceStore` and a `NotificationStore` and
 * renders transient toasts in a fixed top-right column. Toasts
 * auto-fade after 3 s; the component caps the visible count at 3
 * and queues the rest so a mass-join / mass-leave burst (e.g.
 * 16-player cap being hit at once) doesn't overflow the column.
 *
 * ## Toast kinds
 *
 *   - `join` / `leave` — driven by the presence store (TASK-15).
 *   - `info` — driven by the notification store (TASK-17). The
 *     info channel is intentionally narrow: today it carries the
 *     "Reconnected" toast fired by the DriftClient's resync
 *     listener. Future tasks can add more notification kinds
 *     without changing the toast stack.
 *
 * Implementation notes:
 *   - We use `useSyncExternalStore` against `store.snapshot()` so
 *     the component only re-renders on snapshot events (toasts
 *     themselves don't trigger React renders — they have their own
 *     internal fade timer).
 *   - Per-toast fade is a `setTimeout` scheduled on mount and
 *     cleared on unmount. The store-driven "snapshot" event triggers
 *     a re-render that adds new toasts; existing toasts keep their
 *     timers.
 *   - The queue (overflow) is implemented as a ref (not state)
 *     because the queued toasts never trigger a render — they
 *     only get promoted into the visible array when a visible slot
 *     frees up.
 *
 * @see ../net/presence.ts for the presence store.
 * @see ../net/notifications.ts for the notification stream.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";

import type { PresenceStore } from "../net/presence.js";
import { toastTextFor } from "../net/presence.js";
import type { NotificationStore } from "../net/notifications.js";

/** Module-level monotonic id source — survives React StrictMode's
 *  double-mount so a remount doesn't accidentally reuse a stale id. */
let nextToastId = 0;

/** Maximum number of toasts rendered at any one moment. */
const MAX_VISIBLE_TOASTS = 3;

/** Maximum number of toasts queued when more arrive during a burst. */
const MAX_QUEUED_TOASTS = 8;

/** How long a toast stays on screen before fading out. */
const TOAST_LIFETIME_MS = 3000;

/** Auto-fade duration (CSS animation). */
const FADE_OUT_MS = 400;

/** Internal toast record. */
interface Toast {
  /** Unique id (stable across re-renders so React doesn't reuse the DOM node). */
  id: number;
  /** Headline ("CALLSIGN joined" / "Reconnected"). */
  text: string;
  /** Drives the colour band. */
  kind: "join" | "leave" | "info";
}

/** Props for the toast stack. */
export interface ToastStackProps {
  /** The presence store to subscribe to. Required. */
  store: PresenceStore;
  /** Optional notification stream for TASK-17 reconnect toasts. */
  notificationStore?: NotificationStore;
}

/**
 * Visible top-right toast stack. See file header for design notes.
 */
export function ToastStack({ store, notificationStore }: ToastStackProps): React.JSX.Element {
  // Subscribe to the store. The selector returns the same array
  // reference when no changes happened, so React skips the render —
  // see `PresenceStore.snapshot()` which returns a fresh array only
  // when we explicitly call it during `applyPresenceFrame()` /
  // `leaveAll()`.
  useSyncExternalStore(
    (onStoreChange) => store.subscribe(() => onStoreChange()),
    () => store.snapshot(),
    () => store.snapshot(),
  );

  const [toasts, setToasts] = useState<Toast[]>([]);
  // Queue is a ref because we never need to render it — we only
  // promote entries from the queue into the visible array when a
  // toast timer fires.
  const queueRef = useRef<Toast[]>([]);

  // Listen for join/leave events. We deliberately re-subscribe on
  // every render so the effect's lifecycle is short; the store
  // dedupes listeners so we don't fire twice when React re-mounts
  // the component (StrictMode does this in dev).
  useEffect(() => {
    const off = store.subscribe((event) => {
      if (event.kind === "snapshot") return;
      const text = toastTextFor(event);
      if (text === "") return;
      const next: Toast = {
        id: ++nextToastId,
        text,
        kind: event.kind,
      };
      pushToast(next, setToasts, queueRef);
    });
    return off;
  }, [store]);

  // Subscribe to TASK-17 notification events. Same lifecycle
  // pattern as the presence subscription.
  useEffect(() => {
    if (!notificationStore) return;
    const off = notificationStore.subscribe((n) => {
      const next: Toast = {
        id: ++nextToastId,
        text: n.text,
        kind: "info",
      };
      pushToast(next, setToasts, queueRef);
    });
    return off;
  }, [notificationStore]);

  // Schedule fade-outs. Each toast has its own timer keyed by id so
  // we can clear it if the toast is dismissed early.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((p) => p.id !== t.id));
        // Promote the oldest queued toast into the visible slot, if
        // any. This keeps the column from going idle during a long
        // burst.
        if (queueRef.current.length > 0) {
          const [head, ...rest] = queueRef.current;
          queueRef.current = rest;
          setToasts((tPrev) => [...tPrev, head!]);
        }
      }, TOAST_LIFETIME_MS),
    );
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [toasts]);

  return (
    <div
      data-testid="drift-toast-stack"
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        pointerEvents: "none",
        zIndex: 1000,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="drift-toast"
          data-toast-kind={t.kind}
          style={{
            minWidth: 180,
            maxWidth: 280,
            padding: "8px 12px",
            background:
              t.kind === "join"
                ? "rgba(46, 160, 67, 0.85)"
                : t.kind === "leave"
                  ? "rgba(248, 81, 73, 0.85)"
                  : "rgba(56, 139, 253, 0.9)", // info (reconnect) — blue
            color: "#ffffff",
            borderRadius: 6,
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
            letterSpacing: "0.04em",
            boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
            animation: `drift-toast-fade ${FADE_OUT_MS}ms ease-in ${TOAST_LIFETIME_MS - FADE_OUT_MS}ms forwards`,
          }}
        >
          {t.text}
        </div>
      ))}
      <style>{`@keyframes drift-toast-fade {
        to { opacity: 0; transform: translateY(-4px); }
      }`}</style>
    </div>
  );
}

/**
 * Add a toast to the visible array or the overflow queue.
 * Pulled out so both subscriptions share the same insertion
 * policy (visible cap + queue cap).
 */
function pushToast(
  toast: Toast,
  setToasts: React.Dispatch<React.SetStateAction<Toast[]>>,
  queueRef: React.MutableRefObject<Toast[]>,
): void {
  setToasts((prev) => {
    if (prev.length < MAX_VISIBLE_TOASTS) {
      return [...prev, toast];
    }
    const qNext = [...queueRef.current, toast];
    if (qNext.length > MAX_QUEUED_TOASTS) {
      queueRef.current = qNext.slice(qNext.length - MAX_QUEUED_TOASTS);
    } else {
      queueRef.current = qNext;
    }
    return prev;
  });
}

// ---------------------------------------------------------------------------
// Helper exports — kept here so the player list / smoke tests can
// share the same constants without importing the React module.
// ---------------------------------------------------------------------------

/** Re-export for tests. */
export const TOAST_CONSTANTS = {
  MAX_VISIBLE: MAX_VISIBLE_TOASTS,
  MAX_QUEUED: MAX_QUEUED_TOASTS,
  LIFETIME_MS: TOAST_LIFETIME_MS,
} as const;
