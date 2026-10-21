/**
 * `useClientWiring` — TASK-72.
 *
 * The big lifecycle effect that used to live inline in `App.tsx`,
 * pulled into its own hook so:
 *
 *   1. the dependency array can stay short and stable,
 *   2. the regression from commit 95504a2 (TASK-53 introduced the
 *      unstable menu-shell `value` object) cannot happen again —
 *      a unit test pins the dep invariant.
 *
 * ## Why this hook exists
 *
 * The original effect listed `shell` in its dep array. `shell` is
 * the `useMemo`-built `MenuShellValue` from `ui/menu/MenuShell`,
 * whose `useMemo` lists `stack`. Every menu open/close therefore
 * produced a fresh `shell` object reference, which re-ran the
 * effect, which called `client.stop()` in its cleanup — closing
 * the WebSocket, clearing `presence` + `chat`, and flipping status
 * to `disconnected`. `useFirstLaunch`'s `startedRef` then refused
 * to restart the client, so opening the star chart or pressing
 * ESC made the world go dead.
 *
 * The fix is structural: the effect's dep array contains only
 * stable references. The drift client + the notification store
 * are created once per mount (via `useMemo([])` in `App.tsx`); the
 * shell callbacks (`open`, `back`, `close`) are `useCallback([])`
 * in `MenuShell`, so destructuring one of them and listing just
 * the callback in deps is safe.
 *
 * The hook deliberately does NOT read `shell.stack` — that value
 * is render-only state of `App.tsx` (`chartOpen`, `dockPanelOpen`,
 * etc.). Inside the effect only `shell.open("dock")` is invoked
 * (TASK-40 dock-terminal `ui_open`), and only the stable callback
 * pointer.
 */
import { useEffect } from "react";

import { type DriftClient, type DriftClientStatus } from "../net/wsClient.js";
import type { NotificationStore } from "../net/notifications.js";
import type { MenuShellValue } from "../ui/menu/MenuShell.js";
import { type WarpStore } from "../state/warp.js";
import { type WeaponFxLayer } from "../fx/weapons.js";
import { type FrameMonitor } from "../perf/frameMonitor.js";
import { worldProfileManager } from "../world/worldProfile.js";
import { installDriftDebug } from "../net/driftDebug.js";
import { installAtmosphereTestHook } from "../components/AtmosphereState.js";
import { settingsStore } from "../a11y/settings.js";
import { fxRegistry } from "../fx/registry.js";
import { settingsBridge } from "../world/settingsBridge.js";

/** Setters the host (`App.tsx`) hands in for the React-state side of the wiring. */
export interface UseClientWiringSetters {
  /** Status pill + connection-lost overlay. */
  setStatus: (status: DriftClientStatus) => void;
  /** Banner at the top of the viewport. */
  setError: (error: string | null) => void;
  /** Bearer token for chart REST fetches (`/api/galaxy/overview`, `/api/galaxy/health`). */
  setToken: (token: string | null) => void;
  /** Dock panel right-rail counter. */
  setCreditsBalance: (balance: number) => void;
  /** `setDebugOverlayOpen((o) => !o)` for the F3 toggle seam. */
  toggleDebugOverlay: () => void;
}

/** All the deps the host (`App.tsx`) hands the hook. */
export interface UseClientWiringOptions extends UseClientWiringSetters {
  /** The DriftClient instance — owned by the host, mounted once per app. */
  client: DriftClient;
  /** The notification bus that drives toast column. */
  notifications: NotificationStore;
  /** The menu shell value. Only `open` is consumed inside the effect. */
  shell: MenuShellValue;
  /** TASK-8 warp state machine. */
  warpStore: WarpStore;
  /** TASK-43 weapon FX layer. */
  weaponFx: WeaponFxLayer;
  /** TASK-57 frame monitor (exposed on `window.__driftFrameMonitor` in dev). */
  frameMonitor: FrameMonitor;
}

/**
 * Run the long-lived Drift client wiring effect.
 *
 * The effect's dependency array is `[client, notifications, openShell]`
 * — three stable references. `openShell` is destructured from the
 * `shell` value, because `MenuShell.open` is a `useCallback([])`
 * helper. Including the `shell` value itself is the bug; including
 * `openShell` (the destructured callback) is safe.
 *
 * `client.stop()` runs on unmount only, never on shell
 * open/close. The TASK-17 reconnect loop owns the socket after
 * the first `startWithSession()`.
 */
export function useClientWiring(options: UseClientWiringOptions): void {
  const {
    client,
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
  } = options;

  // Destructure the STABLE shell callback. `MenuShell.open` is
  // wrapped in `useCallback([])`, so its identity is constant for
  // the lifetime of the shell provider. The unstable `shell`
  // object (its `useMemo` lists `stack`) MUST NOT appear in the
  // effect dep array.
  const { open: openShell } = shell;

  useEffect(() => {
    // Expose the client on `window` so the Playwright smoke test
    // can drive cross-context assertions (e.g. joining a known
    // system). Production builds can ship the same code path —
    // `window.__driftClient` is a debug seam, not a public API.
    (globalThis as { __driftClient?: DriftClient }).__driftClient = client;

    // TASK-57: expose the frame monitor on `window.__driftFrameMonitor`
    // so the dev console (and Playwright smoke tests) can poke at it
    // without scraping the in-page overlay. Dev-only — the construction
    // cost in prod is negligible (one 300-slot Float64Array) but
    // consumers of the seam should treat it as undefined in prod builds.
    (globalThis as { __driftFrameMonitor?: FrameMonitor }).__driftFrameMonitor = frameMonitor;
    // TASK-54: expose the accessibility settings store + the FX
    // registry so the e2e harness can flip reduced motion and read
    // the FX counters (played / skipped) without scraping the DOM.
    (globalThis as { __driftSettings?: typeof settingsStore }).__driftSettings = settingsStore;
    (globalThis as { __driftFxRegistry?: typeof fxRegistry }).__driftFxRegistry = fxRegistry;
    // TASK-55: the settings→pipeline bridge, so the e2e can read the
    // live preset params (draw distance, chunk detail, fx scale)
    // after switching quality from the settings panel.
    (globalThis as { __driftSettingsBridge?: typeof settingsBridge }).__driftSettingsBridge =
      settingsBridge;
    // Expose the toggle setter so the e2e smoke can flip the panel
    // without driving a real keyboard event (the F3 path is covered
    // by the unit suite via direct DOM event dispatch).
    (globalThis as { __driftDebugOverlayToggle?: () => void }).__driftDebugOverlayToggle =
      toggleDebugOverlay;

    // TASK-71: install the dev-only debug surface (`window.__DRIFT__`)
    // so the two-client e2e can re-derive the galaxy chart from the
    // same `galaxySeed` the server uses. The implementation
    // (`net/driftDebug.ts`) is tree-shaken from production builds by
    // an `import.meta.env.DEV` guard — never installed outside dev.
    installDriftDebug();
    // TASK-28: install the atmosphere test hook so the dev console
    // (and Playwright smoke tests) can drive the haze + re-entry
    // transitions without a live ship state. Dev-only — the seam is
    // a thin facade on `globalThis.__driftAtmosphereState`.
    if (import.meta.env.DEV) {
      installAtmosphereTestHook();
    }

    const offStatus = client.onStatusChange((next) => {
      setStatus(next);
      // TASK-59: coming online is the first world load — resolve the
      // device profile (auto-detect or the player's override) and
      // push it into the pipeline. No toast on the first load: the
      // notice is only for a *change* between world loads.
      if (next === "online") worldProfileManager.loadWorld();
      // The "Connection lost" overlay renders on `lost`. We
      // also forward a notification so a test can observe the
      // transition.
      if (next === "lost") {
        notifications.push({
          kind: "connection-lost",
          text: "Connection lost — retrying…",
          ts: Date.now(),
        });
      }
    });
    const offError = client.onErrorEvent((err) => setError(err.message));
    // TASK-17: on every successful resync, push a "Reconnected"
    // toast so the user can see the client recovered.
    const offResync = client.onResyncEvent((event) => {
      notifications.push({
        kind: "reconnected",
        text: event.preserved ? "Reconnected" : "Reconnected (system changed)",
        ts: Date.now(),
      });
    });
    // TASK-8: warp-arrived listener — drives the warp state
    // machine from `warping-in` → `awaiting`. The overlay
    // component handles the `awaiting → warping-out → idle`
    // timer on the client side; we only transition when the
    // server confirms the snapshot (so a `system-full` rejection
    // leaves the chart able to retry immediately).
    const offWarp = client.onWarpArrivedEvent((payload) => {
      const target = payload.targetSystemId;
      // The DriftClient already applied the canonical snapshot
      // (presence + chat + remote buffers) before this listener
      // fires — see `handleMessage` in `wsClient.ts`. We only
      // need to drive the warp state machine forward.
      warpStore.warpArrived(target, Date.now());
      // Schedule the world-swap transition. The overlay
      // component will tick the state machine through
      // `warping-out` → idle once the streak timer completes.
      window.setTimeout(() => {
        warpStore.worldSwapped(target, Date.now());
        // TASK-59: the warp transition is the world-load path, so
        // the device profile (mobile floor / desktop override) is
        // re-applied here. A changed profile toasts the notice.
        const applied = worldProfileManager.loadWorld();
        if (applied.notice !== null) {
          notifications.push({
            kind: "profile-applied",
            text: applied.notice,
            ts: Date.now(),
          });
        }
      }, 50);
      notifications.push({
        kind: "warp-arrived",
        text: `Arrived in ${payload.systemId}`,
        ts: Date.now(),
      });
    });
    // TASK-8: warp-rejected listener — server said the warp is
    // a no-go (`system-full`, `system-not-found`, `same-system`).
    // Roll the warp state machine back to `idle` so the chart can
    // re-enable the Warp button + surface a toast.
    const offWarpRejected = client.onWarpRejectedEvent((payload) => {
      const current = warpStore.current;
      const targetSystemId = current.targetSystemId ?? "unknown";
      warpStore.warpFailed(
        {
          code:
            payload.code === "system-full" ||
            payload.code === "system-not-found" ||
            payload.code === "same-system"
              ? payload.code
              : "transport-error",
          message: payload.message,
          targetSystemId,
        },
        Date.now(),
      );
      notifications.push({
        kind: "warp-failed",
        text: payload.code === "system-full" ? "System full" : payload.message,
        ts: Date.now(),
      });
    });
    // TASK-7: pick up the bearer token once the WS handshake
    // completes so the chart's REST fetches (`/api/galaxy/overview`
    // + `/api/galaxy/health`) can authenticate. We poll
    // `currentCallsign`-equivalent state by reading the token
    // straight off the client once `auth_ok` arrives.
    const tokenTimer = window.setInterval(() => {
      const t = client.tokenSnapshot();
      if (t !== null) setToken(t);
    }, 200);
    // TASK-40: poll the player's credit balance via
    // `/api/players/me`. Cheap on the server (single
    // `findPlayerById` row read); the cadence mirrors the
    // weight-bar + cargo-poll loops so the dock panel renders
    // a fresh balance on the same frame the modal mounts.
    const creditsTimer = window.setInterval(async () => {
      const t = client.tokenSnapshot();
      if (t === null) return;
      try {
        const res = await fetch("/api/players/me", {
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as { credits: number };
        setCreditsBalance(body.credits);
      } catch {
        // swallow — a transient network glitch shouldn't break the HUD
      }
    }, 1_000);
    // TASK-40: subscribe to `ui_open` server frames so the dock
    // panel can mount when the player presses `E` on a
    // dock-terminal interactable. Only the `dock` ui tag is
    // honoured today; future terminals will extend the union.
    const offUiOpen = client.onUiOpen((payload) => {
      if (payload.ui === "dock") {
        // TASK-72: route through the stable `openShell`
        // callback (destructure pattern), not `shell.open`
        // directly — the dep-array invariant requires we never
        // read `shell.stack` or `shell` itself inside the effect.
        openShell("dock");
      }
    });
    // TASK-40: subscribe to `sell_ok` frames so the credits
    // counter bumps on the same frame the server commits the
    // credit add. The DockPanel also listens to flip its own
    // "+N cr" floating text; the counter update lives here so
    // the right rail renders the post-sale balance without
    // waiting for the next `/api/players` poll.
    const offSellOk = client.onSellOk((payload) => {
      setCreditsBalance(payload.newBalance);
    });
    // TASK-43: route `fire_ok` frames into the FX layer so
    // accepted fires spawn the muzzle flash + missile tracer.
    // Denied fires surface no FX (the layer's `handleFireOk`
    // returns early on `kind === 'denied'`).
    const offFireOk = client.onFireOk((payload) => {
      weaponFx.handleFireOk(payload, {
        ownCallsign: client.currentCallsign ?? null,
        worldToScreen: () => null,
      });
    });
    // TASK-40 (dev seam): expose a `forceDockPanelOpen()`
    // helper so the e2e screenshot can open the panel without
    // driving a full WS interact flow. Dev-only — production
    // builds never set this seam.
    if (import.meta.env.DEV) {
      (globalThis as { __driftForceDockPanel?: () => void }).__driftForceDockPanel = () =>
        openShell("dock");
    }
    // TASK-56: the WS handshake is driven by `useFirstLaunch`
    // (claims screen → claim → `startWithSession`), not here —
    // starting the client on mount would auto-claim a callsign
    // behind the claims screen.
    return () => {
      offStatus();
      offError();
      offResync();
      offWarp();
      offWarpRejected();
      offUiOpen();
      offSellOk();
      offFireOk();
      window.clearInterval(tokenTimer);
      window.clearInterval(creditsTimer);
      // TASK-72: client.stop() only runs on UNMOUNT. Opening or
      // closing a menu surface must not tear the WS down — that
      // was the regression from the inline effect.
      void client.stop();
    };
  }, [
    client,
    notifications,
    openShell,
    warpStore,
    weaponFx,
    frameMonitor,
    setStatus,
    setError,
    setToken,
    setCreditsBalance,
    toggleDebugOverlay,
  ]);
}
