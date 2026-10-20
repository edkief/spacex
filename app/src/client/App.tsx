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
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { InteractionPrompt } from "./components/InteractionPrompt.js";
import { WeightBar, useOwnInventory } from "./components/WeightBar.js";
import { CargoPanel, useOwnCargo } from "./components/CargoPanel.js";
import { DockPanel } from "./components/DockPanel.js";
import { RadialMiningProgress } from "./components/RadialMiningProgress.js";
import { useMiningState } from "./components/useMiningState.js";
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
import { DebugOverlay } from "./perf/DebugOverlay.js";
import { FrameMonitor } from "./perf/frameMonitor.js";
import { WeaponHud } from "./components/WeaponHud.js";
import { WeaponFxHud } from "./components/WeaponFxHud.js";
import { KillFeed } from "./components/KillFeed.js";
import { DestructionFx } from "./components/DestructionFx.js";
import { ExposureMeter } from "./components/ExposureMeter.js";
import { HazardLayer } from "./world/HazardLayer.js";
import { WeaponFxLayer } from "./fx/weapons.js";
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
  // TASK-43: weapon FX layer. Owned by the top-level shell so
  // every component that receives `combat_event` frames can
  // route them into the FX layer without re-creating the
  // active flash / tracer / impact arrays.
  const weaponFx = useMemo(() => new WeaponFxLayer(), []);
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
  const [chartOpen, setChartOpen] = useState(false);
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
        setDockPanelOpen(true);
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
        setDockPanelOpen(true);
    }
    client.start().catch(() => {
      // Errors already surface via the onError listener; the
      // start() promise is intentionally fire-and-forget so the
      // HUD stays responsive during the handshake.
    });
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
  }, [client, notifications]);

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

  const toggleChart = useCallback(() => setChartOpen((o) => !o), []);
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
      } else if (ev.key === "Escape" && chartOpen) {
        // Only swallow Escape when the chart is actually open;
        // otherwise other overlays (TASK-58 menu) may need it.
        ev.preventDefault();
        setChartOpen(false);
      } else if (import.meta.env.DEV && ev.key === "F3") {
        // F3 toggles the in-game frame monitor. Gated on dev so
        // the production bundle never registers the listener.
        ev.preventDefault();
        toggleDebugOverlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleChart, chartOpen, toggleDebugOverlay]);

  const store = client.presenceStore;

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
  const [dockPanelOpen, setDockPanelOpen] = useState(false);
  // TASK-40: live credit balance. Mirrors the value the server
  // reports via `sell_ok` (or `/api/players` for the initial read).
  // The DockPanel renders it in the right rail so the player
  // sees the count tick up on every sell.
  const [creditsBalance, setCreditsBalance] = useState(0);
  // TASK-38: mining state — server-timed radial progress driven
  // by `mining_update` echoes. The hook is independent of the
  // WS online state so a connection drop cancels the radial via
  // a stale `update` snapshot.
  const mining = useMiningState(client);

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
      <CanvasStage />
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
      <RadialMiningProgress
        update={mining.update}
        receivedAtMs={mining.receivedAtMs}
        enabled={status === "online"}
      />
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
          cone. Hides entirely on no-match. */}
      {/* TASK-34: on-foot inventory HUD. Bottom-right weight bar
          (weightUsed / 40) + per-stack tooltip on hover. Hidden
          until the first `inventory_update` frame lands. */}
      <WeightBar inventory={ownInventory} />
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
        onClose={() => setDockPanelOpen(false)}
      />
      <InteractionPrompt
        interactor={localInteractor}
        interactables={interactables}
        enabled={status === "online"}
        onInteract={(targetId, action) => {
          try {
            client.sendInteract(targetId, action);
          } catch {
            // Same swallow rationale as above; the `enabled` gate
            // already prevents the common path.
          }
        }}
        // TASK-35: ship targets (action `'enter'`) route through
        // `sendEnterShip` instead of the generic interact path.
        // The two paths share the same keyboard handler so the
        // registry-side prompt text + visible affordance stay
        // consistent for the player.
        onEnter={() => {
          try {
            client.sendEnterShip();
          } catch {
            // Same swallow rationale.
          }
        }}
        // TASK-38: hold-E mining — keydown sends `mine`, keyup
        // sends `mine_stop`. The radial progress component reads
        // the server's `mining_update` echoes to render the
        // 1.5 s sweep + the "+1 iron" float.
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
          onClick={() => setChartOpen(true)}
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
        onClose={() => setChartOpen(false)}
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
      {/* TASK-47: kill feed (top-center, last 5 kills, 10 s TTL).
          Fed by `combat_event { kind: 'kill' }` frames routed
          through `client.getKillFeed().applyKillEvent`. PvP kills
          render white, player-vs-AI kills grey. Mounts only when
          the underlying store has entries (so the slot stays
          invisible during a calm minute of flight). */}
      <KillFeed store={client.getKillFeed()} />
      {/* TASK-49: destruction FX layer — explosion + 1 s slow-mo +
          the 2 s "SHIP LOST" moment + wreck killer markers. Fed by
          `combat_event { kind: 'destroyed' }` frames through
          `client.getDestruction()`. */}
      <DestructionFx store={client.getDestruction()} />
      {/* TASK-48: bottom-right exposure meter. Renders the
          player's personal hazard pool + recovering badge.
          Mounts unconditionally; returns null when the store
          hasn't been populated (the meter shows the full bar
          by default and only "lights up" when a hazard_update
          lands). */}
      <ExposureMeter store={client.getHazardStore()} />
      {/* TASK-48: bottom-left hazard scope (storm discs, rad-zone
          discs, drone glyphs within 500 m). Fed by the
          `hazard_update` cell list + the entity_update drone
          markers; hidden when the player is nowhere near a
          hazard. */}
      <HazardLayer store={client.getHazardStore()} />
      {/* TASK-43: weapon HUD stub (active weapon name + energy bar +
          lockout indicator). The full HUD is TASK-50; for now this
          proves the energy + weapon-selector wiring without
          colliding with the existing weight-bar / cargo-panel
          hooks. Mounts only when a snapshot is available so the
          HUD doesn't flicker mid-handshake. */}
      <WeaponHud client={client} />
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
