/**
 * useInteractables — derive the per-render interactable list
 * from the DriftClient's remote entity buffers.
 *
 * Lives in its own module so the InteractionPrompt component
 * stays focused on the prompt UI. The hook polls at a fixed
 * cadence (250 ms — same as the docked indicator) and re-runs
 * the snapshot projection only when the underlying buffer set
 * actually changed.
 *
 * The selector walks every `RemoteEntityBuffer` and projects
 * each one through `interactableFromWire(...)`. Buffers with no
 * projection (ships not currently interactable, AI ships,
 * characters, wrecks) are silently dropped — the prompt only
 * surfaces deposit / terminal / ship kinds.
 */
import { useEffect, useState } from "react";
import type { Interactable } from "../input/interaction.js";
import { interactableFromWire } from "../net/prediction.js";
import type { ProtocolEntityState } from "@shared/protocol/index.js";
export function useInteractables(pollMs: number = 250): readonly Interactable[] {
  const [items, setItems] = useState<readonly Interactable[]>([]);
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const w = window as unknown as {
        __driftClient?: {
          remoteEntityBuffers?: Map<
            string,
            { sample(now: number): { state?: ProtocolEntityState | null } }
          >;
        };
      };
      const buffers = w.__driftClient?.remoteEntityBuffers;
      if (!buffers) return;
      const next: Interactable[] = [];
      const now = Date.now();
      for (const buf of buffers.values()) {
        const sample = buf.sample(now);
        const e = sample.state as ProtocolEntityState | null | undefined;
        if (!e) continue;
        const projected = interactableFromWire(e);
        if (projected) next.push(projected);
      }
      // Cheap identity: same length + same ids → no swap.
      setItems((prev) => {
        if (prev.length === next.length) {
          let same = true;
          for (let i = 0; i < prev.length; i++) {
            if (prev[i]!.id !== next[i]!.id || prev[i]!.kind !== next[i]!.kind) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return next;
      });
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);
  return items;
}

/**
 * Hook: produce the local character's `Interactor` (position +
 * facing) by sampling the remote buffer keyed by the player's
 * character id (`char:<playerId>`). Returns `null` when the
 * character isn't in the buffer yet (e.g. mid-disembark).
 *
 * The forward vector defaults to +X (right-handed ship-local) —
 * TASK-32 wires walk/look, at which point the forward will be
 * derived from the character's actual facing quat. For v1 the
 * cone-raycast is independent of facing so a constant +X is
 * sufficient.
 */
export function useLocalInteractor(): {
  pos: { x: number; y: number; z: number };
  forward: { x: number; y: number; z: number };
} | null {
  const [interactor, setInteractor] = useState<{
    pos: { x: number; y: number; z: number };
    forward: { x: number; y: number; z: number };
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      const w = window as unknown as {
        __driftClient?: {
          playerId?: string | null;
          remoteEntityBuffers?: Map<
            string,
            { sample(now: number): { state?: { id: string; pos: number[] } | null } }
          >;
        };
      };
      const ws = w.__driftClient;
      if (!ws) return;
      const playerId = ws.playerId ?? null;
      if (playerId === null) return;
      const charId = `char:${playerId}`;
      const buf = ws.remoteEntityBuffers?.get(charId);
      if (!buf) return;
      const sample = buf.sample(Date.now());
      const st = sample.state;
      if (!st) return;
      const next = {
        pos: { x: st.pos[0], y: st.pos[1], z: st.pos[2] },
        forward: { x: 1, y: 0, z: 0 },
      };
      setInteractor((prev) => {
        if (
          prev &&
          prev.pos.x === next.pos.x &&
          prev.pos.y === next.pos.y &&
          prev.pos.z === next.pos.z
        ) {
          return prev;
        }
        return next;
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return interactor;
}
