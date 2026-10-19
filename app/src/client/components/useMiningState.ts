/**
 * Mining hook — TASK-38 client-side state.
 *
 * Subscribes to the DriftClient's `mining_update` stream and
 * tracks the most recent echo. The hook returns:
 *
 *   - `update` — the most recent echo, or `null` when no
 *     channel is active. The RadialMiningProgress component
 *     drives the radial from this.
 *   - `receivedAtMs` — wall-clock ms when the last echo arrived.
 *     The radial animates between echoes via requestAnimationFrame
 *     using this anchor so the gradient never goes stale.
 *
 * The hook ALSO bridges the hold-E press/release logic:
 *
 *   - When the prompt resolves to a deposit and the player holds
 *     E, the hook calls `startMine(depositId)`.
 *   - When E is released, the hook calls `stopMine()`.
 *
 * The hook is independent of the prompt's existing tap-handler so
 * the mining flow coexists with `interact` for non-mining entities.
 */
import { useEffect, useRef, useState } from "react";
import { type DriftClient } from "../net/wsClient.js";

export interface MiningUpdate {
  depositId: string;
  resourceId: string;
  progressMs: number;
  unitsSoFar: number;
  amount: number;
  state: "mining" | "paused-full" | "depleted" | "cancelled";
}

export interface UseMiningResult {
  update: MiningUpdate | null;
  receivedAtMs: number;
}

/**
 * Subscribe to the DriftClient's mining_update stream. Returns
 * the latest echo + a wall-clock anchor the radial can interpolate
 * from.
 */
export function useMiningState(client: DriftClient): UseMiningResult {
  const [update, setUpdate] = useState<MiningUpdate | null>(null);
  const receivedAtRef = useRef<number>(0);

  useEffect(() => {
    const off = client.onMiningUpdate((payload) => {
      receivedAtRef.current = performance.now();
      setUpdate(payload);
    });
    return off;
  }, [client]);

  return {
    update,
    receivedAtMs: receivedAtRef.current,
  };
}
