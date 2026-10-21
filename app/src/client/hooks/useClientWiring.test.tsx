/**
 * `useClientWiring` — TASK-72 dependency-invariant tests.
 *
 * The bug this hook closes: opening a menu surface (star chart,
 * ESC menu, dock panel, ship panel, settings) re-created the
 * `shell` value object, which was in the inline effect's dep
 * array, which re-ran the effect, which called `client.stop()`
 * in its cleanup — closing the WebSocket and clearing the
 * presence/chat stores. `useFirstLaunch`'s `startedRef` then
 * refused to restart the client.
 *
 * The hook pins the fix:
 *
 *   1. `client.stop()` must NEVER be called mid-mount, no matter
 *      how many times the host re-renders the shell or how often
 *      the `shell` value identity changes.
 *   2. The status-change subscription must stay registered for the
 *      lifetime of the component (one listener, not three — i.e.
 *      re-renders must NOT tear it down + re-register it).
 *   3. Unmounting the hook tears the client down (so the outer
 *      test root's React tear-down calls `client.stop()` exactly
 *      once).
 *   4. The bearer-token snapshot subscriber stays registered
 *      across re-renders.
 *
 * Existing React-hook tests live in `app/src/client/boot/useFirstLaunch.test.tsx`
 * (happy-dom + React Testing Library). This file follows the same
 * pattern: a small host component mounts the hook, then the test
 * forces re-renders with mutated `shell` value identity.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";

import { useClientWiring } from "./useClientWiring.js";
import type { DriftClient } from "../net/wsClient.js";
import type { NotificationStore } from "../net/notifications.js";
import type { MenuShellValue } from "../ui/menu/MenuShell.js";
import { WarpStore } from "../state/warp.js";
import { WeaponFxLayer } from "../fx/weapons.js";
import { FrameMonitor } from "../perf/frameMonitor.js";

declare global {
  // React 19's act() requires this flag when run inside a test runner.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Call counts the test can read directly. */
interface ClientCalls {
  stop: number;
  onStatusChange: number;
  onErrorEvent: number;
  onResyncEvent: number;
  onWarpArrivedEvent: number;
  onWarpRejectedEvent: number;
  onUiOpen: number;
  onSellOk: number;
  onFireOk: number;
  tokenSnapshot: number;
  /** Latest registered status listener (so the test can drive status changes). */
  statusListener: ((s: "online") => void) | null;
  /** Subscription tokens handed to the hook — they stay stable across re-renders. */
  unsubscribers: (() => void)[];
}

interface FakeClient {
  client: DriftClient;
  calls: ClientCalls;
}

/**
 * Build a DriftClient that records every method call. The unsubscribers
 * the hook captures are tracked so the cleanup can call (or not call)
 * them — the test asserts on `calls.stop` rather than on a thrown
 * "never called" sentinel.
 */
function makeFakeClient(): FakeClient {
  const calls: ClientCalls = {
    stop: 0,
    onStatusChange: 0,
    onErrorEvent: 0,
    onResyncEvent: 0,
    onWarpArrivedEvent: 0,
    onWarpRejectedEvent: 0,
    onUiOpen: 0,
    onSellOk: 0,
    onFireOk: 0,
    tokenSnapshot: 0,
    statusListener: null,
    unsubscribers: [],
  };

  const freshUnsub = (): (() => void) => {
    return (): void => undefined;
  };

  const client = {
    stop: () => {
      calls.stop += 1;
      return Promise.resolve();
    },
    onStatusChange: (l: (s: "online") => void) => {
      calls.onStatusChange += 1;
      calls.statusListener = l;
      const unsub = freshUnsub();
      calls.unsubscribers.push(unsub);
      return unsub;
    },
    onErrorEvent: () => {
      calls.onErrorEvent += 1;
      const unsub = freshUnsub();
      calls.unsubscribers.push(unsub);
      return unsub;
    },
    onResyncEvent: () => {
      calls.onResyncEvent += 1;
      const unsub = freshUnsub();
      calls.unsubscribers.push(unsub);
      return unsub;
    },
    onWarpArrivedEvent: () => {
      calls.onWarpArrivedEvent += 1;
      const unsub = freshUnsub();
      calls.unsubscribers.push(unsub);
      return unsub;
    },
    onWarpRejectedEvent: () => {
      calls.onWarpRejectedEvent += 1;
      const unsub = freshUnsub();
      calls.unsubscribers.push(unsub);
      return unsub;
    },
    onUiOpen: () => {
      calls.onUiOpen += 1;
      const unsub = freshUnsub();
      calls.unsubscribers.push(unsub);
      return unsub;
    },
    onSellOk: () => {
      calls.onSellOk += 1;
      const unsub = freshUnsub();
      calls.unsubscribers.push(unsub);
      return unsub;
    },
    onFireOk: () => {
      calls.onFireOk += 1;
      const unsub = freshUnsub();
      calls.unsubscribers.push(unsub);
      return unsub;
    },
    tokenSnapshot: () => {
      calls.tokenSnapshot += 1;
      return null;
    },
    currentCallsign: null,
  } as unknown as DriftClient;
  return { client, calls };
}

/** Empty notification store — the hook only calls `push`. */
function makeFakeNotifications(): NotificationStore {
  return {
    push: () => undefined,
    subscribe: () => () => undefined,
    lastValue: () => null,
    reset: () => undefined,
  } as unknown as NotificationStore;
}

/**
 * Build a `MenuShellValue` with the given `open` callback. The test
 * creates a new value identity on every re-render — which is the bug
 * the hook closes. The `open` callback stays the SAME reference
 * across re-renders (mimicking `useCallback([])` in the real
 * MenuShell), which is what makes `openShell` safe to depend on.
 */
function makeShell(open: (s: string) => void): MenuShellValue {
  return {
    stack: [],
    top: null,
    isOpen: false,
    open: open as MenuShellValue["open"],
    back: () => undefined,
    close: () => undefined,
    registerPanel: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HostHandle {
  /** Bump a counter so the host re-renders with a fresh `shell` value identity. */
  rerender: () => void;
  /** Tear the root down. */
  unmount: () => void;
}

/**
 * Mount the hook inside a tiny host component. The host owns the
 * `shell` state and keeps re-creating its value identity on demand;
 * if the hook's dep array were wrong, every `rerender` would
 * register fresh listeners and (on cleanup) call `client.stop()`.
 */
function mountHost(fake: FakeClient, notifications: NotificationStore): HostHandle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  // Stable lifecycle stores — same instances a host component
  // would produce via `useMemo(() => new X(), [])` at the top of
  // the App. Keeping these constant across re-renders is
  // critical: the hook's dep array contains them, so creating
  // fresh objects every render would defeat the test's purpose
  // (the regression assertion is "a fresh `shell` identity does
  // NOT tear the WS down", and the test would still see re-registrations
  // for the wrong reason).
  const warpStore = new WarpStore();
  const weaponFx = new WeaponFxLayer();
  const frameMonitor = new FrameMonitor();
  const setStatus = (): void => undefined;
  const setError = (): void => undefined;
  const setToken = (): void => undefined;
  const setCreditsBalance = (): void => undefined;
  const toggleDebugOverlay = (): void => undefined;

  // The SAME `open` identity across renders — MenuShell.open is
  // wrapped in useCallback with empty deps, so its identity is
  // constant for the lifetime of the shell provider. The hook
  // depends on `openShell` (destructure), NOT `shell` itself.
  const stableOpen: (s: string) => void = (): void => undefined;

  let rerenderTrigger: () => void = (): void => undefined;

  function Host(): null {
    const [, setVersion] = useState(0);
    rerenderTrigger = (): void => setVersion((v) => v + 1);
    // Fresh `shell` value identity on every render — the
    // production MenuShell's useMemo([stack]) regression would
    // surface here. The `open` callback stays the same reference
    // throughout, mirroring the real `useCallback([])`.
    const shell = makeShell(stableOpen);
    useClientWiring({
      client: fake.client,
      notifications,
      shell,
      warpStore,
      weaponFx,
      frameMonitor,
      setStatus,
      setError,
      setToken,
      setCreditsBalance,
      toggleDebugOverlay,
    });
    return null;
  }

  act(() => {
    root.render(<Host />);
  });

  return {
    rerender: (): void => {
      act(() => {
        rerenderTrigger();
      });
    },
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

let mounted: HostHandle | null = null;
beforeEach(() => {
  // Each test gets a clean global state so dev-seam registrations
  // don't leak across tests.
  delete (globalThis as { __driftClient?: unknown }).__driftClient;
  delete (globalThis as { __driftFrameMonitor?: unknown }).__driftFrameMonitor;
  delete (globalThis as { __driftSettings?: unknown }).__driftSettings;
  delete (globalThis as { __driftFxRegistry?: unknown }).__driftFxRegistry;
  delete (globalThis as { __driftSettingsBridge?: unknown }).__driftSettingsBridge;
  delete (globalThis as { __driftDebugOverlayToggle?: unknown }).__driftDebugOverlayToggle;
  delete (globalThis as { __driftForceDockPanel?: unknown }).__driftForceDockPanel;
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

// ---------------------------------------------------------------------------
// Tests — the dep-invariant the bug broke
// ---------------------------------------------------------------------------

describe("useClientWiring — dependency invariant (TASK-72)", () => {
  it("never tears down the WS on re-renders that change the shell identity", () => {
    const fake = makeFakeClient();
    const notifications = makeFakeNotifications();
    mounted = mountHost(fake, notifications);

    // First render: one subscription per lifecycle event.
    expect(fake.calls.onStatusChange).toBe(1);
    expect(fake.calls.onErrorEvent).toBe(1);
    expect(fake.calls.onResyncEvent).toBe(1);
    expect(fake.calls.onWarpArrivedEvent).toBe(1);
    expect(fake.calls.onWarpRejectedEvent).toBe(1);
    expect(fake.calls.onUiOpen).toBe(1);
    expect(fake.calls.onSellOk).toBe(1);
    expect(fake.calls.onFireOk).toBe(1);
    // `client.stop()` must NOT have been called yet — the WS is
    // still healthy right after mount.
    expect(fake.calls.stop).toBe(0);

    // Three re-renders with a fresh `shell` value identity. The
    // regression used to call `client.stop()` on each one.
    mounted.rerender();
    mounted.rerender();
    mounted.rerender();

    // Still exactly one registration each — the dep array didn't
    // change.
    expect(fake.calls.onStatusChange).toBe(1);
    expect(fake.calls.onErrorEvent).toBe(1);
    expect(fake.calls.onResyncEvent).toBe(1);
    expect(fake.calls.onWarpArrivedEvent).toBe(1);
    expect(fake.calls.onWarpRejectedEvent).toBe(1);
    expect(fake.calls.onUiOpen).toBe(1);
    expect(fake.calls.onSellOk).toBe(1);
    expect(fake.calls.onFireOk).toBe(1);
    // No mid-mount teardown.
    expect(fake.calls.stop).toBe(0);
  });

  it("status listener stays subscribed for the entire lifetime of the component", () => {
    const fake = makeFakeClient();
    const notifications = makeFakeNotifications();
    mounted = mountHost(fake, notifications);

    // The status listener is captured on first mount.
    expect(fake.calls.statusListener).not.toBeNull();

    const firstListener = fake.calls.statusListener;
    mounted.rerender();
    mounted.rerender();
    // Same function instance — no re-registration.
    expect(fake.calls.statusListener).toBe(firstListener);
  });

  it("calls client.stop() exactly once on unmount", () => {
    const fake = makeFakeClient();
    const notifications = makeFakeNotifications();
    mounted = mountHost(fake, notifications);

    // Re-render a few times to be thorough — none of these should
    // call stop().
    mounted.rerender();
    mounted.rerender();
    expect(fake.calls.stop).toBe(0);

    // Unmount — the cleanup teardown runs.
    mounted.unmount();
    mounted = null;
    expect(fake.calls.stop).toBe(1);
  });

  it("exposes __driftClient on `window` on mount (the dev seam)", () => {
    const fake = makeFakeClient();
    const notifications = makeFakeNotifications();
    mounted = mountHost(fake, notifications);

    expect((globalThis as { __driftClient?: unknown }).__driftClient).toBe(fake.client);
  });

  it("uses the destructured `open` callback without re-registering the ui_open listener", () => {
    const fake = makeFakeClient();
    const notifications = makeFakeNotifications();
    mounted = mountHost(fake, notifications);

    // ui_open registered once — opening a surface must NOT
    // re-register the WS event route.
    expect(fake.calls.onUiOpen).toBe(1);

    mounted.rerender();
    mounted.rerender();
    mounted.rerender();
    expect(fake.calls.onUiOpen).toBe(1);
  });
});
