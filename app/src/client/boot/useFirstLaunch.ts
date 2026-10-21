/**
 * `useFirstLaunch` — TASK-56 boot flow as a React hook.
 *
 * Owns the whole first-launch path so `App.tsx` only has to ask
 * two questions:
 *
 *   1. `showClaims` — should the claims screen render?
 *   2. `claim(callsign)` — run the claim POST.
 *
 * The hook is the only place that talks to `BootSession` (the pure
 * state machine in `./bootSession.ts`) and to `DriftClient`'s
 * `startWithSession()`. Everything else — the panel UI, the
 * availability probe, the WS handshake — lives behind those two
 * seams, which keeps the logic unit-testable without a DOM.
 *
 * Flow:
 *
 *   mount
 *     ├─ `?autoclaim=1` in the URL  → claim a random `Drift-…`
 *     │                                (dev / e2e seam, see below)
 *     ├─ stored token               → `GET /api/session`
 *     │     ├─ 200 → `authenticated` → `startWithSession()`
 *     │     └─ 401 → `session-expired` → claims screen + banner
 *     └─ no token                   → claims screen
 *
 * `?autoclaim=1` exists because the pre-TASK-56 e2e suite boots the
 * shell straight into a connected client. Rather than driving the
 * real form (a 500 ms debounce per test), those specs opt into the
 * old auto-claim behaviour with an explicit query flag. Production
 * traffic never sets it, so the claims screen remains the only
 * first-launch entry point.
 *
 * @see ./bootSession.ts for the state machine + its unit tests.
 * @see ../ui/claims/ClaimsScreen.tsx for the panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BootSession, type BootState, type SessionProfile } from "./bootSession.js";
import type { DriftClient } from "../net/wsClient.js";

/** Public view of the boot flow consumed by `App.tsx`. */
export interface FirstLaunch {
  /** Render `<ClaimsScreen>` instead of the game tree. */
  showClaims: boolean;
  /** A claim POST is in flight (drives the button label). */
  claiming: boolean;
  /** Last claim failure message, or `null`. */
  claimError: string | null;
  /** Old callsign to strike through after an expired session. */
  expiredCallsign: string | null;
  /** Session the client is (or will be) using — `null` pre-auth. */
  session: SessionProfile | null;
  /** Run `POST /api/callsigns`. Resolves once the state settled. */
  claim: (callsign: string) => Promise<void>;
}

/**
 * `?autoclaim=1` — dev + e2e seam that skips the claims screen.
 * Returns `true` when the flag is present with a non-empty value.
 */
function wantsAutoClaim(): boolean {
  if (typeof location === "undefined") return false;
  const flag = new URLSearchParams(location.search).get("autoclaim");
  return flag !== null && flag !== "0";
}

/** Random 4-char suffix for the auto-claim callsign. */
function autoCallsign(): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `Drift-${suffix}`;
}

export function useFirstLaunch(client: DriftClient): FirstLaunch {
  const session = useMemo(() => new BootSession(), []);
  const [state, setState] = useState<BootState>({ kind: "idle" });
  const startedRef = useRef(false);

  // Subscribe once, then either restore the stored session or claim.
  useEffect(() => {
    const off = session.subscribe(setState);
    if (wantsAutoClaim()) {
      void session.claim(autoCallsign());
    } else {
      void session.runValidationFromStorage();
    }
    return off;
  }, [session]);

  // Hand the resolved session to the WS client exactly once. The
  // client owns reconnect after this point (TASK-17 retry loop),
  // so the hook only fires on the first authenticated snapshot.
  useEffect(() => {
    if (state.kind !== "authenticated" && state.kind !== "ready") return;
    if (startedRef.current) return;
    startedRef.current = true;
    const profile = state.profile;
    void client
      .startWithSession({
        token: state.token,
        callsign: profile.callsign,
        systemId: profile.lastSystemId ?? profile.homeSystemId,
      })
      .catch(() => {
        // The client forwards the failure to its own error
        // listeners, which surface in the HUD toast column.
        startedRef.current = false;
      });
  }, [client, state]);

  const claim = useCallback(
    async (callsign: string): Promise<void> => {
      await session.claim(callsign);
    },
    [session],
  );

  const showClaims =
    state.kind === "awaiting-claim" ||
    state.kind === "claiming" ||
    state.kind === "claim-failed" ||
    state.kind === "session-expired";

  return {
    showClaims,
    claiming: state.kind === "claiming",
    claimError: state.kind === "claim-failed" ? state.error : null,
    expiredCallsign: state.kind === "session-expired" ? state.expiredCallsign : null,
    session: state.kind === "authenticated" || state.kind === "ready" ? state.profile : null,
    claim,
  };
}
