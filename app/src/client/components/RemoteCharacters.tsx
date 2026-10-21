/**
 * RemoteCharacters — TASK-36.
 *
 * Renders every other player who is currently on foot in the
 * local system. The component is a screen-space overlay (DOM
 * labels + a CSS capsule) so it works against the existing
 * WebGL starfield canvas without forking the renderer pipeline
 * that TASK-26+ will eventually own.
 *
 * Why DOM, not sprites?
 *   - The TASK-73 canvas is a real three.js scene that
 *     `GameCanvas` owns. Adding a second WebGL context for
 *     character impostors is heavy (≥ 200 ms of GL setup on
 *     cold start, doubled context cost). DOM labels are cheap
 *     at the spec's "≤ 16 labels" cap and a11y-friendly
 *     (screen readers get the callsign verbatim).
 *   - The capsule is a CSS-styled `<div>` with `border-radius:
 *     50%` so the impostor reads as a small standing figure at
 *     any zoom. The full 3D capsule mesh replaces this when the
 *     TASK-26 streaming renderer lands — the seat is the
 *     `RemoteEntityBuffer` so the swap is `O(1)`.
 *
 * Behaviour:
 *   - Polls `window.__driftClient.remoteEntityBuffers` every
 *     100 ms (same cadence as `useOwnShipOnPad`).
 *   - Walks every buffer whose entity kind is `character` and
 *     whose owner is NOT the local player (the local player
 *     has its own predictor + first-person camera).
 *   - For each remote character: samples the interpolation
 *     buffer (the same `RemoteEntityBuffer.sample(now)` the
 *     renderer uses for ships) and projects the position into
 *     screen space using a stub camera (the v1 canvas has no
 *     3D camera yet, so the projection collapses to "label
 *     appears at a fixed offset from the local entity").
 *
 * Acceptance criterion (TASK-36): "Each with their callsign
 * floating above (small label, 10 m billboard fade)". The label
 * always renders for v1 (no range cull) — the 10 m billboard
 * fade is a v2 polish item once the 3D camera is live.
 */
import { useEffect, useState } from "react";
import type * as React from "react";

import type { ProtocolEntityState } from "@shared/protocol/index.js";

const LABEL_POLL_MS = 100;

/** Max labels rendered at once (TASK-36 spec: ≤ 16). */
const MAX_LABELS = 16;

/**
 * The minimum view shape for the per-remote character overlay.
 * Carries just enough to render the capsule + label; full
 * `SimEntityLite` lives in the remote buffer.
 */
interface RemoteCharacterView {
  readonly id: string;
  readonly callsign: string;
  /** World position sampled from the buffer. */
  readonly pos: { x: number; y: number; z: number };
}

interface RemoteCharactersProps {
  /**
   * The local player's callsign. Used to filter out the local
   * player from the remote-character list so the player doesn't
   * see themselves. `null` until the WS handshake completes.
   */
  ownCallsign: string | null;
}

export function RemoteCharacters(props: RemoteCharactersProps): React.JSX.Element | null {
  const { ownCallsign } = props;
  const [characters, setCharacters] = useState<readonly RemoteCharacterView[]>([]);

  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const w = window as unknown as {
        __driftClient?: {
          remoteEntityBuffers?: Map<
            string,
            {
              sample(now: number): { state?: ProtocolEntityState | null; stale: boolean };
            }
          >;
        };
      };
      const buffers = w.__driftClient?.remoteEntityBuffers;
      if (!buffers) return;
      const now = Date.now();
      const next: RemoteCharacterView[] = [];
      for (const [, buf] of buffers) {
        const sample = buf.sample(now);
        const e = sample.state;
        if (!e) continue;
        if (e.kind !== "character") continue;
        // Skip the local player (their callsign matches the row
        // stamped with `isYou: true` in PresenceStore). The remote
        // buffer for the local player's own character id is also
        // a no-op candidate — the local camera renders the
        // first-person view, not this overlay.
        if (ownCallsign && e.callsign === ownCallsign) continue;
        next.push({
          id: e.id,
          callsign: e.callsign ?? "anon",
          pos: { x: e.pos[0], y: e.pos[1], z: e.pos[2] },
        });
        if (next.length >= MAX_LABELS) break;
      }
      // Identity check: same length + same callsigns + same ids
      // → no swap. The label render is cheap but the React tree
      // short-circuit keeps the polling loop budget neutral.
      setCharacters((prev) => {
        if (prev.length === next.length) {
          let same = true;
          for (let i = 0; i < prev.length; i++) {
            if (prev[i]!.id !== next[i]!.id || prev[i]!.callsign !== next[i]!.callsign) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return next;
      });
    }, LABEL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ownCallsign]);

  if (characters.length === 0) return null;

  return (
    <div
      data-testid="drift-remote-characters"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 600,
      }}
    >
      {characters.map((c) => (
        <RemoteCharacter key={c.id} view={c} />
      ))}
    </div>
  );
}

/**
 * Per-remote-character capsule + label. Renders at a fixed screen
 * offset for v1 (no 3D camera); when the streaming renderer lands
 * this is the seam where the screen-space projection lands.
 */
function RemoteCharacter({ view }: { view: RemoteCharacterView }): React.JSX.Element {
  return (
    <div
      data-testid="drift-remote-character"
      data-callsign={view.callsign}
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        // Margin so each label renders with breathing room —
        // future 3D projection replaces this with world→screen.
        marginTop: -40 + (hashId(view.id) % 30),
        marginLeft: hashId(view.id) % 30,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 14,
          height: 22,
          borderRadius: "50% 50% 45% 45%",
          background: "rgba(240, 183, 107, 0.6)",
          border: "1px solid rgba(240, 183, 107, 0.95)",
          boxShadow: "0 0 8px rgba(240, 183, 107, 0.4)",
        }}
      />
      <div
        data-testid="drift-remote-character-label"
        style={{
          padding: "2px 6px",
          background: "rgba(0, 0, 0, 0.6)",
          color: "#f0b76b",
          fontFamily:
            "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
          fontSize: 10,
          letterSpacing: "0.06em",
          borderRadius: 3,
          whiteSpace: "nowrap",
        }}
      >
        {view.callsign}
      </div>
    </div>
  );
}

/**
 * Deterministic per-id small offset so a cluster of remote
 * characters doesn't pile their labels on top of each other.
 * Cheap FNV-1a-ish hash; collisions don't matter (a 4 px
 * overlap is well within the breathing room).
 */
function hashId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
