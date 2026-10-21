/**
 * `useGuidance` — TASK-56 client-side event detection.
 *
 * The hint line is entirely client-side (see `../guidance.ts` for
 * why). This hook is the bridge between the live `DriftClient` and
 * the pure `GuidanceStore`:
 *
 *   - `docked`       — the own ship transitioned onto a pad *after
 *                      having left one*. The spawn ship is already
 *                      docked (TASK-20), so counting that as a dock
 *                      would skip step 1 on frame one; we therefore
 *                      only report the transition once the ship has
 *                      been seen airborne.
 *   - `disembark`    — the controls flip to on-foot.
 *   - `firstPickup`  — the first `mining_update` award (`unitsSoFar > 0`).
 *   - `firstSale`    — the first `sell_ok`.
 *   - `dismiss`      — the `X` key (or the hint's ✕ button).
 *
 * A `GUIDANCE_WINDOW_MS` ceiling matches the spec's "first 5
 * minutes": after that the store hides the hint for good, so a
 * player who walks away from the keyboard doesn't come back to a
 * stale line.
 *
 * @see ../guidance.ts for the store + step table.
 * @see ./useGuidance.test.ts for the event-detection cases.
 */
import { useEffect, useMemo } from "react";

import { GuidanceStore } from "../guidance.js";
import type { DriftClient } from "../../net/wsClient.js";

/** The hint line is only interesting for the first five minutes. */
export const GUIDANCE_WINDOW_MS = 5 * 60 * 1_000;

/** Poll cadence for the two sampled signals (on-foot + pad state). */
const SAMPLE_MS = 250;

/**
 * Narrow view of the client for the pad bit. The docked HUD
 * (`DockedIndicator`) reads the same seam off `window`; until the
 * predictor is wired onto `DriftClient` (a later prediction task)
 * this is the only place the pad state is visible to the UI, so we
 * mirror the existing cast rather than inventing a second source.
 */
interface PadReadable {
  predictor?: { state(): { onPad?: string | null } };
}

/** Current pad id of the own ship, or `null` when unknown/airborne. */
function readPadId(client: DriftClient): string | null {
  const seam = client as unknown as PadReadable;
  return seam.predictor?.state().onPad ?? null;
}

/**
 * Create the session's `GuidanceStore` and feed it client events.
 * The store lives for the lifetime of the mount; `localStorage`
 * restores the furthest-reached step across refreshes.
 */
export function useGuidance(client: DriftClient): GuidanceStore {
  const store = useMemo(() => new GuidanceStore(), []);

  useEffect(() => {
    let sawAirborne = false;
    let cancelled = false;

    // Sample loop: the pad bit and the on-foot bit are both
    // reflected on client-side state rather than pushed as frames,
    // so they are polled on the same cadence the docked HUD uses.
    const sampler = window.setInterval(() => {
      if (cancelled) return;
      if (client.controlsManager.isOnFoot()) {
        store.recordEvent("disembark");
      }
      const onPad = readPadId(client);
      if (onPad === null) {
        sawAirborne = true;
        return;
      }
      if (sawAirborne) store.recordEvent("docked");
    }, SAMPLE_MS);

    // First mining award = first pickup.
    const offMining = client.onMiningUpdate((payload) => {
      if (payload.unitsSoFar > 0) store.recordEvent("firstPickup");
    });
    // First completed sale.
    const offSell = client.onSellOk(() => {
      store.recordEvent("firstSale");
    });

    // The five-minute ceiling.
    const windowTimer = window.setTimeout(() => {
      store.recordEvent("dismiss");
    }, GUIDANCE_WINDOW_MS);

    // `X` dismisses everything. Guarded so a typing player on a
    // chat prompt doesn't nuke the hints — the prompt swallows the
    // key when it's focused.
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key !== "x" && ev.key !== "X") return;
      const target = ev.target as HTMLElement | null;
      if (
        target !== null &&
        (target.isContentEditable || /input|textarea/iu.test(target.tagName))
      ) {
        return;
      }
      store.recordEvent("dismiss");
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelled = true;
      window.clearInterval(sampler);
      window.clearTimeout(windowTimer);
      window.removeEventListener("keydown", onKeyDown);
      offMining();
      offSell();
    };
  }, [client, store]);

  return store;
}
