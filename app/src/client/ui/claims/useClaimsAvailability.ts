/**
 * Availability probe hook for the claims screen (TASK-56).
 *
 * The spec asks for two stages of validation: the *format* check
 * first (pure, local, no network) and the *server* check second
 * (one debounced probe while the player types). This module owns
 * that second stage plus the debounce, so `<ClaimsScreen>` stays a
 * thin render shell.
 *
 * The debounce is 500 ms — fast enough to feel live, slow enough
 * that a fast typist produces one request instead of sixteen. The
 * fetcher is injectable so the component tests can drive the probe
 * without mocking timers or the network stack.
 *
 * @see ./ClaimsScreen.tsx for the panel.
 */
import { useEffect, useRef, useState } from "react";

import { CallsignSchema, type AvailabilityResult } from "@shared/claims.js";

/** Debounce window for the availability probe (spec: 500 ms). */
export const AVAILABILITY_DEBOUNCE_MS = 500;

/**
 * The status of the availability probe.
 *
 *   - `idle`     — nothing to probe (empty input, or no probe yet)
 *   - `checking` — a request is in flight
 *   - `done`     — the last server response arrived
 *   - `error`    — the probe failed (network / non-2xx)
 */
export type ClaimsAvailability =
  | { kind: "idle" }
  | { kind: "checking"; callsign: string }
  | { kind: "done"; result: AvailabilityResult }
  | { kind: "error"; message: string };

/**
 * Build the local (no network) verdict for a malformed input so the
 * chip can show `invalid format` before the player stops typing.
 */
function localReject(raw: string): AvailabilityResult {
  return {
    callsign: raw,
    normalized: raw.toLowerCase(),
    available: false,
    reason: "invalid-format",
  };
}

/**
 * Track a callsign's availability with a 500 ms debounce.
 *
 * @param callsign raw input value (debounced internally)
 * @param fetcher  fetch implementation (injectable for tests)
 */
export function useClaimsAvailability(
  callsign: string,
  fetcher: typeof fetch = fetch,
): ClaimsAvailability {
  const [state, setState] = useState<ClaimsAvailability>({ kind: "idle" });
  const [debounced, setDebounced] = useState(callsign);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the callsign value so a typing burst coalesces into a
  // single server probe.
  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(callsign), AVAILABILITY_DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [callsign]);

  useEffect(() => {
    if (debounced.length === 0) {
      setState({ kind: "idle" });
      return;
    }
    // Stage 1: format. A malformed string never reaches the server.
    const trimmed = debounced.trim();
    const parsed = CallsignSchema.safeParse(trimmed);
    if (!parsed.success) {
      setState({ kind: "done", result: localReject(trimmed) });
      return;
    }
    // Stage 2: availability, via an abortable request so a fast
    // typist never lands a stale response.
    const ctrl = new AbortController();
    setState({ kind: "checking", callsign: parsed.data });
    void (async (): Promise<void> => {
      try {
        const res = await fetcher(
          `/api/callsigns/availability?callsign=${encodeURIComponent(parsed.data)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        setState({ kind: "done", result: (await res.json()) as AvailabilityResult });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState({ kind: "error", message: (err as Error).message ?? "probe failed" });
      }
    })();
    return (): void => ctrl.abort();
  }, [debounced, fetcher]);

  return state;
}
