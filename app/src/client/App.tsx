/**
 * Top-level React shell (TASK-15 + TASK-16 + TASK-17 + TASK-7).
 *
 * Mounts the canvas placeholder, the in-system roster HUD
 * (bottom-left), the join/leave toast stack (top-right), the
 * chat panel (top-left), the "Connection lost" overlay
 * (TASK-17), and the star chart overlay (TASK-7). The Drift
 * client (`@client/net/wsClient`) handles the WS handshake once
 * at mount; the HUD widgets subscribe to the same
 * `PresenceStore` instance via `useSyncExternalStore`.
 *
 * Layout choices:
 *   - The roster HUD uses monospace + a small status dot, so the
 *     column reads like a "ship log" rather than a UI panel.
 *   - Toasts are non-interactive (`pointerEvents: none`) so they
 *     never block clicks; they fade after 3 s and auto-collapse.
 *   - The notification stream drives the "Reconnected" toast on
 *     every successful resync (TASK-17).
 *   - The star chart is gated on the `chartOpen` flag — toggled
 *     by the `M` key or the "Systems" header button. While open
 *     the chart polls `/api/galaxy/health` every 5 s for live
 *     occupancy; the polygon layout itself comes from a one-shot
 *     fetch of `/api/galaxy/overview`.
 *   - When the DriftClient transitions to `lost` (retry budget
 *     exhausted) the App shows a full-screen overlay with a
 *     Retry button. The overlay is the only full-screen UI in
 *     v1; the spec calls out that it must NOT block the ESC menu
 *     (a future TASK-58 wires the menu).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";

import { PlayerList } from "./components/PlayerList.js";
import { RemoteCharacters } from "./components/RemoteCharacters.js";
import { ToastStack } from "./components/ToastStack.js";
import { ChatLog } from "./components/ChatLog.js";
import { CanvasStage } from "./components/CanvasStage.js";
import { WarpOverlay } from "./components/WarpOverlay.js";
import { AtmosphereOverlay } from "./components/AtmosphereOverlay.js";
import { ReentryOverlay } from "./components/ReentryOverlay.js";
import { DockedIndicator, useOwnShipOnPad } from "./components/DockedIndicator.js";
import {
  ExitShipPrompt,
  useOwnShipOnPad as useExitPromptShipOnPad,
} from "./components/ExitShipPrompt.js";
import { EnterShipPrompt, useEnterShipState } from "./components/EnterShipPrompt.js";
import { useOwnInventory } from "./components/WeightBar.js";
import { CargoPanel, useOwnCargo } from "./components/CargoPanel.js";
import { DockPanel } from "./components/DockPanel.js";
import { useInteractables, useLocalInteractor } from "./components/useInteractables.js";
import {
  currentAtmosphereStateProvider,
  installAtmosphereTestHook,
} from "./components/AtmosphereState.js";
import { DriftClient } from "./net/wsClient.js";
import { NotificationStore } from "./net/notifications.js";
import { installDriftDebug } from "./net/driftDebug.js";
import { StarChart, type OccupancyBySystem } from "./ui/StarChart.js";
import { WarpStore } from "./state/warp.js";
import { worldProfileManager } from "./world/worldProfile.js";
import { DebugOverlay } from "./perf/DebugOverlay.js";
import { FrameMonitor } from "./perf/frameMonitor.js";
import { CombatHUD } from "./components/CombatHUD.js";
import { useWeaponStatePoll } from "./components/WeaponReadout.js";
import { useHudTargetSource } from "./components/useHudTargetSource.js";
import { ShipHUD, type ShipHudSnapshot } from "./components/ShipHUD.js";
import { useShipHudSource } from "./components/useShipHudSource.js";
import { HitFlashController } from "./combat/hud/vitals.js";
import { installVitalsFlashStyle } from "./components/VitalsBar.js";
import { targetBoxScreenOverride } from "./components/TargetBox.js";
import { WeaponFxHud } from "./components/WeaponFxHud.js";
import { DestructionFx } from "./components/DestructionFx.js";
import { OnFootHUD } from "./components/OnFootHUD.js";
import { useHudMode } from "./components/useHudMode.js";
import { HazardLayer } from "./world/HazardLayer.js";
import { useMenuShell } from "./ui/menu/MenuShell.js";
import { MenuPanel } from "./ui/menu/MenuPanel.js";
import { SettingsPanel } from "./ui/menu/SettingsPanel.js";
import { settingsBridge } from "./world/settingsBridge.js";
import { fetchSettings } from "./settings/api.js";
import { ShipPanel } from "./ui/ship/ShipPanel.js";
import { WeaponFxLayer } from "./fx/weapons.js";
import { LiveRegion } from "./a11y/LiveRegion.js";
import { announcer } from "./a11y/announcer.js";
import { wireAnnouncements } from "./a11y/wireAnnouncements.js";
import { settingsStore } from "./a11y/settings.js";
import { fxRegistry } from "./fx/registry.js";
import { useFirstLaunch } from "./boot/useFirstLaunch.js";
import { ClaimsScreen } from "./ui/claims/ClaimsScreen.js";
import { useGuidance } from "./ui/guidance/useGuidance.js";
import { GuidanceHint } from "./ui/guidance/GuidanceHint.js";
import type { GalaxyOverview } from "@shared/galaxy/overview.js";

/**
 * The root shell. One effect drives the Drift client; the HUD
 * widgets consume the store + status directly.
 */
export function App(): React.JSX.Element {
  // The Drift client owns the WS lifecycle. Created once per mount.
  const client = useMemo(() => new DriftClient(), []);
  // The notification store feeds the toast column. Created once
  // per mount; we wire it into the client via `onResync` and the
  // DriftClient's lifecycle.
  const notifications = useMemo(() => new NotificationStore(), []);
  // TASK-7: warp state machine (shared between the chart and the
  // future TASK-8 warp flow). Created once per mount.
  const warpStore = useMemo(() => new WarpStore(), []);
  // TASK-57: in-game frame monitor. Owned by the top-level shell so
  // the render-loop driver (TASK-26+) and the budget hooks (TASK-30,
  // TASK-58, TASK-59, TASK-61) all reach the same instance via
  // `window.__driftFrameMonitor` in dev. In production the monitor
  // is still constructed (cheap — a 300-slot Float64Array) so future
  // instrumentation work doesn't have to fork the import graph.
  const frameMonitor = useMemo(() => new FrameMonitor(), []);
  // TASK-50: combat-HUD inputs. `hudWeaponState` polls the WS
  // `weapon_state` snapshot at the 10 Hz HUD cadence; the target
  // source samples the live entity buffers (own ship + locked
  // target) so the target box can project world → screen.
  const hudWeaponState = useWeaponStatePoll(useCallback(() => client.getWeaponState(), [client]));
  const hudTargetSource = useHudTargetSource(client);
  // TASK-50: e2e seam — pin the target box to a fixed screen point
  // so the Playwright screenshot is deterministic. `null` in
  // normal play, so the box always uses the live projection.
  const [hudOverrideTick, setHudOverrideTick] = useState(0);
  const hudTargetScreenOverride = useMemo(
    () => (hudOverrideTick > 0 ? targetBoxScreenOverride.current : null),
    [hudOverrideTick],
  );
  useEffect(() => {
    (
      globalThis as {
        __driftCombatHud?: {
          setTargetScreenOverride: (p: { x: number; y: number } | null) => void;
        };
      }
    ).__driftCombatHud = {
      setTargetScreenOverride: (p) => {
        targetBoxScreenOverride.current = p;
        setHudOverrideTick((t) => t + 1);
      },
    };
  }, []);
  // TASK-43: weapon FX layer. Owned by the top-level shell so
  // every component that receives `combat_event` frames can
  // route them into the FX layer without re-creating the
  // active flash / tracer / impact arrays.
  const weaponFx = useMemo(() => new WeaponFxLayer(), []);
  // TASK-51: ship HUD source (10 Hz snapshot of the local ship's
  // position + regime + hull + shields) + the hit-flash controller
  // (fed by `combat_event` and `__fireSelfHitForTest`). Both live
  // for the lifetime of the app — their internal listeners outlive
  // transient HUD mounts.
  const shipHud = useShipHudSource({});
  // TASK-52: HUD mode selector. Reads `__driftClient.controls.isOnFoot()`
  // every 250 ms and on every regime-change event so the ship / on-foot
  // subtree swap is atomic with the camera handoff. The host chooses
  // which subtree to mount in the JSX below.
  const hudMode = useHudMode();
  const hitFlashController = useMemo(() => {
    installVitalsFlashStyle();
    return new HitFlashController();
  }, []);
  // TASK-51: dev seam — e2e tests can inject a synthetic snapshot
  // for the ship HUD via `window.__driftShipHud.setSnapshot(...)`.
  // In production the hook is left alone so the App keeps reading
  // the predictor.
  const [shipHudOverride, setShipHudOverride] = useState<ShipHudSnapshot | null>(null);
  // Self-hit subscriber: matches the wire shape's `entity:<shipId>`
  // against the local player's callsign (the same comparison the
  // server uses to mint `targetedBy` entries).
  useEffect(() => {
    // TASK-51: dev seam — installs `window.__driftShipHud` so the
    // e2e harness can drive a synthetic snapshot without a live
    // predictor (the production-side predictor wiring lands in a
    // later task — for now the ship HUD reads whatever the dev
    // seam provides OR falls back to the polled predictor state).
    (
      globalThis as { __driftShipHud?: { setSnapshot(s: ShipHudSnapshot | null): void } }
    ).__driftShipHud = {
      setSnapshot: (s) => setShipHudOverride(s),
    };
    return () => {
      (globalThis as { __driftShipHud?: unknown }).__driftShipHud = undefined;
    };
  }, []);
  useEffect(() => {
    const offSelfHit = client.onSelfHit((event) => {
      const selfId = client.currentCallsign
        ? `entity:${client.currentCallsign.toLowerCase()}`
        : null;
      if (selfId === null) return;
      if (event.target !== selfId) return;
      hitFlashController.recordSelfHit(Date.now());
    });
    return () => {
      offSelfHit();
    };
  }, [client, hitFlashController]);
  // TASK-46: wire the DriftClient to the notification store so the
  // server's `ai_acquiring` combat events can push an
  // "ACQUIRING" toast into the ToastStack.
  useEffect(() => {
    client.notificationStore = notifications;
    return () => {
      client.notificationStore = undefined;
    };
  }, [client, notifications]);
  const [status, setStatus] = useState(client.currentStatus);
  const [error, setError] = useState<string | null>(null);
  // TASK-7: chart open state — toggled by the `M` key or the
  // "Systems" header button. The chart component owns its own
  // selection / Warp-button state internally.
  // TASK-53: the ESC menu shell owns every transient surface. The
  // star chart is one of them ("systems"), so the chart's open
  // state is derived from the shell stack instead of a local flag.
  const shell = useMenuShell();
  const chartOpen = shell.stack.includes("systems");
  // TASK-7: chart payload + occupancy. The overview is fetched
  // once per chart open; occupancy is polled every 5 s while
  // the chart is open.
  const [overview, setOverview] = useState<GalaxyOverview | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancyBySystem>({});
  // The bearer token used for the chart's GETs. We pull it off
  // the live DriftClient once `auth_ok` lands; `null` until then.
  const [token, setToken] = useState<string | null>(null);
  // TASK-57: dev-only in-game frame monitor panel. Toggled by F3.
  // We keep the state at the host level (not inside the overlay)
  // so the F3 keybind has a single source of truth and the overlay
  // can mount unconditionally without re-subscribing.
  const [debugOverlayOpen, setDebugOverlayOpen] = useState(false);

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
    (globalThis as { __driftDebugOverlayToggle?: () => void }).__driftDebugOverlayToggle = () =>
      setDebugOverlayOpen((o) => !o);

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
        shell.open("dock");
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
        shell.open("dock");
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
      void client.stop();
    };
  }, [client, notifications, shell]);

  // TASK-56: the first-launch flow. The hook owns the boot session
  // (stored token → `GET /api/session`, or the claims screen) and
  // is the ONLY caller of `client.startWithSession()`. The big
  // effect below deliberately does not start the WS client itself —
  // a first launch has to go through the claims screen first.
  const firstLaunch = useFirstLaunch(client);
  // TASK-56: the bottom-centre hint line. Client-side only; the
  // store detects dock / disembark / pickup / sale itself.
  const guidance = useGuidance(client);

  // -----------------------------------------------------------------
  // TASK-55: restore the persisted settings once a session exists.
  // A returning player gets their quality preset / sensitivity
  // before the first frame they steer; a fresh player keeps the
  // defaults (the endpoint returns them).
  // -----------------------------------------------------------------
  const settingsLoadedRef = useRef(false);
  useEffect(() => {
    if (token === null || settingsLoadedRef.current) return;
    settingsLoadedRef.current = true;
    void fetchSettings(token)
      .then((settings) => settingsStore.hydrate(settings))
      .catch(() => {
        // A failed restore is non-fatal: the local snapshot (local
        // Storage) still drives this session.
        settingsLoadedRef.current = false;
      });
  }, [token]);

  // -----------------------------------------------------------------
  // TASK-7: chart data fetch + 5 s occupancy poll while open.
  // -----------------------------------------------------------------

  // One-shot fetch of the full chart payload when the chart
  // opens. Cheap on the server (cached after first hit) and
  // stable across re-opens (server-cached forever).
  useEffect(() => {
    if (!chartOpen) return;
    if (token === null) return;
    const controller = new AbortController();
    fetch("/api/galaxy/overview", {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`overview ${res.status}`);
        const body = (await res.json()) as { overview: GalaxyOverview };
        setOverview(body.overview);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Surface as an error banner so the player sees the
        // failure rather than a blank chart.
        setError(`chart overview fetch failed: ${(err as Error).message}`);
      });
    return () => controller.abort();
  }, [chartOpen, token]);

  // 5 s polling for live occupancy. Re-runs whenever `chartOpen`
  // flips so closing the chart stops the interval immediately.
  useEffect(() => {
    if (!chartOpen) return;
    if (token === null) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch("/api/galaxy/health", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          shards: { systemId: string; players: number }[];
        };
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const s of body.shards) next[s.systemId] = s.players;
        setOccupancy(next);
      } catch {
        // Swallow — next tick will retry. The chart gracefully
        // degrades to zero-player counts if the poll fails.
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [chartOpen, token]);

  // -----------------------------------------------------------------
  // TASK-7 + TASK-57: global keyboard handler — `M` opens the chart,
  // `F3` toggles the dev-only frame monitor, `Escape` closes the
  // chart (handled inside the chart as well, but a top-level
  // fallback so the close fires even if the chart isn't focused).
  // F3 is dev-only and gated on `import.meta.env.DEV` so a prod
  // build literally has no listener for it.
  // -----------------------------------------------------------------

  const toggleChart = useCallback(() => {
    if (shell.stack.includes("systems")) {
      shell.back();
      return;
    }
    shell.open("systems");
  }, [shell]);
  const toggleDebugOverlay = useCallback(() => setDebugOverlayOpen((o) => !o), []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      // Ignore keystrokes that target text inputs so typing
      // "m" in the chat box doesn't open the chart.
      const active = document.activeElement;
      const inTextField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (inTextField) return;
      if (ev.key === "m" || ev.key === "M") {
        ev.preventDefault();
        toggleChart();
      } else if (ev.key === "1") {
        // TASK-43: `1` selects the laser. Bound to the WS layer's
        // sendSelectWeapon so the HUD's active-weapon pill flips
        // on the same frame the player switches.
        ev.preventDefault();
        client.sendSelectWeapon("laser");
      } else if (ev.key === "2") {
        // TASK-43: `2` selects the missile. The server silently
        // accepts the request even when the player's loadout
        // doesn't carry missiles (a scout selecting `missile`
        // just gets a `weapon-not-equipped` toast on the next
        // fire).
        ev.preventDefault();
        client.sendSelectWeapon("missile");
      } else if (ev.key === "t" || ev.key === "T") {
        // TASK-44: `T` is the target-lock / target-release
        // toggle. The server decides which entity to lock based
        // on the player's lock state — a fresh lock request
        // grabs the nearest ship inside the 30° / 500 m nose
        // cone, a duplicate on the already-locked target
        // releases (toggle), `T` with no targetId releases
        // whatever was locked. The HUD reads
        // `client.getTargeting()` and renders the box + the
        // orange "TARGET LOCKED: <callsign>" toast when the
        // server acks.
        //
        // We deliberately send `targetId: null` here so the
        // server picks the nearest candidate via the validator;
        // a future UI surface (the target-reticle ring) will
        // pass an explicit id instead.
        ev.preventDefault();
        client.sendTargetLock(null);
      } else if (import.meta.env.DEV && ev.key === "F3") {
        // F3 toggles the in-game frame monitor. Gated on dev so
        // the production bundle never registers the listener.
        ev.preventDefault();
        toggleDebugOverlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleChart, shell, toggleDebugOverlay]);

  const store = client.presenceStore;

  // TASK-54: wire the transient game events (joins / leaves, kills,
  // target lock) into the screen-reader announcement queue. The
  // queue itself enforces the "max 1 pending + 2 s min interval"
  // rule so a firefight never floods the reader.
  useEffect(() => {
    return wireAnnouncements({
      presence: client.presenceStore,
      killFeed: client.getKillFeed(),
      targeting: client.getTargeting(),
    });
  }, [client]);

  // Indicate whether the dev-only debug overlay is mounted at all.
  // In production builds `import.meta.env.DEV` is `false` and we
  // skip the JSX entirely — Vite's build steps the `import` of the
  // overlay module is still present, but `import.meta.env.DEV` is
  // statically replaced with `false`, so the surrounding component
  // short-circuits without ever rendering.
  const devMode = import.meta.env.DEV;

  // TASK-29: docked indicator. Reads the local ship's `onPad` from
  // the DriftClient's predictor (set by the server's `entity_update`
  // frames) and renders a single DOM node when non-null.
  const ownOnPad = useOwnShipOnPad();
  // TASK-31: same value drives the exit-ship prompt's visibility.
  // Hooks must be called at the top of the component (Rules of
  // Hooks) — we lift the call up here instead of inside the JSX.
  const exitPromptOnPad = useExitPromptShipOnPad();
  // TASK-33: on-foot interact prompt — derived from the latest
  // `entity_update` snapshot. Cheap (single poll) so the Rules of
  // Hooks are fine to call both here.
  const interactables = useInteractables();
  const localInteractor = useLocalInteractor();
  // TASK-35: enter-ship prompt — derives the player's own ship
  // id + character position from the same per-entity remote
  // buffer. The prompt hides when either is missing or when the
  // character is beyond the 6 m visual range (server uses 5 m).
  const enterShipState = useEnterShipState();
  // TASK-34: own inventory (drives the WeightBar HUD).
  const ownInventory = useOwnInventory();
  // TASK-39: own cargo hold (drives the CargoPanel modal).
  const ownCargo = useOwnCargo();
  // TASK-39: open state for the cargo panel. The prompt UI in
  // TASK-33 sets this to `true` when the player presses E on a
  // docked ship with the "Open cargo" prompt; the panel's
  // `Esc` close button resets it.
  const [cargoPanelOpen, setCargoPanelOpen] = useState(false);
  // TASK-40: open state for the dock sell panel. The server
  // emits `ui_open { ui: "dock" }` when the player presses `E`
  // on a dock-terminal interactable (TASK-33 + TASK-40). The
  // client owns rendering; the host shell toggles `open` from a
  // single source (the `ui_open` listener below).
  const dockPanelOpen = shell.stack.includes("dock");
  // TASK-40: live credit balance. Mirrors the value the server
  // reports via `sell_ok` (or `/api/players` for the initial read).
  // The DockPanel renders it in the right rail so the player
  // sees the count tick up on every sell.
  const [creditsBalance, setCreditsBalance] = useState(0);
  // TASK-54: the 1 Hz screen-reader summary. The live region polls
  // this every second (never at the 10 Hz HUD cadence) and speaks a
  // single sentence: "Speed 120 meters per second. Hull 80 percent."
  const summaryRef = useRef({
    speedMps: null as number | null,
    hull: null as number | null,
    hullMax: 100 as number | null,
    credits: 0 as number | null,
    exposure: null as number | null,
    exposureMax: 50 as number | null,
  });
  useEffect(() => {
    const snap = shipHudOverride ?? shipHud.snapshot;
    const hazard = client.getHazardStore().getState();
    summaryRef.current = {
      speedMps:
        snap === null
          ? null
          : Math.sqrt(snap.vel.x * snap.vel.x + snap.vel.y * snap.vel.y + snap.vel.z * snap.vel.z),
      hull: snap?.hull ?? null,
      hullMax: 100,
      credits: creditsBalance,
      exposure: hazard.exposure,
      exposureMax: 50,
    };
  }, [shipHudOverride, shipHud.snapshot, creditsBalance, client]);
  // TASK-54: announce "low energy" when the weapon energy drops
  // below the warning band. The announcer's rate limit keeps it
  // from repeating every tick.
  const lastEnergyBand = useRef<string | null>(null);
  useEffect(() => {
    const energy = hudWeaponState?.energy ?? null;
    if (energy === null) return;
    const band = energy < 10 ? "critical" : energy < 25 ? "low" : "ok";
    if (band === lastEnergyBand.current) return;
    lastEnergyBand.current = band;
    if (band === "critical") announcer.announce("Critical energy.", "combat");
    else if (band === "low") announcer.announce("Low energy.", "combat");
  }, [hudWeaponState?.energy]);
  // TASK-38: mining echoes are now consumed inside `<OnFootHUD>`
  // via its `useMiningFromGlobal()` hook — the radial lives
  // inside `<InteractionLine>` so the affordance + the prompt
  // stay in the same subtree (the ship HUD can't mine).

  // TASK-56: first launch. Until a session exists the claims
  // screen owns the viewport — no game tree behind it, so the
  // renderer never spins up a canvas the player can't use.
  if (firstLaunch.showClaims) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#05060a",
          color: "#e6edf3",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <ClaimsScreen
          expiredCallsign={firstLaunch.expiredCallsign}
          claiming={firstLaunch.claiming}
          claimError={firstLaunch.claimError}
          onClaim={({ callsign }) => firstLaunch.claim(callsign)}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#05060a",
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <CanvasStage label={`3D view: flying in system ${client.currentSystemId ?? "unknown"}`} />
      {/* TASK-56: the first-launch hint line. Sits above the
          interaction prompt and renders nothing once the guidance
          store reports no visible step. */}
      <GuidanceHint store={guidance} />
      {/* TASK-54: the screen-reader channel. The status region is
          refreshed at 1 Hz (never at the 10 Hz HUD cadence) so the
          reader gets one sentence per second instead of a stream of
          partial numbers; the announcement region carries the
          queued transient events (joins, kills, target lock). */}
      <LiveRegion readSummary={() => summaryRef.current} />
      {/* TASK-28: atmosphere haze overlay (skybox → planet transition).
          Reads the same `boundaryFactor` as the physics drag ramp, so
          the visual and physical boundaries cannot desync. The provider
          defaults to `null` (no planet in range) so the overlay is
          invisible until the dev hook or a future ship-state wiring
          pushes a real snapshot. */}
      <AtmosphereOverlay provider={currentAtmosphereStateProvider} />
      {/* TASK-28: orange re-entry rim. Cosmetic only; fires when descent
          > REENTRY_DESCENT_SPEED_U_S (200 u/s) inside the boundary band. */}
      <ReentryOverlay provider={currentAtmosphereStateProvider} />
      {/* TASK-29: docked indicator. Shows a single "DOCKED" pill when the
          local ship is on a landing pad (server reports `onPad`).
          Stub HUD — full ship HUD is TASK-51. */}
      <DockedIndicator padId={ownOnPad} />
      {/* TASK-31: exit-ship prompt. Mounts when the local ship is
          docked + the WS is online. On `E` press the client sends
          `exit_ship` and the server mints a character entity. The
          prompt hides once the player is on foot (the on-foot HUD
          lands in TASK-52). */}
      <ExitShipPrompt
        padId={exitPromptOnPad}
        enabled={status === "online"}
        onExit={() => {
          try {
            client.sendExitShip();
          } catch {
            // The `enabled` prop already gates on `online`; a throw
            // here means the socket dropped between the gate check
            // and the send. Swallow so the UI stays responsive.
          }
        }}
      />
      {/* TASK-35: enter-ship prompt. Mounts when the player is on
          foot and within 6 m (visual) of their own ship — the
          server is authoritative at 5 m so the pill appears a
          hair before the press would succeed. On `E` press the
          client sends `enter_ship`; the server commits the
          character → ship entity switch and fires an
          `enter_ship_ok` ack so the camera + controls swap back
          to the cockpit on the same frame. */}
      <EnterShipPrompt
        shipId={enterShipState.shipId}
        characterPos={enterShipState.characterPos}
        enabled={status === "online"}
        onEnter={() => {
          try {
            client.sendEnterShip();
          } catch {
            // Same swallow rationale as `onExit()` above.
          }
        }}
      />
      {/* TASK-33: on-foot interaction prompt. Projects every entity
          in the live snapshot through `interactableFromWire`,
          runs the cone raycast, and shows a single "[E] …" pill
          when a candidate lands inside the 3 m × 30° forward
          cone. Hides entirely on no-match. The TASK-52 on-foot
          HUD now hosts its own unified `<InteractionLine>` —
          see the `<OnFootHUD>` mount below. */}
      {/* TASK-39: cargo transfer modal. Opens via the on-foot
          "Open cargo" prompt at the docked ship (TASK-33 registry
          slot). The panel is keyboard-friendly: `Esc` closes via
          the parent-owned key handler. */}
      <CargoPanel
        client={status === "online" ? client : null}
        inventory={ownInventory}
        cargo={ownCargo}
        open={cargoPanelOpen}
        onClose={() => setCargoPanelOpen(false)}
      />
      {/* TASK-40: dock sell modal. Opens via the server's
          `ui_open { ui: "dock" }` directive when the player
          presses `E` on a dock-terminal interactable. The
          Sell tab lists every deposit resource with its base
          price + the player's combined sellable amount (hold
          + inventory) + per-row "Sell 1" / "Sell all" buttons.
          A floating "+N cr" appears on each successful sale;
          the credits counter on the right rail updates via
          the `sell_ok` subscription. */}
      <DockPanel
        client={status === "online" ? client : null}
        inventory={ownInventory}
        cargo={ownCargo}
        balance={creditsBalance}
        open={dockPanelOpen}
        onClose={() => shell.back()}
        authToken={token}
        energy={hudWeaponState?.energy ?? null}
        onBalanceChange={setCreditsBalance}
      />
      {/* TASK-53: the ESC menu shell. The menu is a transient
          overlay — the world keeps simulating while it is open
          (multiplayer), only local input is suppressed. */}
      {shell.top === "menu" ? (
        <MenuPanel
          callsign={client.currentCallsign}
          credits={creditsBalance}
          onSelect={(item) => {
            switch (item) {
              case "resume":
                shell.close();
                return;
              case "systems":
                shell.open("systems");
                return;
              case "ships":
                shell.open("ship");
                return;
              case "settings":
                shell.open("settings");
                return;
            }
          }}
        />
      ) : null}
      {/* TASK-53: the shared ship panel (Overview / Cargo / Repair).
          The dock panel is the same component with the
          `on-foot-dock` context (see `<DockPanel>` above). */}
      <ShipPanel
        client={status === "online" ? client : null}
        context={ownOnPad !== null ? "docked-ship" : "in-flight"}
        open={shell.stack.includes("ship")}
        onClose={() => shell.back()}
        inventory={ownInventory}
        cargo={ownCargo}
        balance={creditsBalance}
        authToken={token}
        energy={hudWeaponState?.energy ?? null}
        onBalanceChange={setCreditsBalance}
      />
      {shell.top === "settings" ? (
        /* TASK-54: the settings surface. It hosts the reduced-motion
           toggle (the shared settings flag the FX registry reads). */
        <SettingsPanel onClose={() => shell.back()} authToken={token} />
      ) : null}
      {/* TASK-52: the unified interaction prompt (cone-raycast +
          mining radial) lives inside `<OnFootHUD>` only. The
          callback props were lifted to App.tsx so the WS layer
          stays the single owner of the dispatch paths. */}
      <header
        data-testid="drift-header"
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          padding: "8px 12px",
          background: "rgba(0, 0, 0, 0.4)",
          borderRadius: 6,
          letterSpacing: "0.18em",
          fontSize: 12,
          textTransform: "uppercase",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span>Drift — {statusLabel(status, client.currentCallsign)}</span>
        {/* TASK-7: "Systems" button — opens the star chart
            overlay. Mirrors the `M` key binding so the player
            can use either surface. */}
        <button
          data-testid="drift-systems-button"
          type="button"
          aria-label="Open star chart"
          aria-pressed={chartOpen ? "true" : "false"}
          onClick={() => shell.open("systems")}
          style={{
            background: "transparent",
            border: "1px solid rgba(255, 255, 255, 0.25)",
            color: "#e6edf3",
            borderRadius: 3,
            padding: "3px 8px",
            cursor: "pointer",
            fontSize: 10,
            letterSpacing: "0.16em",
            fontFamily: "inherit",
            textTransform: "uppercase",
          }}
        >
          Systems (M)
        </button>
      </header>
      {error && (
        <div
          data-testid="drift-error-banner"
          style={{
            position: "absolute",
            top: 56,
            left: 16,
            padding: "6px 10px",
            background: "rgba(248, 81, 73, 0.85)",
            color: "#ffffff",
            borderRadius: 6,
            fontSize: 11,
            letterSpacing: "0.04em",
            maxWidth: 480,
          }}
        >
          {error}
        </div>
      )}
      <PlayerList store={store} />
      <RemoteCharacters ownCallsign={client.currentCallsign} />
      <ToastStack store={store} notificationStore={notifications} />
      <ChatLog
        store={client.chatStore}
        canSend={status === "online"}
        onSend={(t) => client.sendChat(t)}
      />
      {/* TASK-7: star chart overlay. Renders above the canvas
          + HUD but below the connection-lost overlay. The
          `Esc` key, the close button, and the host's `M`-key
          toggle all flip `chartOpen`. */}
      <StarChart
        open={chartOpen}
        onClose={() => shell.back()}
        overview={overview}
        occupancy={occupancy}
        currentSystemId={client.currentSystemId}
        warpStore={warpStore}
        authToken={token}
        callbacks={{
          onWarp: (targetSystemId) => {
            // Transition the warp machine synchronously so the
            // overlay paints the streak immediately. The actual WS
            // frame goes out after the 2 s warp-in so the player
            // gets the full streak animation the spec calls for
            // ("2 s in + network + 2 s out"). The chart's Warp
            // button is disabled while a warp is in flight, so
            // the user can't queue a second warp here.
            warpStore.requestWarp(targetSystemId);
            window.setTimeout(() => {
              try {
                client.sendWarp(targetSystemId);
              } catch (err) {
                // The chart only enables the Warp button while the
                // client is online, but defensive: a mid-flight
                // disconnect + reconnect race could fire `sendWarp`
                // against a closed socket. Roll the machine back to
                // `idle` + surface a toast so the player isn't left
                // staring at a stuck "Warping…" badge.
                warpStore.warpFailed(
                  {
                    code: "transport-error",
                    message: (err as Error).message,
                    targetSystemId,
                  },
                  Date.now(),
                );
                notifications.push({
                  kind: "warp-failed",
                  text: `Warp failed: ${(err as Error).message}`,
                  ts: Date.now(),
                });
              }
            }, 2_000);
          },
        }}
      />
      {/* TASK-8: warp overlay. Mounted unconditionally so the
          streak layer can drive the auto-complete timer without
          racing the chart's open state. */}
      <WarpOverlay warpStore={warpStore} />
      {/* TASK-57: dev-only in-game frame monitor (FPS / p50 / p95
          / p99 / draws / tris / ents). Toggled with F3 via the
          `toggleDebugOverlay` handler registered below; hidden in
          production builds via `import.meta.env.DEV`. */}
      {devMode && <DebugOverlay monitor={frameMonitor} open={debugOverlayOpen} />}
      {/* TASK-43: weapon FX overlay (laser flashes, missile tracers,
          impact flashes + 2 px screen shake). Mounts unconditionally
          because the FX layer is a no-op until `fire_ok` /
          `combat_event` frames land. The component polls the layer
          at 30 Hz so flashes animate smoothly without flooding
          React with state updates. */}
      <WeaponFxHud layer={weaponFx} />
      {/* TASK-50: the assembled combat HUD — target box (world-anchored
          bracket), weapon / energy readout (bottom-center, above the
          prompt line), threat ping (screen-edge wedge) and the kill
          feed (top-center). Every region lives in its slot from
          `combat/hud/layout.ts`, so the combat HUD never overlaps the
          prompt line, the player list, the chat or the debug overlay
          (the disjointness test pins that). State lands at the 10 Hz
          snapshot cadence; the only per-frame work is the target-box
          projection, which writes a ref'd style inside the `hud`
          frame-monitor budget. */}
      <CombatHUD
        targeting={client.getTargeting()}
        killFeed={client.getKillFeed()}
        weaponState={hudWeaponState}
        targetSource={hudTargetSource}
        monitor={frameMonitor}
        onSelectWeapon={(weapon) => {
          try {
            client.sendSelectWeapon(weapon);
          } catch {
            // Same swallow rationale as the other HUD callbacks.
          }
        }}
        targetScreenOverride={hudTargetScreenOverride}
      />
      {/* TASK-52: HUD mode switch — the ship and on-foot subtrees
          never render at the same time. `useHudMode()` reads the
          `__driftClient.controls.isOnFoot()` bit and reflects it
          into a `hudMode.mode ∈ { 'ship', 'character' }` value
          so the swap is atomic with the camera handoff (the
          `Controls.setOnFoot(...)` impl fires on the same frame
          the entity_update envelopes land). */}
      {hudMode.mode === "ship" ? (
        /* TASK-51: ship HUD — speed / altitude / regime / nav /
           docked tag / vitals bar. Reads the local predictor's
           `state()` at the 10 Hz HUD cadence (same pattern as
           the combat HUD above). The `flashController` is fed
           by `combat_event { kind: 'hit' | 'damaged' }` frames
           that resolve to a self-target. */
        <ShipHUD
          snapshot={shipHudOverride ?? shipHud.snapshot}
          flashController={hitFlashController}
          monitor={frameMonitor}
          onOpenCargo={() => shell.open("ship")}
        />
      ) : (
        /* TASK-52: on-foot HUD — exposure meter, weight bar,
           unified interaction line. Hides the weapon/target-box
           regions (those live in <CombatHUD>) by mounting only
           the on-foot subtree. */
        <OnFootHUD
          hazardStore={client.getHazardStore()}
          interactor={localInteractor}
          interactables={interactables}
          enabled={status === "online"}
          monitor={frameMonitor}
          onInteract={(targetId, action) => {
            try {
              client.sendInteract(targetId, action);
            } catch {
              // Same swallow rationale; the `enabled` prop already
              // gates on `online`.
            }
          }}
          onEnter={() => {
            try {
              client.sendEnterShip();
            } catch {
              // Same swallow rationale.
            }
          }}
          onMineStart={(targetId) => {
            try {
              client.sendMine(targetId);
            } catch {
              // Same swallow rationale.
            }
          }}
          onMineStop={() => {
            try {
              client.sendMineStop();
            } catch {
              // Same swallow rationale.
            }
          }}
        />
      )}
      {/* TASK-49: destruction FX layer — explosion + 1 s slow-mo +
          the 2 s "SHIP LOST" moment + wreck killer markers. Fed by
          `combat_event { kind: 'destroyed' }` frames through
          `client.getDestruction()`. Rendered regardless of HUD
          mode so the explosion stays on screen even while the
          on-foot HUD mounts (the FX layer has its own timer +
          canvas and doesn't depend on the HUD mode). */}
      <DestructionFx store={client.getDestruction()} />
      {/* TASK-48: bottom-left hazard scope (storm discs, rad-zone
          discs, drone glyphs within 500 m). Fed by the
          `hazard_update` cell list + the entity_update drone
          markers; hidden when the player is nowhere near a
          hazard. */}
      <HazardLayer store={client.getHazardStore()} />
      {/* TASK-17: "Connection lost" overlay. Renders when the
          DriftClient's retry budget is exhausted. The Retry button
          re-runs `start()` which re-claims a fresh token (the
          saved token may have expired in long absences). The
          overlay is the only full-screen UI in v1; it must NOT
          block the ESC menu (a future TASK-58 wires the menu). */}
      {status === "lost" && (
        <div
          data-testid="drift-connection-lost"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0, 0, 0, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
          }}
        >
          <div
            style={{
              padding: "20px 24px",
              background: "rgba(20, 24, 32, 0.95)",
              border: "1px solid rgba(248, 81, 73, 0.6)",
              borderRadius: 8,
              color: "#ffffff",
              fontFamily: "system-ui, sans-serif",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              minWidth: 280,
            }}
          >
            <div
              style={{
                fontSize: 14,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "rgba(248, 81, 73, 1)",
              }}
            >
              Connection lost
            </div>
            <div style={{ fontSize: 12, color: "#9aa3ad" }}>
              We could not reach the server for 30 s. Click Retry to reconnect.
            </div>
            <button
              data-testid="drift-retry-button"
              type="button"
              onClick={() => {
                // TASK-56: resume the session we already hold when
                // there is one — `start()` would try to claim a
                // brand-new callsign on top of the old player.
                if (firstLaunch.session !== null) {
                  void client.startWithSession({
                    token: client.tokenSnapshot() ?? "",
                    callsign: firstLaunch.session.callsign,
                    systemId: firstLaunch.session.lastSystemId ?? firstLaunch.session.homeSystemId,
                  });
                  return;
                }
                void client.start();
              }}
              style={{
                alignSelf: "flex-end",
                padding: "6px 14px",
                background: "rgba(46, 160, 67, 0.9)",
                color: "#ffffff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Pretty-print the lifecycle status for the header pill. */
function statusLabel(status: string, callsign: string | null): string {
  switch (status) {
    case "online":
      return callsign ?? "online";
    case "claiming":
      return "claiming";
    case "connecting":
      return "connecting";
    case "handshaking":
      return "handshake";
    case "joining":
      return "joining system";
    case "reconnecting":
      return "reconnecting";
    case "disconnected":
      return "disconnected";
    case "lost":
      return "connection lost";
    case "error":
      return "error";
    default:
      return "scaffold";
  }
}
