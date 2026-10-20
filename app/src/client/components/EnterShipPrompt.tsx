/**
 * Enter-ship prompt — TASK-35.
 *
 * Bottom-centre prompt that mounts only when the **player's own**
 * docked/idle ship is within range (server-side `ENTER_SHIP_RANGE_M`,
 * 5 m, no cone — a player can board from any direction around the
 * hull). Mirrors `ExitShipPrompt` (TASK-31) but in reverse — where
 * the exit prompt fires on the dock and produces a `exit_ship`
 * frame, this prompt fires when the character walks up to their
 * parked ship and produces an `enter_ship` frame.
 *
 * ## Range / cone trade-off
 *
 * - **Server validator:** `ENTER_SHIP_RANGE_M = 5` (euclidean), no
 *   cone. The spec calls for "within 5 m of its hull" — a player
 *   standing on the back side of their ship should still be able
 *   to board.
 * - **Client visual range:** `ENTER_SHIP_PROMPT_RANGE_M = 6` — a
 *   hair more permissive than the server so the prompt appears a
 *   few frames before the server would accept the press (smooth
 *   UX). Kept local to the component because the
 *   `InteractableRegistry` (TASK-33) is cone-only; this prompt
 *   is a separate code path on purpose.
 *
 * The prompt widens to 6 m on the client so a player walking
 * toward their ship sees the pill appear before they cross the
 * 5 m server-acceptance threshold — avoids a one-frame "I pressed
 * E and nothing happened" glitch when the server denies `out-of-range`
 * for a sub-threshold press.
 *
 * ## Wire-up
 *
 * - `shipId`        — the entity id of the player's own ship.
 *                      `useOwnShipId()` polls the same per-entity
 *                      buffer the docked indicator reads.
 * - `onEnter()`     — caller-supplied function that sends
 *                      `client.sendEnterShip()`.
 * - `enabled`       — typically `clientStatus === 'online'`.
 * - `inFlight`      — optional visual flag: `true` once the user
 *                      has pressed E and the server hasn't acked
 *                      yet. Defaults to `false`. Resetting the flag
 *                      when the next `entity_update` shows the ship
 *                      swaps the affordance text back.
 */
import { useEffect, useState } from "react";
import type * as React from "react";

import { ENTER_SHIP_RANGE_M } from "@shared/world/enterShip.js";

export interface EnterShipPromptProps {
  /** The owning ship's entity id (server's `EntityState.id`). */
  shipId: string | null | undefined;
  /**
   * Optional character position. The prompt appears when
   * `|character.pos - ship.pos| <= ENTER_SHIP_PROMPT_RANGE_M`.
   * Pass `null` to hide the prompt (no character yet — the player
   * is still in ship mode).
   */
  characterPos: { x: number; y: number; z: number } | null;
  /** Called when the user presses E (or Enter). */
  onEnter: () => void;
  /** True while the WS is open (controls disabled when false). */
  enabled: boolean;
  /** True once the press has been sent; frozen until reset. */
  inFlight?: boolean;
}

/**
 * Client-side prompt radius. Slightly wider than the server's
 * `ENTER_SHIP_RANGE_M` so the pill appears a few metres before
 * the server would accept the press (smooth UX). The server is
 * still authoritative — a press outside `ENTER_SHIP_RANGE_M`
 * surfaces `out-of-range` and the prompt will hide on the next
 * snapshot.
 */
export const ENTER_SHIP_PROMPT_RANGE_M = ENTER_SHIP_RANGE_M + 1;
const ENTER_SHIP_PROMPT_RANGE_SQ_M = ENTER_SHIP_PROMPT_RANGE_M * ENTER_SHIP_PROMPT_RANGE_M;

const PROMPT_KEY_PRIMARY = "KeyE";
const PROMPT_KEY_FALLBACK = "Enter";

/**
 * Bottom-centre prompt that disappears when the player isn't on
 * foot within range of their parked ship, or when the socket is
 * offline.
 */
export function EnterShipPrompt(props: EnterShipPromptProps): React.JSX.Element | null {
  const { shipId, characterPos, onEnter, enabled, inFlight = false } = props;
  const [pressed, setPressed] = useState(false);

  // Reset the "pressed" state once the parent flips back to
  // `inFlight === false` (e.g. after a server-side rejection,
  // or after the next `entity_update` carries the ship back).
  useEffect(() => {
    if (!inFlight) setPressed(false);
  }, [inFlight]);

  useEffect(() => {
    if (!shipId) return;
    if (characterPos === null) return;
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
      // The server will do its own range check; we don't need to
      // re-derive here. The pill is the *signal* that the press
      // is even worth attempting — anything further out gets a
      // server-side `out-of-range` rejection the next tick.
      ev.preventDefault();
      setPressed(true);
      try {
        onEnter();
      } catch {
        // Same swallow rationale as `ExitShipPrompt`: a throw here
        // means the socket dropped between the gate check and the
        // send. Reset so the player can retry once the client
        // reconnects.
        setPressed(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shipId, characterPos, enabled, inFlight, pressed, onEnter]);

  if (!shipId || characterPos === null) return null;

  // Range gate (client-side). The visual prompt mirrors the
  // server's range so the player sees exactly when E will work
  // — the gap of (prompt range - server range) lets the pill
  // appear slightly before the server-acceptance boundary so
  // the press doesn't feel laggy.
  const shipPos = useShipPosForPrompt(shipId);
  if (shipPos === null) return null;
  const dx = characterPos.x - shipPos.x;
  const dy = characterPos.y - shipPos.y;
  const dz = characterPos.z - shipPos.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq > ENTER_SHIP_PROMPT_RANGE_SQ_M) return null;

  return (
    <div
      data-testid="drift-enter-ship-prompt"
      role="status"
      aria-label="Prompt: press E to board your ship"
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
      <span>{inFlight || pressed ? "Boarding…" : "Enter ship"}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook: track the player's own ship's world position so the prompt
// can compute the distance gate. The buffer is keyed by entity id and
// ships use a wire-stable `entity:<shipId>` id (matches the server).
// ---------------------------------------------------------------------------

/**
 * Read the latest world position of the ship identified by
 * `entity:<shipId>` from the DriftClient's per-entity remote buffer.
 *
 * Polls at a fixed 200 ms cadence (same pattern as `useOwnShipOnPad`
 * in `ExitShipPrompt.tsx`) so the prompt stays in sync with the
 * authoritative server state without coupling to the prediction
 * pipeline. Returns `null` when the buffer is missing the entity
 * (the ship isn't in the local snapshot yet — e.g. just after a
 * warp).
 */
export function useShipPosForPrompt(shipId: string): { x: number; y: number; z: number } | null {
  const [pos, setPos] = useState<{ x: number; y: number; z: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const w = window as unknown as {
        __driftClient?: {
          remoteEntityBuffers?: Map<
            string,
            { sample(now: number): { state?: { pos: number[] } | null } }
          >;
        };
      };
      const buf = w.__driftClient?.remoteEntityBuffers?.get(shipId);
      if (!buf) return;
      const sample = buf.sample(Date.now());
      const st = sample.state;
      if (!st) return;
      const next = { x: st.pos[0], y: st.pos[1], z: st.pos[2] };
      setPos((prev) => {
        if (prev && prev.x === next.x && prev.y === next.y && prev.z === next.z) {
          return prev;
        }
        return next;
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [shipId]);
  return pos;
}

// ---------------------------------------------------------------------------
// Hook: derive `{ shipId, characterPos }` for the local EnterShipPrompt
// from the DriftClient's presence + remote buffers.
// ---------------------------------------------------------------------------

export interface EnterShipState {
  shipId: string | null;
  characterPos: { x: number; y: number; z: number } | null;
}

const ENTER_SHIP_POLL_MS = 200;

/**
 * Poll the DriftClient's remote entity buffers to resolve:
 *   1. the player's own ship entity id (matches `currentCallsign`
 *      and `kind` derived from the wire shape via the
 *      `interactableFromWire` view's `callsign === currentCallsign`),
 *   2. the local character's position (matches the character id
 *      `char:<playerId>`).
 *
 * Both must be non-null for the prompt to show. Returns the raw
 * fields so the React component can drive its own visibility rule.
 */
export function useEnterShipState(): EnterShipState {
  const [state, setState] = useState<EnterShipState>({
    shipId: null,
    characterPos: null,
  });
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const w = window as unknown as {
        __driftClient?: {
          playerId?: string | null;
          currentCallsign?: string | null;
          remoteEntityBuffers?: Map<
            string,
            {
              sample(now: number): {
                state?:
                  | {
                      id: string;
                      pos: number[];
                      callsign?: string | null;
                      kind?: string;
                    }
                  | null
                  | undefined;
              };
            }
          >;
        };
      };
      const ws = w.__driftClient;
      if (!ws) return;
      const callsign = ws.currentCallsign ?? null;
      const playerId = ws.playerId ?? null;
      const buffers = ws.remoteEntityBuffers;
      if (!buffers) return;

      let ownShipId: string | null = null;
      let charPos: { x: number; y: number; z: number } | null = null;
      const charId = playerId ? `char:${playerId}` : null;
      const now = Date.now();
      for (const [bufId, buf] of buffers) {
        const sample = buf.sample(now);
        const st = sample.state;
        if (!st) continue;
        // Prefer the per-character buffer for the character's
        // position (cheaper than re-walking callsigns).
        if (charId !== null && bufId === charId && Array.isArray(st.pos)) {
          charPos = { x: st.pos[0], y: st.pos[1], z: st.pos[2] };
          continue;
        }
        // Match the owning ship via the callsign + the wire kind
        // (the server surfaces ships with `kind: 'ship'` or
        // `'ai-ship'`; the player's own is the one whose
        // `callsign === currentCallsign` AND the entity id looks
        // like `entity:<shipId>` rather than a character buffer).
        if (
          callsign !== null &&
          st.callsign === callsign &&
          typeof st.id === "string" &&
          st.id.startsWith("entity:")
        ) {
          ownShipId = st.id;
        }
      }
      setState((prev) => {
        if (prev.shipId === ownShipId && prev.characterPos === charPos) return prev;
        return { shipId: ownShipId, characterPos: charPos };
      });
    }, ENTER_SHIP_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return state;
}
