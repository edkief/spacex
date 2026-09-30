import React from 'react';
import type { PresenceStore, PresenceToast } from '@client/net/presence';

interface ToastItem extends PresenceToast {
  id: number;
}

function toastText(item: ToastItem): string {
  // TASK-17: local connection event (not a player presence change).
  if (item.kind === 'reconnected') return 'reconnected';
  return `${item.callsign} ${item.kind === 'join' ? 'joined' : 'left'}`;
}

/** Non-intrusive limit: at most 3 visible toasts, the rest queue (TASK-15). */
export const MAX_VISIBLE_TOASTS = 3;
/** Each toast lives 3 s (fade in → hold → fade out), then the queue promotes. */
export const TOAST_LIFE_MS = 3000;

/**
 * TASK-15: join/leave toasts (top-right, "CALLSIGN joined" / "CALLSIGN
 * left"); TASK-17 adds the one-shot "reconnected" toast. Feeds off
 * PresenceStore.onToast — never on the snapshot cadence.
 * A toast animates in and fades out over TOAST_LIFE_MS; once it is
 * removed, the next queued toast (if any) is promoted to a visible slot.
 */
export function ToastStack({ store }: { store: PresenceStore }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const itemsRef = React.useRef<ToastItem[]>([]);
  const pending = React.useRef<ToastItem[]>([]);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    itemsRef.current = itemsRef.current.filter((t) => t.id !== id);
    // Promote the next queued toast into the freed visible slot.
    const queued = pending.current.shift();
    if (queued) {
      itemsRef.current = [...itemsRef.current, queued];
      timers.current.set(
        queued.id,
        setTimeout(() => dismiss(queued.id), TOAST_LIFE_MS),
      );
    }
    setItems(itemsRef.current);
  }, []);

  const schedule = React.useCallback(
    (item: ToastItem) => {
      const timer = setTimeout(() => dismiss(item.id), TOAST_LIFE_MS);
      timers.current.set(item.id, timer);
    },
    [dismiss],
  );

  React.useEffect(
    () =>
      store.onToast((toast) => {
        const item = { ...toast, id: nextId.current++ };
        if (itemsRef.current.length < MAX_VISIBLE_TOASTS) {
          itemsRef.current = [...itemsRef.current, item];
          setItems(itemsRef.current);
          schedule(item);
        } else {
          pending.current.push(item);
        }
      }),
    [store, schedule],
  );

  React.useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      pending.current = [];
    },
    [],
  );

  return (
    <div id="toast-stack" style={styles.stack} aria-live="polite">
      <style>{keyframes}</style>
      {items.map((item) => (
        <div key={item.id} style={styles.toast}>
          {toastText(item)}
        </div>
      ))}
    </div>
  );
}

const keyframes = `
@keyframes toast-life {
  0%   { opacity: 0; transform: translateX(10px); }
  12%  { opacity: 1; transform: translateX(0); }
  80%  { opacity: 1; }
  100% { opacity: 0; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  stack: {
    position: 'absolute',
    top: '1rem',
    right: '1rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.4rem',
    pointerEvents: 'none',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.8rem',
    userSelect: 'none',
  },
  toast: {
    padding: '0.35rem 0.75rem',
    border: '1px solid #2a3346',
    borderRadius: 8,
    background: 'rgba(17, 21, 31, 0.85)',
    color: '#a8b3c5',
    animation: `toast-life ${TOAST_LIFE_MS}ms ease-in-out forwards`,
  },
};
