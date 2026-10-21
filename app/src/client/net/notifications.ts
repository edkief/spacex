/**
 * Notification store — TASK-17 transient non-presence toasts.
 *
 * The `PresenceStore` only surfaces join/leave events. TASK-17
 * adds one more transient notification — the "Reconnected"
 * toast that fires every time the client successfully resyncs
 * after a disconnect. The store lives in its own module so the
 * `ToastStack` can subscribe to both sources without coupling
 * the presence model to the reconnect lifecycle.
 *
 * The store is intentionally minimal:
 *   - subscribers get every push synchronously,
 *   - `lastValue()` is a convenience for tests + UI code that
 *     wants to peek at the most recent push (e.g. to render a
 *     "Connection lost" overlay when the value is the lost
 *     sentinel).
 *
 * The store does NOT own a toast queue — that's the
 * `ToastStack`'s job. It just hands events downstream.
 *
 * @see ./wsClient.ts for the `DriftClient.onResyncEvent` source.
 * @see ../components/ToastStack.tsx for the consumer.
 */

/**
 * The shape of a transient notification. `kind` is a free-form
 * string so future tasks (TASK-46 AI warnings, TASK-49 wreck
 * proximity alerts, …) can extend without breaking listeners.
 */
export interface Notification {
  kind:
    | "reconnected"
    | "connection-lost"
    | "warp-arrived"
    | "warp-failed"
    | "ai-acquiring"
    /** TASK-59: the device profile changed and was re-applied. */
    | "profile-applied";
  /** Human-readable headline for the toast column. */
  text: string;
  /** Wall-clock ms when the notification was published. */
  ts: number;
}

export type NotificationListener = (n: Notification) => void;
export type Unsubscribe = () => void;

/**
 * Tiny pub/sub for transient UI notifications. One per
 * `DriftClient` instance so the React shell can wire it into
 * the toast column without coupling to the underlying client.
 */
export class NotificationStore {
  private listeners = new Set<NotificationListener>();
  private last: Notification | null = null;

  /** Push a notification. Fires every listener synchronously. */
  push(notification: Notification): void {
    this.last = notification;
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch {
        // swallow — faulty listener must not break the lifecycle
      }
    }
  }

  /** Subscribe to every push. Returns an unsubscribe handle. */
  subscribe(listener: NotificationListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of the most recent notification (null if none). */
  lastValue(): Notification | null {
    return this.last;
  }

  /** Test-only escape hatch. */
  reset(): void {
    this.last = null;
    this.listeners.clear();
  }
}
