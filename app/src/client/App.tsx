/**
 * Top-level React shell (TASK-15 + TASK-16 + TASK-17).
 *
 * Mounts the canvas placeholder, the in-system roster HUD
 * (bottom-left), the join/leave toast stack (top-right), the
 * chat panel (top-left), and the "Connection lost" overlay
 * (TASK-17). The Drift client (`@client/net/wsClient`) handles
 * the WS handshake once at mount; the HUD widgets subscribe to
 * the same `PresenceStore` instance via `useSyncExternalStore`.
 *
 * Layout choices:
 *   - The roster HUD uses monospace + a small status dot, so the
 *     column reads like a "ship log" rather than a UI panel.
 *   - Toasts are non-interactive (`pointerEvents: none`) so they
 *     never block clicks; they fade after 3 s and auto-collapse.
 *   - The notification stream drives the "Reconnected" toast on
 *     every successful resync (TASK-17).
 *   - When the DriftClient transitions to `lost` (retry budget
 *     exhausted) the App shows a full-screen overlay with a
 *     Retry button. The overlay is the only full-screen UI in
 *     v1; the spec calls out that it must NOT block the ESC menu
 *     (a future TASK-58 wires the menu).
 */
import { useEffect, useMemo, useState } from "react";
import type * as React from "react";

import { PlayerList } from "./components/PlayerList.js";
import { ToastStack } from "./components/ToastStack.js";
import { ChatLog } from "./components/ChatLog.js";
import { CanvasStage } from "./components/CanvasStage.js";
import { DriftClient } from "./net/wsClient.js";
import { NotificationStore } from "./net/notifications.js";

/**
 * The root shell. One effect drives the Drift client; the HUD
 * widgets consume the store + status directly.
 */
export function App(): React.JSX.Element {
  // The Drift client owns the WS lifecycle. Created once per mount.
  const client = useMemo(() => new DriftClient(), []);
  // The notification store feeds the toast column. Created once
  // per mount; we wire it into the client via `onResync` and the
  // DriftClient's lifecycle.
  const notifications = useMemo(() => new NotificationStore(), []);
  const [status, setStatus] = useState(client.currentStatus);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Expose the client on `window` so the Playwright smoke test
    // can drive cross-context assertions (e.g. joining a known
    // system). Production builds can ship the same code path —
    // `window.__driftClient` is a debug seam, not a public API.
    (globalThis as { __driftClient?: DriftClient }).__driftClient = client;

    const offStatus = client.onStatusChange((next) => {
      setStatus(next);
      // The "Connection lost" overlay renders on `lost`. We
      // also forward a notification so a test can observe the
      // transition.
      if (next === "lost") {
        notifications.push({
          kind: "connection-lost",
          text: "Connection lost — retrying…",
          ts: Date.now(),
        });
      }
    });
    const offError = client.onErrorEvent((err) => setError(err.message));
    // TASK-17: on every successful resync, push a "Reconnected"
    // toast so the user can see the client recovered.
    const offResync = client.onResyncEvent((event) => {
      notifications.push({
        kind: "reconnected",
        text: event.preserved ? "Reconnected" : "Reconnected (system changed)",
        ts: Date.now(),
      });
    });
    client.start().catch(() => {
      // Errors already surface via the onError listener; the
      // start() promise is intentionally fire-and-forget so the
      // HUD stays responsive during the handshake.
    });
    return () => {
      offStatus();
      offError();
      offResync();
      void client.stop();
    };
  }, [client, notifications]);

  const store = client.presenceStore;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#05060a",
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <CanvasStage />
      <header
        data-testid="drift-header"
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          padding: "8px 12px",
          background: "rgba(0, 0, 0, 0.4)",
          borderRadius: 6,
          letterSpacing: "0.18em",
          fontSize: 12,
          textTransform: "uppercase",
        }}
      >
        Drift — {statusLabel(status, client.currentCallsign)}
      </header>
      {error && (
        <div
          data-testid="drift-error-banner"
          style={{
            position: "absolute",
            top: 56,
            left: 16,
            padding: "6px 10px",
            background: "rgba(248, 81, 73, 0.85)",
            color: "#ffffff",
            borderRadius: 6,
            fontSize: 11,
            letterSpacing: "0.04em",
            maxWidth: 480,
          }}
        >
          {error}
        </div>
      )}
      <PlayerList store={store} />
      <ToastStack store={store} notificationStore={notifications} />
      <ChatLog
        store={client.chatStore}
        canSend={status === "online"}
        onSend={(t) => client.sendChat(t)}
      />
      {/* TASK-17: "Connection lost" overlay. Renders when the
          DriftClient's retry budget is exhausted. The Retry button
          re-runs `start()` which re-claims a fresh token (the
          saved token may have expired in long absences). The
          overlay is the only full-screen UI in v1; it must NOT
          block the ESC menu (a future TASK-58 wires the menu). */}
      {status === "lost" && (
        <div
          data-testid="drift-connection-lost"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0, 0, 0, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
          }}
        >
          <div
            style={{
              padding: "20px 24px",
              background: "rgba(20, 24, 32, 0.95)",
              border: "1px solid rgba(248, 81, 73, 0.6)",
              borderRadius: 8,
              color: "#ffffff",
              fontFamily: "system-ui, sans-serif",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              minWidth: 280,
            }}
          >
            <div
              style={{
                fontSize: 14,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "rgba(248, 81, 73, 1)",
              }}
            >
              Connection lost
            </div>
            <div style={{ fontSize: 12, color: "#9aa3ad" }}>
              We could not reach the server for 30 s. Click Retry to reconnect.
            </div>
            <button
              data-testid="drift-retry-button"
              type="button"
              onClick={() => {
                void client.start();
              }}
              style={{
                alignSelf: "flex-end",
                padding: "6px 14px",
                background: "rgba(46, 160, 67, 0.9)",
                color: "#ffffff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Pretty-print the lifecycle status for the header pill. */
function statusLabel(status: string, callsign: string | null): string {
  switch (status) {
    case "online":
      return callsign ?? "online";
    case "claiming":
      return "claiming";
    case "connecting":
      return "connecting";
    case "handshaking":
      return "handshake";
    case "joining":
      return "joining system";
    case "reconnecting":
      return "reconnecting";
    case "disconnected":
      return "disconnected";
    case "lost":
      return "connection lost";
    case "error":
      return "error";
    default:
      return "scaffold";
  }
}
