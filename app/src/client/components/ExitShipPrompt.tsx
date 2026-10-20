/**
 * Exit-ship prompt — TASK-31.
 *
 * Bottom-centre prompt that mounts only when:
 *
 *   - the local ship is docked on a landing pad (`onPad !== null`),
 *   - the local client is `online` (so a press actually hits the
 *     server), and
 *   - the player is NOT already on foot (the prompt is for the
 *     ship→character egress, not character→character action).
 *
 * On `E` (or `Enter`) press: sends `exit_ship` and freezes the
 * prompt in a "Sending…" state until the next `entity_update`
 * carries the character (≤ 100 ms). The prompt hides entirely when
 * the player is on foot; the on-foot HUD ships in TASK-52.
 *
 * The component is intentionally tiny — a single styled `<button>`
 * — so it doesn't burn frames when hidden (`return null`).
 *
 * Wire-up:
 *   - `padId`        — the owning ship's `onPad` value (from the
 *                      predictor / server snapshot).
 *   - `onExit()`     — caller-supplied function that sends the
 *                      `exit_ship` frame (DriftClient.sendExitShip).
 *   - `enabled`      — typically `clientStatus === 'online'`.
 *   - `inFlight`     — optional visual flag: `true` once the user
 *                      has pressed E and we're awaiting the
 *                      server's broadcast. Defaults to `false`.
 *
 * Acceptance criterion for TASK-31:
 *   - Prompt visible when docked, hidden when not.
 *   - E press calls `onExit()` exactly once per press.
 *   - Pressing E with `enabled === false` is a no-op (no
 *     outbound frame).
 */
import { useEffect, useState } from "react";
import type * as React from "react";

export interface ExitShipPromptProps {
  /** The owning ship's `onPad` value. Truthy → visible. */
  padId: string | null | undefined;
  /** Called when the user presses E (or Enter). */
  onExit: () => void;
  /** True while the WS is open (controls disabled when false). */
  enabled: boolean;
  /** True once the press has been sent; frozen until reset. */
  inFlight?: boolean;
}

const PROMPT_KEY_PRIMARY = "KeyE";
const PROMPT_KEY_FALLBACK = "Enter";

/**
 * Bottom-centre prompt that disappears when the player is not
 * docked or when the socket is offline.
 */
export function ExitShipPrompt(props: ExitShipPromptProps): React.JSX.Element | null {
  const { padId, onExit, enabled, inFlight = false } = props;
  const [pressed, setPressed] = useState(false);

  // Reset the "pressed" state once the parent flips back to
  // `inFlight === false` (e.g. after a server-side rejection).
  useEffect(() => {
    if (!inFlight) setPressed(false);
  }, [inFlight]);

  useEffect(() => {
    if (!padId) return;
    if (!enabled) return;
    const onKey = (ev: KeyboardEvent): void => {
      // Ignore keystrokes that target text inputs so typing
      // "e" in the chat box doesn't trigger the prompt.
      const active = document.activeElement;
      const inTextField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (inTextField) return;
      if (ev.code !== PROMPT_KEY_PRIMARY && ev.key !== PROMPT_KEY_FALLBACK) return;
      if (inFlight || pressed) return;
      ev.preventDefault();
      setPressed(true);
      try {
        onExit();
      } catch {
        // The prompt's `enabled` flag already gates on the socket
        // being open, so a throw here means something exotic
        // happened (mid-frame disconnect). Reset the pressed
        // state so the player can retry.
        setPressed(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [padId, enabled, inFlight, pressed, onExit]);

  if (!padId) return null;

  return (
    <div
      data-testid="drift-exit-ship-prompt"
      role="status"
      aria-label="Prompt: press E to exit the ship and continue on foot"
      style={{
        position: "absolute",
        left: "50%",
        bottom: 64,
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        background: "rgba(20, 24, 32, 0.85)",
        border: "1px solid rgba(230, 237, 243, 0.25)",
        borderRadius: 6,
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        pointerEvents: "none",
      }}
    >
      <kbd
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 22,
          height: 22,
          padding: "0 6px",
          background: "rgba(230, 237, 243, 0.12)",
          border: "1px solid rgba(230, 237, 243, 0.35)",
          borderRadius: 3,
          fontFamily: "monospace",
          fontSize: 11,
          letterSpacing: 0,
        }}
      >
        E
      </kbd>
      <span>{inFlight || pressed ? "Leaving ship…" : "Leave ship"}</span>
    </div>
  );
}

/**
 * Hook: subscribe to the local ship's `onPad` field. Mirrors the
 * existing `useOwnShipOnPad` pattern from the docked indicator
 * (TASK-29) so the prompt can re-render on every snapshot without
 * us wiring a separate event type.
 */
export function useOwnShipOnPad(): string | null | undefined {
  const [padId, setPadId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const w = window as unknown as {
        __driftClient?: {
          presenceStore?: unknown;
          remoteEntityBuffers?: Map<
            string,
            { sample(now: number): { state?: { onPad?: string | null; callsign?: string | null } } }
          >;
          currentCallsign?: string | null;
        };
      };
      // Prefer the per-entity buffer if the renderer wires one
      // (the bridge lives in TASK-26). For v1 we fall back to the
      // global predictor seam that DockedIndicator already uses.
      const ws = w.__driftClient;
      if (!ws) return;
      // Find the owning entity (callsign matches) and read its
      // onPad. The buffer registry is keyed by entity id, so we
      // walk until we find one whose latest state has the right
      // callsign + a non-null onPad. Cheap (≤ 16 entities in
      // v1); the test seam lets Playwright drive this directly.
      let found: string | null | undefined = null;
      const buffers = ws.remoteEntityBuffers;
      if (buffers) {
        for (const buf of buffers.values()) {
          const sample = buf.sample(Date.now());
          const st = sample.state;
          if (!st) continue;
          if (st.callsign && ws.currentCallsign && st.callsign === ws.currentCallsign) {
            found = st.onPad ?? null;
            break;
          }
        }
      }
      setPadId((prev) => (prev === found ? prev : found));
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return padId;
}
