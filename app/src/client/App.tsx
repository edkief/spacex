/**
 * Top-level React shell (TASK-15).
 *
 * Mounts the canvas placeholder, the in-system roster HUD
 * (bottom-left), and the join/leave toast stack (top-right). The
 * Drift client (`@client/net/wsClient`) handles the WS handshake
 * once at mount; the HUD widgets subscribe to the same
 * `PresenceStore` instance via `useSyncExternalStore`.
 *
 * Layout choices:
 *   - The roster HUD uses monospace + a small status dot, so the
 *     column reads like a "ship log" rather than a UI panel.
 *   - Toasts are non-interactive (`pointerEvents: none`) so they
 *     never block clicks; they fade after 3 s and auto-collapse.
 *   - The store is created once per mount and reused across the
 *     widgets, so a single WS frame rebuilds both the list and the
 *     toast queue in one React commit.
 */
import { useEffect, useMemo, useState } from "react";
import type * as React from "react";

import { PlayerList } from "./components/PlayerList.js";
import { ToastStack } from "./components/ToastStack.js";
import { ChatLog } from "./components/ChatLog.js";
import { CanvasStage } from "./components/CanvasStage.js";
import { DriftClient } from "./net/wsClient.js";

/**
 * The root shell. One effect drives the Drift client; the HUD
 * widgets consume the store + status directly.
 */
export function App(): React.JSX.Element {
  // The Drift client owns the WS lifecycle. Created once per mount.
  const client = useMemo(() => new DriftClient(), []);
  const [status, setStatus] = useState(client.currentStatus);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Expose the client on `window` so the Playwright smoke test
    // can drive cross-context assertions (e.g. joining a known
    // system). Production builds can ship the same code path —
    // `window.__driftClient` is a debug seam, not a public API.
    (globalThis as { __driftClient?: DriftClient }).__driftClient = client;

    const offStatus = client.onStatusChange((next) => setStatus(next));
    const offError = client.onErrorEvent((err) => setError(err.message));
    client.start().catch(() => {
      // Errors already surface via the onError listener; the
      // start() promise is intentionally fire-and-forget so the
      // HUD stays responsive during the handshake.
    });
    return () => {
      offStatus();
      offError();
      void client.stop();
    };
  }, [client]);

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
      <ToastStack store={store} />
      <ChatLog
        store={client.chatStore}
        canSend={status === "online"}
        onSend={(t) => client.sendChat(t)}
      />
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
    case "disconnected":
      return "disconnected";
    case "error":
      return "error";
    default:
      return "scaffold";
  }
}
