/**
 * `useFirstLaunch` unit tests (TASK-56 step 2).
 *
 * The hook is the seam between the pure `BootSession` machine and
 * the live `DriftClient`, so the cases here pin the three decisions
 * it makes that the machine itself doesn't:
 *
 *   1. no stored token            → claims screen, nothing started
 *   2. stored token + 200         → straight into the game, joined
 *      on `lastSystemId` when the session reports one
 *   3. stored token + 401         → claims screen with the expired
 *      banner, token cleared, no WS start
 *   4. `?autoclaim=1`             → claim a `Drift-…` callsign (the
 *      dev / e2e seam) instead of showing the form
 *   5. a successful claim          → `startWithSession` fires once
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useFirstLaunch, type FirstLaunch } from "./useFirstLaunch.js";
import { TOKEN_STORAGE_KEY } from "./bootSession.js";
import type { DriftClient } from "../net/wsClient.js";

declare global {
  // React 19's act() requires this flag when run inside a test runner.

  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface StartCall {
  token: string;
  callsign: string;
  systemId: string;
}

/** Minimal client stub: only `startWithSession` is exercised. */
function stubClient(): { client: DriftClient; calls: StartCall[] } {
  const calls: StartCall[] = [];
  const client = {
    startWithSession: (session: StartCall): Promise<void> => {
      calls.push(session);
      return Promise.resolve();
    },
  } as unknown as DriftClient;
  return { client, calls };
}

/** Mount the hook in a throwaway root and return its latest value. */
function mount(client: DriftClient): { read: () => FirstLaunch; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest: FirstLaunch | null = null;
  function Probe(): null {
    latest = useFirstLaunch(client);
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return {
    read: () => {
      if (latest === null) throw new Error("hook never rendered");
      return latest;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Flush the microtask queue the boot machine awaits on. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Install a fetch stub that answers `/api/session` with `status`. */
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status, ok: status === 200, json: async () => body })),
  );
}

const PROFILE = {
  playerId: "p1",
  callsign: "Restore-Pilot",
  credits: 500,
  homeSystemId: "sys-home",
  shipId: "ship-1",
  tokenExpiresAt: 1_800_000_000_000,
};

let mounted: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("useFirstLaunch", () => {
  it("shows the claims screen when no token is stored", async () => {
    const { client, calls } = stubClient();
    mounted = mount(client);
    await settle();
    expect(mounted.read().showClaims).toBe(true);
    expect(mounted.read().expiredCallsign).toBeNull();
    expect(calls).toEqual([]);
  });

  it("restores a stored token straight into the game (no claims screen)", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok-1");
    stubFetch(200, PROFILE);
    const { client, calls } = stubClient();
    mounted = mount(client);
    await settle(6);
    expect(mounted.read().showClaims).toBe(false);
    expect(calls).toEqual([{ token: "tok-1", callsign: "Restore-Pilot", systemId: "sys-home" }]);
  });

  it("prefers the session's lastSystemId over the home system", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok-1");
    stubFetch(200, { ...PROFILE, lastSystemId: "sys-far" });
    const { client, calls } = stubClient();
    mounted = mount(client);
    await settle(6);
    expect(calls[0]?.systemId).toBe("sys-far");
  });

  it("drops an expired token and falls back to the claims screen", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok-dead");
    stubFetch(401, { code: "unauthenticated", message: "Token invalid or expired" });
    const { client, calls } = stubClient();
    mounted = mount(client);
    await settle(6);
    expect(mounted.read().showClaims).toBe(true);
    expect(calls).toEqual([]);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("claims from the form and hands the fresh session to the client", async () => {
    stubFetch(200, { ...PROFILE, callsign: "Fresh-Pilot", token: "tok-fresh" });
    const { client, calls } = stubClient();
    mounted = mount(client);
    await settle();
    expect(mounted.read().showClaims).toBe(true);
    await act(async () => {
      await mounted!.read().claim("Fresh-Pilot");
      await Promise.resolve();
    });
    await settle();
    expect(mounted.read().showClaims).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      token: "tok-fresh",
      callsign: "Fresh-Pilot",
      systemId: "sys-home",
    });
  });

  it("surfaces a claim failure without starting the client", async () => {
    stubFetch(409, { code: "callsign-taken", message: "Callsign already claimed" });
    const { client, calls } = stubClient();
    mounted = mount(client);
    await settle();
    await act(async () => {
      await mounted!.read().claim("Taken-Pilot");
      await Promise.resolve();
    });
    await settle();
    expect(mounted.read().showClaims).toBe(true);
    expect(mounted.read().claimError).toBe("Callsign already claimed");
    expect(calls).toEqual([]);
  });

  it("auto-claims behind the `?autoclaim=1` seam (dev / e2e)", async () => {
    const original = window.location.search;
    // happy-dom exposes `search` as read-only, so drive the URL
    // through history.replaceState instead.
    window.history.replaceState({}, "", "/?autoclaim=1");
    stubFetch(200, { ...PROFILE, callsign: "Drift-abc", token: "tok-auto" });
    const { client, calls } = stubClient();
    mounted = mount(client);
    await settle(6);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.callsign).toMatch(/^Drift-/);
    expect(mounted.read().showClaims).toBe(false);
    window.history.replaceState({}, "", original === "" ? "/" : original);
  });
});
