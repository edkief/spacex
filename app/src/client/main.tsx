import React from 'react';
import { createRoot } from 'react-dom/client';
import { HealthPayload } from '@shared/health';
import { ClientSession, type ClaimedSession, type ConnectionState } from '@client/net/session';
// TASK-56: the boot flow (stored token → /api/session → join) + the claims
// screen (the only entry to a session) + the first-launch guidance line.
import {
  clearStoredSession,
  readStoredCallsign,
  readStoredToken,
  restoreSession,
} from '@client/net/session-boot';
import { ClaimsScreen } from '@client/ui/claims-screen';
import { GuidanceHint } from '@client/ui/guidance-hint';
import { guidanceEvent } from '@client/ui/guidance';
import { PresenceStore } from '@client/net/presence';
import { ChatStore } from '@client/net/chat';
import { PlayerList } from '@client/hud/player-list';
import { ToastStack } from '@client/hud/toast-stack';
import { CombatHud } from '@client/ui/combat-hud/combat-hud';
import type { CameraSample } from '@client/ui/combat-hud/projection';
import type { Viewport } from '@client/ui/combat-hud/layout';
import {
  callsignForPlayer,
  indexKillFeedEntities,
  indexKillFeedPlayers,
  killFeedSubscribe,
  pushKillEvent,
} from '@client/state/kill-feed';
import { announce } from '@client/a11y/announcement-queue';
import {
  applySettings,
  settingsState,
  setDetectedProfile,
  deviceProfileChangeSubscribe,
  effectiveProfileKey,
} from '@client/a11y/reduced-motion';
import { detectProfile, PERF_PROFILES } from '@shared/perf';
import { setLodRadii } from '@client/world/chunks';
import { applyPerfProfile } from '@client/perf/profile-bridge';
import { setWarpPhase, WARP_IN_MS, WARP_OUT_MS } from '@client/state/warp';
import { normalizeSettings, scaleLookDemand, type Settings } from '@shared/settings';
import { LiveRegion } from '@client/a11y/live-region';
import { showShipLost } from '@client/state/ship-lost';
import { ChatLog } from '@client/hud/chat-log';
import { createStarfield } from '@client/render/starfield';
import { WorldManager } from '@client/world/WorldManager';
import type { SelfShipInput } from '@client/world/self-ship';
import { StarChart } from '@client/ui/star-chart';
import { WarpOverlay } from '@client/ui/warp-overlay';
import { ShipLostOverlay } from '@client/ui/ship-lost-overlay';
import { ReentryTint } from '@client/ui/reentry-tint';
// TASK-52: the ONE HUD mode switch — ShipHudArea (flight HUD + docked/leave
// prompts + cargo) XOR OnFootHud (exposure meter + weight bar + interaction
// line), never both (the mode = the player's active entity kind).
import { HudRoot, type HudMode } from '@client/ui/hud-root';
import type { NavSample } from '@client/ui/ship-hud/nav-readout';
import { flashHullHit, selfShipView, setSelfShipView } from '@client/state/ship-hud';
import { setChartTarget } from '@client/state/chart-target';
import { clearHazard, setHazardFrame, type HazardFrame } from '@client/state/hazards';
import { CargoPanel } from '@client/ui/cargo-panel';
import { openCargoPanel, closeCargoPanel } from '@client/state/cargo';
import { DockPanel } from '@client/ui/dock-panel';
import { CreditsCounter, CreditFloatLayer } from '@client/ui/credits-hud';
import {
  openDockPanel,
  closeDockPanel,
  applySellResult,
  type DockHoldView,
  type DockInventoryView,
} from '@client/state/dock';
import { credits, creditsSubscribe, setCredits } from '@client/state/credits';
import { pushCreditFloat } from '@client/state/credit-float';
import { inventory, inventorySubscribe, setInventory } from '@client/state/inventory';
// TASK-53: the ONE open-surface stack (ESC menu / star chart / shared panel)
// + the two modal surfaces it drives.
import {
  anySurfaceOpen,
  closeAllSurfaces,
  menuStack,
  menuSubscribe,
  openChart,
  openMenu,
  openPanel,
  popSurface,
  topSurface,
  type Surface,
} from '@client/state/menu';
import { EscMenu } from '@client/ui/esc-menu';
import { ShipPanel, shipClassFor, type PanelShipView } from '@client/ui/ship-panel';
import { canonicalJson } from '@shared/canonical';
import type { Livery } from '@shared/ships';
import {
  setMiningActive,
  setMiningEnded,
  type MiningActiveFrame,
  type MiningEndedFrame,
} from '@client/state/mining';
import { RESOURCE_IDS, type ResourceId } from '@shared/inventory';
import {
  createInteractableRegistry,
  interactableTargetsFrom,
  nextPromptState,
  resolveInteract,
  type InteractSend,
  type PromptState,
} from '@client/input/interaction';
import type { InteractableTarget } from '@shared/interaction';
import { WarpController, warpSubscribe } from '@client/state/warp';
import { setReentryTint } from '@client/state/reentry';
import {
  dockedIndicator,
  dockedIndicatorSubscribe,
  isDocked,
  setDockedIndicator,
} from '@client/state/docked';
import { reentryTintFactor } from '@shared/physics/atmosphere';
import { FrameMonitorOverlay } from '@client/ui/debug-overlay';
import { systemForId } from '@shared/galaxy/system';
import { installDriftDebug, reportServerSeed, reportWorldSwap } from '@client/drift-debug';
import { installStreamDebug } from '@client/stream-debug';
import { installCameraDebug } from '@client/camera/camera-debug';
import { installAtmosphereDebug } from '@client/atmosphere-debug';

import {
  ingestCombatEvent,
  ingestTargetingEntities,
  onTargetingError,
  toggleTargetLock,
} from '@client/state/targeting';
import { playCombatFx, type CombatEvent } from '@client/fx';
import { recordCombatEvent } from '@client/fx-debug';
import type { WeaponId } from '@shared/weapons';
import { RegimeWiring } from '@client/state/regime-wiring';
import { CharacterPredictor, characterStateFromWire } from '@client/net/character-prediction';
import { installCharDebug } from '@client/char-debug';
import { installHazardDebug } from '@client/hazard-debug';
import { installInteractDebug } from '@client/interact-debug';
import { bindDepositsDebug, installDepositsDebug } from '@client/deposits-debug';
import { bindSelfShipDebug, installSelfShipDebug } from '@client/self-ship-debug';
import { bindRemoteShipsDebug, installRemoteShipsDebug } from '@client/remote-ships-debug';
import { bindHazardWorldDebug, installHazardWorldDebug } from '@client/hazard-world-debug';
import { installTransitionDebug } from '@client/test/transitionCycle';
import { normalizeEntityState } from '@shared/protocol/schemas';
import type {
  ChatMessage,
  EntityState,
  InputPayload,
  WireEntityState,
} from '@shared/protocol/schemas';
import { inputToCharacterInput, shipInputToPayload } from '@shared/protocol/inputs';
import { InputFrameSender, effectiveFlightPressed, shipInputKey } from '@client/input/flight-loop';
import { ClientShipPredictor, shipStateFromWire } from '@client/net/prediction';
import type { ShipClassId } from '@shared/ships';
import type { Regime } from '@shared/regime';
import type { Vec3 } from '@shared/physics/vec';

/**
 * TASK-70: the starfield seed. Matches the server's default GALAXY_SEED so
 * every client boots on the same sky; per-system stars arrive with the
 * streaming pipeline (TASK-26).
 */
const STARFIELD_SEED = 'DRIFT-SEED-0001';

/**
 * TASK-73: how many CONSECUTIVE null frames the on-foot interaction raycast
 * must report before the prompt (and E's dispatch target) is cleared. The
 * predicted state flickers resolved↔null near the 3 m / 30° boundaries
 * (release coast + prediction lead); holding ~50 ms (3 frames @ 60 fps)
 * keeps the invariant that a visible prompt is always dispatchable.
 */
const INTERACT_HOLD_FRAMES = 3;

/** TASK-53: the shared panel's view before the first ship entity arrives. */
const EMPTY_PANEL_SHIP: PanelShipView = {
  classId: null,
  hull: null,
  shields: null,
  energy: null,
  livery: null,
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * TASK-53: the wire livery (an open `Record<string,string>`) → the panel's
 * strict 3-slot `Livery`, or null when any slot is missing/invalid (the
 * panel then falls back to the class default paint).
 */
function panelLiveryFromWire(l: Record<string, string> | null | undefined): Livery | null {
  if (!l) return null;
  const { hull, accent, trim } = l;
  if (
    typeof hull === 'string' &&
    typeof accent === 'string' &&
    typeof trim === 'string' &&
    HEX_COLOR.test(hull) &&
    HEX_COLOR.test(accent) &&
    HEX_COLOR.test(trim)
  ) {
    return { hull, accent, trim };
  }
  return null;
}

/** Fetches the REST health endpoint through the Vite same-origin proxy. */
async function fetchHealth(): Promise<HealthPayload | null> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return null;
    return (await res.json()) as HealthPayload;
  } catch {
    return null;
  }
}

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/**
 * TASK-72: the self-ship mesh state from a wire ship entity (a missing rot
 * is identity — the shared-schema default; the livery is wire-optional).
 */
const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };
function selfShipStateFrom(e: EntityState): SelfShipInput {
  return {
    classId: e.classId,
    pos: e.pos,
    rot: e.rot ?? IDENTITY_ROT,
    livery: e.livery ?? null,
  };
}

/**
 * TASK-15: boot the game session (WS → join home system) and keep the
 * PresenceStore fed from the snapshot + presence events. A `?sys=` URL
 * param overrides the join target (used by e2e + dev to meet a peer in a
 * specific system).
 *
 * TASK-17: reconnect resync. ClientSession auto-retries dropped sockets
 * (1 s backoff, cap 5 s) and re-joins the SAME system; every enter_system
 * snapshot arrives through onSnapshot. First join = full boot (fresh
 * stores); resync into the same system = rebuild presence (emits only on
 * real change), merge the chat history (preserved, no reset), and fire the
 * 'reconnected' toast — no full UI reset. Prediction/remote buffers are
 * rebuilt from the same snapshot by the render layer (the prediction
 * rewind path absorbs the away-gap).
 */
function useGameSession(
  session: ClaimedSession | null,
  store: PresenceStore,
  chatStore: ChatStore,
  // TASK-73: the regime manager is created in the caller (the self-entity
  // bridge closures need it too) and returned so the ship input loop can
  // read the active scheme + tracker regime.
  regimeWiring: RegimeWiring,
  clientRef: React.RefObject<ClientSession | null>,
  seedRef: React.RefObject<string>,
  onError: (msg: string) => void,
  // TASK-28.1: bridge the LIVE self position + tracker regime to the
  // atmosphere view (dome + skybox crossfade). Optional callback so the
  // hook stays usable without a WorldManager; the caller passes a closure
  // that reads worldRef.current lazily (only when a WS message fires).
  onAtmosphereView?: (pos: Vec3, regime: Regime) => void,
  // TASK-31: the resolved SELF entity (character FIRST — once disembarked
  // both the frozen ship and the character carry the player's callsign) +
  // the player's ship ENTITY (its id is the exit_ship payload; TASK-72: the
  // full entity drives the self-ship mesh, which keeps rendering while the
  // player is on foot). Null when the snapshot batch carries no own entity.
  onSelfEntity?: (self: EntityState | null, ship: EntityState | null) => void,
  // TASK-32: the last input seq the server APPLIED (10 Hz 'ack' frames) —
  // the character predictor reconciles against it.
  onAck?: (seq: number) => void,
  // TASK-33: every entity_update batch → the interaction raycast's target
  // list (deposits / ships / terminals only — sparse by construction).
  onWorldEntities?: (entities: EntityState[]) => void,
  // TASK-33: a system snapshot (boot / warp / resync) → the target list is
  // rebuilt from GROUND TRUTH (and the prompt never carries stale state).
  onSnapshotEntities?: (entities: EntityState[]) => void,
  // TASK-38: the server's authoritative mining-channel frame (per-connection
  // 'mining' — 10 Hz while channeling + one final 'ended'). The caller
  // resolves the deposit's resource for the '+1 <resource>' float.
  onMining?: (frame: {
    phase: 'active' | 'ended';
    depositId: string;
    progress?: number;
    units: number;
    status?: 'mining' | 'full';
    reason?: 'stopped' | 'cancelled' | 'depleted';
  }) => void,
  // TASK-43: every combat_event (the FX entry point — server events only).
  onCombatEvent?: (event: CombatEvent) => void,
  // TASK-43: structured error frames (the weapon denial prompts).
  onWsError?: (code: string) => void,
) {
  const systemParam = React.useMemo(
    () => new URLSearchParams(window.location.search).get('sys'),
    [],
  );
  const [systemId, setSystemId] = React.useState<string | null>(null);
  const [connState, setConnState] = React.useState<ConnectionState>('connecting');
  const systemIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!session) {
      setSystemId(null);
      setConnState('closed');
      return;
    }
    let cancelled = false;
    store.setSelf(session);
    const target = systemParam ?? session.homeSystemId;
    const client = new ClientSession(wsUrl(), session, {
      onMessage: (msg) => {
        if (msg.type === 'chat') {
          chatStore.append(msg.payload as ChatMessage);
          return;
        }
        if (msg.type === 'ack') {
          // TASK-32: the character predictor reconciles on the next self
          // entity_update against the seq the server last APPLIED.
          onAck?.((msg.payload as { seq: number }).seq);
          return;
        }
        if (msg.type === 'ui-open') {
          // TASK-40: the server wants the DOCK panel open (the station-terminal
          // interaction answers with {ui:'dock'}). The payload carries the
          // initial hold + inventory (the server's authority at open time) so
          // the Sell tab renders sellable amounts immediately — no extra round
          // trip (the panel is far from the ship: cargo_open's 5 m reach does
          // not apply at a pad-edge terminal).
          const p = msg.payload as {
            ui: string;
            payload?: { terminalId?: string; hold?: DockHoldView; inventory?: DockInventoryView };
          };
          if (p.ui === 'dock') {
            openDockPanel(
              p.payload?.terminalId ?? null,
              p.payload?.hold ?? null,
              p.payload?.inventory ?? null,
            );
            // TASK-53: the panel rides the menu stack (ESC pops it, game
            // input is gated while it is open).
            openPanel({
              id: 'dock-panel',
              title: 'STATION DOCK',
              context: 'dock',
              activeTab: 'sell',
            });
          }
          return;
        }
        if (msg.type === 'cargo') {
          // TASK-39: the server's cargo-panel frame (the answer to a
          // 'cargo_open' / 'cargo_transfer' — per-connection, never
          // broadcast). It is only ever sent IN RESPONSE to our request,
          // so receiving it opens (or refills) the panel.
          const p = msg.payload as {
            hold: { stacks: Record<string, number>; weightUsed: number; capacity: number };
            inventory?: { stacks: Record<string, number>; weightUsed: number };
          };
          openCargoPanel(p.hold, p.inventory ?? null);
          // TASK-53: the panel rides the menu stack (ESC pops it, game
          // input is gated while it is open). The context — and with it the
          // Repair tab — is the live docked state at open time.
          openPanel({
            id: 'cargo-panel',
            title: 'CARGO',
            context: dockedIndicator() ? 'docked' : 'flight',
            activeTab: 'cargo',
          });
          return;
        }
        if (msg.type === 'hazard') {
          // TASK-48.2: the server's per-player hazard frame (10 Hz while on
          // foot) → the exposure HUD store. The server is the pool's
          // authority (shared/world/hazards.ts); the client only renders.
          setHazardFrame(msg.payload as HazardFrame);
          return;
        }
        if (msg.type === 'sell') {
          // TASK-40: the 'sell' RESULT frame (the WS alias of POST /api/ships/
          // sell — the server only ever sends the result form). The NEW stacks
          // + balance ride it, so the dock panel re-renders (the source stack
          // decreases) and the credits counter updates within one frame, plus
          // the "+N cr" float at the terminal.
          const sp = msg.payload as {
            sold: number;
            earned: number;
            balance: number;
            hold: DockHoldView;
            inventory: DockInventoryView;
          };
          applySellResult(sp.balance, sp.hold, sp.inventory);
          setCredits(sp.balance);
          pushCreditFloat(`+${sp.earned} cr`);
          // TASK-56: the FIRST sale plays the guidance's finale.
          if (sp.sold > 0) guidanceEvent('sale');
          return;
        }
        if (msg.type === 'mining') {
          // TASK-38: the server's authoritative channel frame (10 Hz echo +
          // the final 'ended'). The HUD is driven from this — the client
          // never runs its own channel timer.
          onMining?.(msg.payload as never);
          return;
        }
        if (msg.type === 'entity_update') {
          // TASK-31: the SELF entity is the CHARACTER first — after
          // disembark the frozen docked ship STILL carries the callsign,
          // and the character is the player's active entity (its
          // flightRegime 'surface' drives the controls remap).
          // TASK-18: the wire entity_update is COMPRESSED (defaults omitted
          // — see the entityStateSchema doc); re-apply them ONCE here so
          // every downstream consumer sees the full normalized shape.
          const entities = (msg.payload as { entities: WireEntityState[] }).entities.map(
            normalizeEntityState,
          );
          // TASK-33: the raycast's target list tracks every snapshot batch
          // (a deposit picked up by ANY player leaves this list within one
          // snapshot — the prompt hides with it).
          onWorldEntities?.(entities);
          const charSelf = entities.find(
            (e) => e.kind === 'character' && e.callsign === session.callsign,
          );
          const self =
            charSelf ??
            entities.find((e) => e.kind !== 'character' && e.callsign === session.callsign);
          const shipSelf = entities.find(
            (e) => e.kind === 'ship' && e.callsign === session.callsign,
          );
          onSelfEntity?.(self ?? null, shipSelf ?? null);
          // TASK-25.2: route our OWN 10 Hz snapshot into the regime tracker
          // (server flightRegime authority + last-known-state prediction).
          if (self) regimeWiring.onSelfUpdate(self, Date.now());
          // TASK-28.1: the live tracker regime drives the atmosphere view —
          // passing it (not a local guess) keeps the exit hysteresis band
          // consistent with the sim's regime decision.
          if (self) onAtmosphereView?.(self.pos, regimeWiring.regime);
          // TASK-28.2: cosmetic re-entry tint (COSMETIC ONLY — never feeds
          // physics): fast descent (-vel.y) inside the boundary band lights
          // the orange rim; ascending or space keeps it at 0.
          if (self) {
            const boundary = regimeWiring.atmosphereBoundaryAt(self.pos);
            setReentryTint(boundary > 0 ? reentryTintFactor(-self.vel.y, boundary) : 0);
          }
          // TASK-29.3: DOCKED indicator — visible exactly while the wire
          // regime is 'docked' with a padId set.
          const wasDocked = dockedIndicator();
          if (self) setDockedIndicator(isDocked(self.regime, self.padId));
          // TASK-56: guidance events from the docked TRANSITIONS (the
          // machine ignores the spawn-dock itself — see ui/guidance.ts).
          const becameDocked = dockedIndicator();
          if (becameDocked !== wasDocked) {
            guidanceEvent(becameDocked ? 'docked' : 'undocked');
          }
          // TASK-51: the ship HUD's single input — the server's self ship
          // entity (10 Hz truth, the client never displays a prediction as
          // fact). On foot (self = character) the HUD clears (unmounts).
          if (self && self.kind === 'ship') {
            setSelfShipView({
              pos: self.pos,
              vel: self.vel,
              rot: self.rot ?? { x: 0, y: 0, z: 0, w: 1 },
              hull: self.hull,
              shields: self.shields,
              regime: self.flightRegime ?? 'space',
              padId: self.padId ?? null,
              atMs: Date.now(),
            });
          } else {
            setSelfShipView(null);
          }
          // TASK-34: weight bar — the server's self entity carries the
          // inventory (updates within one snapshot of any pickup/drop).
          setInventory(self?.inventory ?? null);
          // TASK-56: the FIRST pickup (any weight on the person) advances
          // the guidance to the 'load + sell' step.
          if (self?.inventory && self.inventory.weightUsed > 0) {
            guidanceEvent('pickup');
          }
          return;
        }
        if (msg.type === 'combat_event') {
          // TASK-43: the ONE FX entry point — server events only (a denied
          // fire never produced an event, so it never produces FX).
          onCombatEvent?.(msg.payload as CombatEvent);
          return;
        }
        if (msg.type === 'error') {
          // TASK-43: the weapon denial prompts (transient, self-clearing).
          onWsError?.((msg.payload as { code: string }).code);
          return;
        }
        if (msg.type !== 'presence') return;
        const { event, player } = msg.payload as { event: 'join' | 'leave'; player: unknown };
        if (event === 'join') store.presenceJoin(player as never);
        else store.presenceLeave(player as never);
      },
      onState: (state) => {
        if (!cancelled) setConnState(state);
      },
      onSnapshot: (snapshot, reconnect) => {
        if (cancelled) return;
        // TASK-18: snapshots carry compressed wire entities — normalize once
        // (join / warp arrival / reconnect resync all flow through here).
        const entities = snapshot.entities.map(normalizeEntityState);
        if (reconnect && snapshot.systemId === systemIdRef.current) {
          // Same system: the world kept living while we were away.
          // Rebuild presence (unchanged set → no emit, list preserved) and
          // merge only the chat we missed — no reset, then the toast.
          store.applySnapshot(snapshot.players);
          chatStore.mergeSnapshot(snapshot.chat);
          store.reconnected();
        } else {
          // First join (or a different system): full boot.
          store.leaveAll(); // fresh system: drop any stale entries first
          store.applySnapshot(snapshot.players);
          // TASK-16: system-scoped log — the snapshot carries the shard's
          // last 100 (or empties the log on a system change / fresh shard).
          chatStore.loadSnapshot(snapshot.chat);
        }
        systemIdRef.current = snapshot.systemId;
        setSystemId(snapshot.systemId);
        // TASK-25.2: every system snapshot (boot, warp arrival, reconnect)
        // resets server authority and reloads the regime planets.
        regimeWiring.setSystem(seedRef.current, snapshot.systemId);
        // TASK-28.2: a warp must never carry a stale re-entry tint.
        setReentryTint(0);
        // TASK-29.3: a warp must never carry a stale docked state either.
        setDockedIndicator(false);
        // TASK-51: a new system never carries a stale ship view or chart
        // target (the nav readout's implicit dock target is re-derived).
        setSelfShipView(null);
        setChartTarget(null);
        // TASK-34: a warp must never carry a stale weight bar either.
        setInventory(null);
        // TASK-48.2: a warp must never carry a stale hazard state either
        // (the exposure pool is per-player, non-persistent, on-foot only).
        clearHazard();
        // TASK-33: a system snapshot rebuilds the interaction target list
        // from ground truth (and resets any stale prompt state).
        onSnapshotEntities?.(entities);
        // TASK-31: a system snapshot is the ground truth for the player's
        // ACTIVE entity — on foot (character present, e.g. reconnect after a
        // disembark) the capsule stays; otherwise clear any stale on-foot
        // state (warp arrival, boot).
        const charSelf = entities.find(
          (e) => e.kind === 'character' && e.callsign === session.callsign,
        );
        onSelfEntity?.(
          charSelf ??
            entities.find((e) => e.kind !== 'character' && e.callsign === session.callsign) ??
            null,
          entities.find((e) => e.kind === 'ship' && e.callsign === session.callsign) ?? null,
        );
      },
    });
    clientRef.current = client;
    (async () => {
      try {
        await client.connect();
        if (cancelled) return;
        await client.joinSystem(target);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      clientRef.current = null;
      client.close();
      store.leaveAll();
    };
  }, [session, store, chatStore, clientRef, systemParam]);

  return { systemId, connState, regimeWiring };
}

/**
 * Minimal React shell. React owns the DOM UI (HUD/menu placeholder) only;
 * the three.js renderer will take over the canvas, which is mounted outside
 * React so it survives re-renders.
 */
function App() {
  const [health, setHealth] = React.useState<HealthPayload | null>(null);
  // TASK-8: the seed systems are derived from. Starts on the default (which
  // matches the server default) and follows /api/health once it answers.
  const [serverSeed, setServerSeed] = React.useState(STARFIELD_SEED);
  // Ref mirror so the session hook reads the latest seed without re-running
  // its boot effect when /api/health corrects it (TASK-25.2 regime planets).
  const serverSeedRef = React.useRef(STARFIELD_SEED);
  React.useEffect(() => {
    serverSeedRef.current = serverSeed;
  }, [serverSeed]);
  // TASK-56: the boot flow. A stored token resolves against GET /api/session
  // BEFORE the session state ever exists: 200 → straight into the game (no
  // intermediate screen); 401/expired/network → silently back to the claims
  // screen, the old callsign shown disabled (v1 has no recovery).
  const [session, setSession] = React.useState<ClaimedSession | null>(null);
  const [booting, setBooting] = React.useState(() => readStoredToken() !== null);
  const [expiredCallsign, setExpiredCallsign] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = readStoredToken();
      if (!token) {
        setBooting(false);
        return;
      }
      const callsign = readStoredCallsign();
      const result = await restoreSession(token);
      if (cancelled) return;
      if (result.ok) {
        setSession(result.session);
      } else {
        // Expired/invalid token: clear it, back to the claims screen — the
        // old callsign pre-filled and disabled (no error wall).
        clearStoredSession();
        setExpiredCallsign(callsign);
      }
      setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // TASK-33: the interaction pre-filter (own-ship prompt) needs the callsign
  // without re-running the []-dep rAF/key effects when the session boots.
  const sessionCallsignRef = React.useRef('');
  React.useEffect(() => {
    sessionCallsignRef.current = session?.callsign ?? '';
  }, [session]);
  // The player's id (the wire `targetedBy` carries shooter player ids —
  // the target card's 'LOCKED ON' indicator).
  const sessionPlayerIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    sessionPlayerIdRef.current = session?.playerId ?? null;
  }, [session]);

  // TASK-50: the combat HUD layout slots follow the viewport size.
  const [viewport, setViewport] = React.useState<Viewport>({
    w: window.innerWidth,
    h: window.innerHeight,
  });
  React.useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /** Live camera sample for the target-box projection (rAF, ref'd style). */
  const combatCamera = React.useCallback((): CameraSample | null => {
    const world = worldRef.current;
    if (!world) return null;
    const s = world.cameraSample();
    return { ...s, width: window.innerWidth, height: window.innerHeight };
  }, []);
  const [store] = React.useState(() => new PresenceStore());
  const [chatStore] = React.useState(() => new ChatStore());
  // TASK-36 (TASK-74: + remote ships): every snapshot batch feeds BOTH
  // remote render targets — the remote-entity layer (interpolated remote
  // characters + ships + shared ground items, 200 ms behind) and presence'
  // onFoot derivation (the PlayerList icon flips on disembark / re-enter).
  // Refs only — no React state churn.
  const feedRemote = (entities: EntityState[]): void => {
    worldRef.current?.feedRemoteEntities(entities, sessionCallsignRef.current);
    store.applyActiveEntities(entities);
    // TASK-45: the PlayerList AI section (rogues ride the entity list).
    store.applyAiEntities(entities);
    // TASK-44: the targeting store rides the same batch (target box).
    ingestTargetingEntities(
      entities,
      sessionCallsignRef.current,
      Date.now(),
      sessionPlayerIdRef.current,
    );
    // TASK-47: the kill feed indexes every batch so kill events resolve
    // killer (playerId) and victim (ship id) to callsigns.
    indexKillFeedEntities(entities);
  };
  const clientRef = React.useRef<ClientSession | null>(null);
  // TASK-31: the player's ship entity id (latest self entity_update) — the
  // payload of the 'exit_ship' disembark request. Null while on foot or
  // before the first self update.
  const selfShipIdRef = React.useRef<string | null>(null);
  // TASK-32: on-foot input + prediction (refs only — 60 fps state must not
  // re-render React). The local character runs the SAME integrateCharacter
  // as the server (CharacterPredictor, the TASK-14 pattern); input frames
  // ride the plain 'input' message (thrust = fwd/back, yaw = turn, action
  // run/jump) — the server routes by the active entity kind.
  // TASK-25.2/73: the regime manager (tracker + controls remapper) — created
  // here so the session hook AND the self-entity bridge + ship loop all read
  // the same live instance.
  const regimeWiring = React.useMemo(() => new RegimeWiring(), []);
  // TASK-73: the SHARED pressed-key set — one capture feeds BOTH the ship
  // loop (remapper.readInput) and the on-foot loop. Same rules: typing in
  // an input never captures, blur clears everything.
  const pressedRef = React.useRef<Set<string>>(new Set());
  // TASK-73: ONE monotonic input seq + 20 Hz cadence per connection, shared
  // by the ship and on-foot loops (the server drops stale seqs per
  // connection; a disembark/re-entry must never reset the counter).
  const inputSender = React.useMemo(() => new InputFrameSender(), []);
  const charPredictorRef = React.useRef<CharacterPredictor | null>(null);
  // TASK-73: the ship prediction target (client mirror of charPredictorRef)
  // + the last input seq the server APPLIED (shared by both predictors —
  // only the ACTIVE one reconciles).
  const shipPredictorRef = React.useRef<ClientShipPredictor | null>(null);
  const inputAckedSeqRef = React.useRef(0);
  // TASK-51: the ship HUD bridges — the nav arrow reads the LIVE predicted
  // pose (render rate, inside NavReadout's rAF) and falls back to the last
  // 10 Hz snapshot; the implicit dock target is the world's nearest
  // landing pad (the station) and the docked tag resolves the current pad
  // the same way (pad → planet name).
  const shipNavSample = React.useCallback((): NavSample | null => {
    const p = shipPredictorRef.current;
    if (p) {
      const st = p.getState();
      return { pos: st.pos, rot: st.quat };
    }
    const v = selfShipView();
    return v ? { pos: v.pos, rot: v.rot } : null;
  }, []);
  const stationNameFor = React.useCallback((padId: string): string | null => {
    const world = worldRef.current;
    const pad = world ? world.getPads().find((p) => p.padId === padId) : null;
    if (!world || !pad || !world.currentSystemId) return null;
    const sys = systemForId(serverSeedRef.current, world.currentSystemId);
    const planet = sys?.planets.find((pl) => pl.id === pad.planetId);
    return planet ? `${planet.name} STATION` : null;
  }, []);
  const nearestDockTarget = React.useCallback((): { name: string; pos: Vec3 } | null => {
    const world = worldRef.current;
    const pads = world ? world.getPads() : [];
    if (pads.length === 0) return null;
    const s = shipNavSample();
    let best = pads[0];
    let bestD = Infinity;
    for (const p of pads) {
      const d = s ? (p.pos.x - s.pos.x) ** 2 + (p.pos.z - s.pos.z) ** 2 : Number.MAX_VALUE;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return { name: stationNameFor(best.padId) ?? 'STATION', pos: best.pos };
  }, [shipNavSample, stationNameFor]);
  // TASK-73: on-foot flag for the Q-drop gate (drop fires ON FOOT only).
  const onFootRef = React.useRef(false);
  const charLiveryRef = React.useRef<Record<string, string> | null>(null);
  // TASK-33: the on-foot interaction system (refs only — per-frame state must
  // NOT re-render React): the InteractableRegistry is the single dispatch
  // site, the target list tracks the last snapshot batch, and the prompt
  // state machine emits only on a real show/hide/switch (the one React
  // state below flips on that rare change).
  const interactRegistry = React.useMemo(() => createInteractableRegistry(), []);
  const interactTargetsRef = React.useRef<InteractableTarget[]>([]);
  const promptStateRef = React.useRef<PromptState>({ kind: 'hidden' });
  // The last raycast hit (the E key dispatches THIS target through the
  // registry — the only place an 'interact' message is sent).
  const resolvedTargetRef = React.useRef<InteractableTarget | null>(null);
  // TASK-39: the raycast's distance for the current target (the ship's
  // proximity sub-prompts branch on it: Open cargo vs Enter ship).
  const resolvedDistanceRef = React.useRef<number | undefined>(undefined);
  // TASK-73: debounce counter — consecutive frames the on-foot raycast
  // resolved to NULL while a prompt is up. The PREDICTED state (not the
  // server's) drives the raycast, so near the 3 m / 30° boundary the result
  // flickers resolved↔null frame-to-frame (release coast + prediction
  // lead). Holding the last hit across a short null streak keeps the
  // invariant the prompt promises: the visible target is always the target
  // E can dispatch THIS frame.
  const interactNullStreakRef = React.useRef(0);
  const [interactPrompt, setInteractPrompt] = React.useState<string | null>(null);
  // TASK-52: the HUD MODE — the player's active entity kind (the server's
  // self entity_update: 'ship' = in the cockpit, 'character' + onFoot = on
  // foot). ONE source of truth for the HUD root: ShipHudArea XOR OnFootHud,
  // never both. Set at the SAME event as the camera handoff (world's
  // setCharacterPos / reEnterShip), so the switch is atomic with it.
  const [hudMode, setHudMode] = React.useState<HudMode>(null);
  // TASK-43: the weapon HUD state — the active weapon (1/2 keys, client
  // state), the SELF ship's classId + energy (10 Hz entity_update), and the
  // two transient server denial prompts (error frames {code}).
  const [weapon, setWeapon] = React.useState<WeaponId>('laser');
  const [selfShip, setSelfShip] = React.useState<{ classId: string; energy: number | null } | null>(
    null,
  );
  const [lowEnergy, setLowEnergy] = React.useState(false);
  // TASK-54: the screen-reader announcements (the 1 Hz live region drains
  // the queued messages — max 1 pending, 2 s min interval, so combat can't
  // flood the SR): interaction prompts, lock-ons, low energy, kills.
  React.useEffect(() => {
    if (interactPrompt) announce(interactPrompt, 'navigation');
  }, [interactPrompt]);
  React.useEffect(() => {
    if (lowEnergy) announce('Low energy', 'combat');
  }, [lowEnergy]);
  React.useEffect(
    () =>
      killFeedSubscribe((entries) => {
        const latest = entries[entries.length - 1];
        if (latest) announce(`${latest.killer} destroyed ${latest.victim}`, 'combat');
      }),
    [],
  );
  // TASK-53: the ONE open-surface stack (ESC menu / star chart / the shared
  // ship/dock panel) — the modal state for the whole client. Any open
  // surface suppresses game input (only ESC reaches the game); ESC opens
  // the menu from the empty stack and otherwise POPS the top surface
  // (panel → menu → closed). The world keeps simulating underneath
  // (multiplayer — no pause).
  const [stack, setStack] = React.useState<readonly Surface[]>(menuStack);
  React.useEffect(() => menuSubscribe(setStack), []);
  const anyOpen = stack.length > 0;
  const menuOpen = stack.some((s) => s.kind === 'menu');
  const chartOpen = stack.some((s) => s.kind === 'chart');
  const panel = stack.find((s) => s.kind === 'panel') ?? null;
  // The credit balance (menu footer + panel context; the credits store).
  const [balance, setBalance] = React.useState<number | null>(credits);
  React.useEffect(() => creditsSubscribe(setBalance), []);
  // The live docked state (the panel context + the Repair gate).
  const [dockedNow, setDockedNow] = React.useState(dockedIndicator);
  React.useEffect(() => dockedIndicatorSubscribe(setDockedNow), []);
  // The on-foot inventory (the menu SHIPS panel's Cargo tab while on foot).
  const [invView, setInvView] = React.useState(inventory);
  React.useEffect(() => inventorySubscribe(setInvView), []);
  // The transient repair error (the Repair tab's alert line).
  const [repairMessage, setRepairMessage] = React.useState<string | null>(null);
  // TASK-53: the shared panel's ship view (the 10 Hz self/ship entity —
  // hull/shields arrive NORMALIZED 0..1 on the wire; the panel's bars and
  // the repair preview work in ABSOLUTE points, so convert here against the
  // class caps). JSON-gated so the 10 Hz feed re-renders only on a real
  // change (the livery save echo, a hit, an energy tick).
  const [panelShip, setPanelShip] = React.useState<PanelShipView | null>(null);
  const panelShipKeyRef = React.useRef('');
  const updatePanelShip = (e: EntityState | null): void => {
    let view: PanelShipView | null = null;
    if (e && e.kind === 'ship' && e.classId) {
      const cls = shipClassFor(e.classId);
      view = {
        classId: e.classId,
        hull: cls ? e.hull * cls.hull : null,
        shields: cls ? e.shields * cls.shieldCapacity : null,
        energy: e.energy ?? null,
        livery: panelLiveryFromWire(e.livery),
      };
    }
    const key = view ? canonicalJson(view) : '';
    if (key === panelShipKeyRef.current) return;
    panelShipKeyRef.current = key;
    setPanelShip(view);
  };
  const [locked, setLocked] = React.useState(false);
  // TASK-54: announce the lock-on to the SR (combat priority — the live
  // region's queue keeps combat ahead of navigation/chat).
  React.useEffect(() => {
    if (locked) announce('Target locked', 'combat');
  }, [locked]);
  // Refs (the fire handlers are captured once — no stale closures):
  const weaponRef = React.useRef<WeaponId>('laser');
  const selfShipRef = React.useRef(false);
  const selfPosRef = React.useRef<{ x: number; y: number; z: number } | null>(null);
  // TASK-48.3: the on-foot character's last 10 Hz position — drone 'hit'
  // combat_events target THIS entity, so the FX impact flash can resolve it.
  const charPosRef = React.useRef<{ x: number; y: number; z: number } | null>(null);
  const remoteShipsRef = React.useRef<{ id: string; pos: { x: number; y: number; z: number } }[]>(
    [],
  );
  const promptTimers = React.useRef<{ low: number; locked: number }>({ low: 0, locked: 0 });
  // TASK-38: the target dispatched by the CURRENT E hold (E down →
  // onInteract / mine-start; E up or blur → onRelease / mine-stop). Cleared
  // when the channel ends server-side, on a system swap, or when the player
  // is no longer on foot.
  const heldInteractRef = React.useRef<{
    target: InteractableTarget;
    send: InteractSend;
  } | null>(null);
  // Re-render on presence events only (join/leave), never on snapshots, so
  // the "N aboard" occupancy below stays live.
  const [, bumpPresence] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => store.subscribe(bumpPresence), [store]);
  // TASK-47: the kill feed's KILLER lookup (player id → callsign) rides the
  // presence roster — ship entities carry no playerId on the wire. Self is
  // included (a kill YOU land still shows YOUR callsign, not a raw id).
  React.useEffect(
    () =>
      store.subscribe(() => {
        indexKillFeedPlayers([
          ...store.otherPlayers,
          ...(store.selfPlayer ? [store.selfPlayer] : []),
        ]);
      }),
    [store],
  );
  const { systemId, connState } = useGameSession(
    session,
    store,
    chatStore,
    regimeWiring,
    clientRef,
    serverSeedRef,
    (msg) => {
      setError(msg);
      // Token may be stale → back to the claims screen (the old callsign is
      // shown disabled — the TASK-56 expired path).
      setExpiredCallsign(session?.callsign ?? expiredCallsign);
      setSession(null);
      clearStoredSession();
    },
    // TASK-28.1: live atmosphere view. A CLOSURE that reads worldRef.current
    // only when invoked (on WS entity_updates, post-mount) — worldRef is
    // declared below (line ~349), so passing the ref object directly as a
    // hook argument would hit the temporal-dead-zone during render.
    (pos, regime) => {
      const world = worldRef.current;
      if (!world) return;
      // TASK-29.3: the same live position feeds the pad-ring culling.
      world.setShipPos(pos);
      world.setAtmosphereView(pos, regime);
    },
    // TASK-31/35/72: the self-entity bridge — on foot: the capsule follows
    // the character (first call spawns it + runs the camera handoff) and the
    // docked ship mesh keeps updating from the ship entity; back in the ship
    // (re-entry): the world runs the REVERSE handoff (onfoot → chase) once
    // per transition and the rig tracks the ship pose; a missing self
    // entity (system swap / boot) clears all on-foot state. The FIRST self
    // ship update (boot) arms the chase camera behind the player's ship.
    (self, ship) => {
      selfShipIdRef.current = ship?.id ?? null;
      const world = worldRef.current;
      if (!world) return;
      if (self && self.kind === 'character' && self.onFoot) {
        // ON FOOT: the predictor must SURVIVE every 10 Hz self update — the
        // prediction loop owns it between snapshots (clearing it here would
        // stop on-foot input entirely after the first snapshot).
        // TASK-56: the FIRST disembark advances the guidance (a player who
        // walks off the spawn pad without flying still needs the ore hint).
        if (!onFootRef.current) guidanceEvent('disembark');
        onFootRef.current = true; // TASK-73: Q-drop gate (on foot only)
        // TASK-73: disembark drops the ship predictor (the shared seq
        // counter survives — re-entry re-seeds the predictor, not the seq).
        shipPredictorRef.current = null;
        store.setSelfOnFoot(true); // TASK-36: PlayerList icon (self row)
        setHudMode('onfoot'); // TASK-52: HUD root → on-foot subtree (atomic with the handoff)
        selfShipRef.current = false; // TASK-43: on foot = no weapons (v1)
        setSelfShip(null); // TASK-43: hide the weapon HUD on foot
        world.setCharacterPos(self.pos);
        charPosRef.current = { ...self.pos }; // TASK-48.3: drone-hit FX anchor
        // TASK-72: the ship stays rendered while on foot — it sits docked
        // (frozen, but still in every batch) and is the object the character
        // walks back to. Update the mesh from the ship entity every batch.
        world.setSelfShip(ship ? selfShipStateFrom(ship) : null);
        updatePanelShip(ship); // TASK-53: the shared panel views the DOCKED ship
        // TASK-32: the character is the local prediction target — seed the
        // predictor from the first snapshot (flat pad-plane terrain; the
        // 10 Hz snapshot corrects any off-pad drift) and reconcile every
        // self update against the last APPLIED seq (the ack).
        charLiveryRef.current = self.livery ?? null;
        if (!charPredictorRef.current) {
          charPredictorRef.current = new CharacterPredictor(characterStateFromWire(self), {
            heightAt: () => worldRef.current?.characterPadHeight ?? self.pos.y,
          });
        }
        charPredictorRef.current.reconcile(
          characterStateFromWire(self),
          inputAckedSeqRef.current,
          performance.now(),
        );
        if (charDebug) {
          charDebug.pos = { ...self.pos };
          charDebug.rot = self.rot ? { ...self.rot } : undefined;
        }
      } else {
        // NOT on foot (re-entry — TASK-35 — or a system swap / boot reset):
        // the world runs the reverse camera handoff when the self entity is
        // the ship (once, while the capsule still exists; later updates just
        // feed the pose), and clears all on-foot state otherwise.
        onFootRef.current = false; // TASK-73: Q-drop gate (on foot only)
        store.setSelfOnFoot(false); // TASK-36: PlayerList icon (self row)
        charPosRef.current = null; // TASK-48.3: no character → no FX anchor
        // TASK-48.2: back in the ship → the hazard frames stop; drop any
        // stale exposure/hazard state (no on-foot pool while flying).
        clearHazard();
        // TASK-52: HUD root → ship subtree only while the self entity IS the
        // ship (atomic with the reverse handoff above); null at boot/swap.
        setHudMode(self?.kind === 'ship' ? 'ship' : null);
        // TASK-43: the weapon HUD tracks the SELF ship (classId for the
        // loadout, energy for the bar) + the fire handlers' ship refs.
        if (self && self.kind === 'ship') {
          selfShipRef.current = true;
          selfPosRef.current = { ...self.pos };
          setSelfShip({ classId: self.classId, energy: self.energy ?? null });
          updatePanelShip(self); // TASK-53: the shared panel views the SELF ship
          // TASK-72: drive the self-ship mesh (first call spawns it + arms
          // the chase camera) and run the re-entry handoff when a capsule
          // exists (onfoot → chase).
          world.setSelfShip(selfShipStateFrom(self));
          world.reEnterShip(self.pos, self.rot ?? { x: 0, y: 0, z: 0, w: 1 });
          // TASK-73: SEED the ship predictor from the first self ship
          // snapshot; every later update re-sets the flight context
          // (tracker regime + atmosphere + class) and RECONCILES against
          // the last APPLIED seq (the shared ack — the server's authority).
          if (!shipPredictorRef.current) {
            shipPredictorRef.current = new ClientShipPredictor(shipStateFromWire(self), {
              regime: regimeWiring.regime,
              shipClass: self.classId as ShipClassId,
              planet: regimeWiring.planetAtmo,
            });
          } else {
            shipPredictorRef.current.setContext({
              regime: regimeWiring.regime,
              shipClass: self.classId as ShipClassId,
              planet: regimeWiring.planetAtmo,
            });
          }
          shipPredictorRef.current.reconcile(
            shipStateFromWire(self),
            inputAckedSeqRef.current,
            performance.now(),
          );
        } else {
          selfShipRef.current = false;
          setSelfShip(null);
          world.setSelfShip(ship ? selfShipStateFrom(ship) : null);
          updatePanelShip(ship ?? null); // TASK-53: no self ship → the panel has no ship
          world.clearCharacter();
        }
        // No character → no prediction, and no interaction either (TASK-33:
        // the prompt never outlives the on-foot state — e.g. right after
        // re-entering the ship). The ON-FOOT branch above keeps the
        // predictor alive across its 10 Hz snapshots.
        charPredictorRef.current = null;
        // TASK-73: no self ship (system swap / boot / destroyed) drops the
        // ship predictor too — re-entry re-seeds it from the first update.
        if (self?.kind !== 'ship') shipPredictorRef.current = null;
        resolvedTargetRef.current = null;
        resolvedDistanceRef.current = undefined;
        interactNullStreakRef.current = 0;
        heldInteractRef.current = null; // a held E never survives re-entry
        promptStateRef.current = { kind: 'hidden' };
        setInteractPrompt(null);
        if (interactDebug) {
          interactDebug.text = null;
          interactDebug.targetId = null;
          interactDebug.distance = null;
          interactDebug.feet = null;
        }
      }
    },
    // TASK-32/73: input acks — the SHARED applied-seq; whichever predictor
    // is active (ship or on-foot) reconciles on the next self update
    // against it (the server acks the last seq it APPLIED, per connection).
    (seq) => {
      inputAckedSeqRef.current = seq;
      if (charDebug) charDebug.acked = seq;
    },
    // TASK-33: entity_update batches → the raycast's target list (a pickup
    // by ANY player leaves the list within one snapshot → the prompt hides).
    // TASK-36: the same batch feeds the remote characters + ground items.
    (entities) => {
      interactTargetsRef.current = interactableTargetsFrom(entities);
      // TASK-43: the fire intent's aim assist — the nearest OTHER ship the
      // client can see (the server re-validates range/LOS; a claim is a
      // suggestion, never a verdict).
      remoteShipsRef.current = entities
        .filter(
          (e) =>
            (e.kind === 'ship' || e.kind === 'ai-ship') &&
            e.callsign !== sessionCallsignRef.current,
        )
        .map((e) => ({ id: e.id, pos: { ...e.pos } }));
      feedRemote(entities);
    },
    // TASK-33: a system snapshot rebuilds the list from ground truth and
    // clears any stale prompt (boot / warp / resync never carry one).
    // TASK-36: the snapshot is ALSO the remote layer's ground truth (a
    // resync rebuilds the 200 ms buffers from it).
    (entities) => {
      interactTargetsRef.current = interactableTargetsFrom(entities);
      remoteShipsRef.current = entities
        .filter(
          (e) =>
            (e.kind === 'ship' || e.kind === 'ai-ship') &&
            e.callsign !== sessionCallsignRef.current,
        )
        .map((e) => ({ id: e.id, pos: { ...e.pos } }));
      feedRemote(entities);
      promptStateRef.current = { kind: 'hidden' };
      interactNullStreakRef.current = 0;
      setInteractPrompt(null);
      setHudMode(null); // TASK-52: a system swap never carries a HUD mode
      // TASK-38: a system swap never carries a channel — drop the held-E
      // bookkeeping and any stale mining HUD state (the server kills the
      // channel itself on warp departure).
      heldInteractRef.current = null;
      setMiningActive(null);
      setMiningEnded(null);
      // TASK-73: a system swap drops the ship predictor (the next snapshot's
      // self-ship update re-seeds it; the shared seq counter survives).
      shipPredictorRef.current = null;
    },
    // TASK-38: the server's channel frame → the mining HUD store. The
    // '+1 <resource>' float's resource is the deposit's (the target list
    // carries it — the wire deposit entity always has a resourceId now).
    (frame) => {
      const resource =
        interactTargetsRef.current.find((t) => t.id === frame.depositId)?.resourceId ?? null;
      if (frame.phase === 'active') {
        const activeFrame = frame as unknown as MiningActiveFrame;
        setMiningActive(activeFrame, resource);
      } else {
        setMiningEnded(frame as unknown as MiningEndedFrame, resource);
        // The channel died server-side (cancel / depleted / stopped): a
        // later keyup must not send a stale mine-stop for it.
        heldInteractRef.current = null;
      }
    },
    // TASK-43: every combat_event → the FX dispatcher (server events only —
    // a denied fire never produced an event, so it never produces FX).
    (event) => {
      recordCombatEvent(event);
      // TASK-51: the vitals bar's red flash — a hit/destroyed ON OUR ship
      // only (other ships' hits are FX, not our vitals).
      if (
        (event.kind === 'hit' || event.kind === 'destroyed') &&
        event.target === selfShipIdRef.current
      ) {
        flashHullHit(Date.now());
      }
      // TASK-47: the persistent kill feed (top-center, last 5, 10 s fade).
      if (event.kind === 'kill') {
        pushKillEvent(event.killer, event.victim, event.weapon, Date.now());
      }
      // TASK-44: the threat ping feed (hit/destroyed on OUR ship).
      ingestCombatEvent(event, session?.playerId ?? null, Date.now());
      // TASK-49: the 2 s 'SHIP LOST' moment — OUR ship only (the AI's own
      // deaths never show it). The respawn is already server-side
      // (immediate, nearest dock); this is pure presentation. The killer
      // resolves to a callsign via the presence roster; AI / drone ids
      // fall back to the raw id.
      if (event.kind === 'destroyed' && event.target === selfShipIdRef.current) {
        showShipLost({
          callsign: store.selfPlayer?.callsign ?? 'your ship',
          killer: callsignForPlayer(event.source.id) ?? event.source.id,
          at: Date.now(),
        });
      }
      // TASK-46: the AI began acquiring OUR ship — the 'ACQUIRING' toast IS
      // the 1 s acquire delay: read it and break off (gameplay, not a cheat).
      if (event.kind === 'ai-acquiring' && event.target === selfShipIdRef.current) {
        store.notify('ACQUIRING');
      }
      const world = worldRef.current;
      if (!world) return;
      playCombatFx(world.fx, event, (id) => {
        if (id === selfShipIdRef.current) return selfPosRef.current;
        // TASK-48.3: a drone 'hit' targets the on-foot character entity —
        // resolve it from the 10 Hz self updates (same standard event path,
        // no new event type).
        if (onFootRef.current && id === `char:${session?.playerId ?? ''}`) {
          return charPosRef.current;
        }
        return remoteShipsRef.current.find((t) => t.id === id)?.pos ?? null;
      });
    },
    // TASK-43: the weapon denial prompts (transient, self-clearing).
    (code) => {
      if (code === 'low-energy') {
        setLowEnergy(true);
        window.clearTimeout(promptTimers.current.low);
        promptTimers.current.low = window.setTimeout(() => setLowEnergy(false), 1500);
      } else if (code === 'weapon-locked') {
        setLocked(true);
        window.clearTimeout(promptTimers.current.locked);
        promptTimers.current.locked = window.setTimeout(() => setLocked(false), 3000);
      }
      // TASK-44: 'invalid-target' clears the optimistic lock; 'no-target'
      // lights the NO TARGET prompt (both live in the targeting store).
      onTargetingError(code, Date.now());
    },
  );

  // TASK-53: the menu shell — ESC (the global key) + the star chart.
  // ESC from the empty stack opens the ESC menu; while any surface is
  // open, ESC POPS the top (panel → menu → closed), closing the store
  // alongside when the pop is a store-driven panel (cargo / dock).
  // M opens the star chart (the HUD SYSTEMS button is the same call);
  // M again — or ESC — closes it. A menu or panel underneath or on top
  // swallows M (modal: only ESC reaches the game). Typing in an input
  // (chat) never triggers any of this.
  const closePoppedPanel = (popped: Surface | null): void => {
    if (popped?.kind !== 'panel') return;
    if (popped.id === 'cargo-panel') closeCargoPanel();
    else if (popped.id === 'dock-panel') closeDockPanel();
  };
  const closeTopSurface = (): void => {
    closePoppedPanel(popSurface());
  };
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') {
        if (anySurfaceOpen()) {
          closePoppedPanel(popSurface());
          return;
        }
        if (clientRef.current) openMenu(); // no session → nothing to menu
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        const top = topSurface();
        if (top && top.kind !== 'chart') return; // a menu/panel is up → M is game input
        if (top?.kind === 'chart')
          popSurface(); // M closes the chart (the old toggle)
        else if (clientRef.current) openChart();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  React.useEffect(() => {
    if (!systemId && anySurfaceOpen()) closeAllSurfaces(); // no system → no surfaces
  }, [systemId]);
  // TASK-53: opening ANY surface clears the pressed-key set — a physically
  // held key must not keep walking the character or flying the ship under
  // the modal (the game input is suppressed while a surface is open; the
  // world itself keeps moving, the server never knows).
  React.useEffect(
    () =>
      menuSubscribe((s) => {
        if (s.length > 0) pressedRef.current.clear();
      }),
    [],
  );

  // TASK-31: E — LEAVE SHIP. Fires ONLY while the docked prompt is up
  // (state/docked store true ⇒ the player's own entity is a docked ship)
  // and the star chart is closed; typing (chat) never triggers it. The
  // request is a plain 'exit_ship' frame — the server denies with
  // {code:'not-docked'} in the race where the ship leaves the pad.
  const chartOpenRef = React.useRef(chartOpen);
  React.useEffect(() => {
    chartOpenRef.current = chartOpen;
  }, [chartOpen]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'e' && e.key !== 'E') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (anySurfaceOpen()) return; // TASK-53: any open surface is modal (ESC only)
      if (dockedIndicator()) {
        const shipId = selfShipIdRef.current;
        if (!shipId) return;
        clientRef.current?.send('exit_ship', { shipId });
        return;
      }
      // TASK-38: a HELD E (hold, not tap) — the first keydown starts the
      // hold (dispatch → 'mine-start' for deposits); auto-repeat re-sends
      // are ignored (the server is idempotent either way). E up (onKeyUp)
      // releases it. The registry is the ONLY place an 'interact' frame
      // goes out (AC).
      if (e.repeat) return;
      const target = resolvedTargetRef.current;
      if (!target) return;
      const send: InteractSend = (type, payload) => clientRef.current?.send(type, payload);
      // TASK-39: the raycast's distance rides along (the ship's far zone
      // sends 'open-cargo', the near zone 'enter_ship').
      interactRegistry.dispatch(target, resolvedDistanceRef.current, send);
      heldInteractRef.current = { target, send };
    };
    // TASK-38: E up releases the hold — deposits end their mining channel
    // ('mine-stop' — a cancel); kinds without onRelease are a silent no-op.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'e' && e.key !== 'E') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const held = heldInteractRef.current;
      if (!held) return;
      interactRegistry.release(held.target, held.send);
      heldInteractRef.current = null;
    };
    const onBlur = (): void => {
      // The window lost focus: the key is physically released — end the
      // channel so the server never awards into a key nobody holds.
      const held = heldInteractRef.current;
      if (!held) return;
      interactRegistry.release(held.target, held.send);
      heldInteractRef.current = null;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [interactRegistry]);
  // TASK-34: Q — DROP one unit of the first owned resource (catalog order:
  // iron, copper, rare-earth, crystal). The server is the authority: it
  // re-validates ownership + the on-foot regime ('wrong-regime' denial
  // otherwise) and spawns the ground item at the character's position.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'q' && e.key !== 'Q') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (anySurfaceOpen()) return; // TASK-53: any open surface is modal (ESC only)
      // TASK-73: Q drives ROLL in-ship — the drop fires ON FOOT only.
      // (The server would answer 'wrong-regime' anyway; don't send it.)
      if (!onFootRef.current) return;
      const inv = inventory();
      if (!inv) return;
      const resourceId = RESOURCE_IDS.find((id) => (inv.stacks[id] ?? 0) > 0);
      if (!resourceId) return;
      clientRef.current?.send('drop', { resourceId, amount: 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // TASK-44: T — TARGET LOCK toggle (in-ship only). The store picks the
  // nearest valid ship in the 500 m / 30° cone and lights the optimistic
  // box + banner; the server re-validates ('invalid-target' clears it).
  // Pressing T again while locked releases (sends 'target_release').
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 't' && e.key !== 'T') return;
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (anySurfaceOpen()) return; // TASK-53: any open surface is modal (ESC only)
      if (!selfShipRef.current) return;
      const cmd = toggleTargetLock(Date.now());
      if (!cmd) return;
      if (cmd.type === 'lock') {
        clientRef.current?.send('target_lock', { targetId: cmd.targetId });
      } else {
        clientRef.current?.send('target_release', {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // TASK-43: weapon selection (1 = laser, 2 = missile) + LMB fire (the fire
  // INTENT carries the client's aim assist — nearest visible ship; the
  // server re-derives everything). Firing is in-ship ONLY (on-foot has no
  // weapons in v1); the chart open and typing never fire.
  React.useEffect(() => {
    const isTyping = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    };
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e)) return;
      if (anySurfaceOpen()) return; // TASK-53: any open surface is modal (ESC only)
      if (e.key === '1') {
        setWeapon('laser');
        weaponRef.current = 'laser';
      } else if (e.key === '2') {
        setWeapon('missile');
        weaponRef.current = 'missile';
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  React.useEffect(() => {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      if (anySurfaceOpen()) return; // TASK-53: any open surface is modal (ESC only)
      if (!selfShipRef.current) return; // on foot / before the first self ship
      // Aim assist: the nearest other ship within the active weapon's max
      // engagement (800 u covers both weapons; the server re-checks range).
      const self = selfPosRef.current;
      let targetId: string | undefined;
      if (self) {
        let bestD = Infinity;
        for (const t of remoteShipsRef.current) {
          const d = Math.hypot(t.pos.x - self.x, t.pos.y - self.y, t.pos.z - self.z);
          if (d < bestD) {
            bestD = d;
            targetId = t.id;
          }
        }
        if (bestD > 800) targetId = undefined;
      }
      clientRef.current?.send('fire', {
        weapon: weaponRef.current,
        ...(targetId ? { targetId } : {}),
      });
    };
    canvas.addEventListener('mousedown', onDown);
    return () => canvas.removeEventListener('mousedown', onDown);
  }, []);

  // TASK-32/73: key capture — the SHARED pressed set both prediction loops
  // read (the ship loop maps it through the active control scheme; the
  // on-foot loop maps WASD + Shift run + Space jump). Typing in an input
  // (chat) never moves anything; blur drops everything (a stale "held"
  // key would walk the character / fly the ship).
  React.useEffect(() => {
    const isTyping = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    };
    const keyOf = (e: KeyboardEvent): string => (e.key === 'Shift' ? 'Shift' : e.key.toLowerCase());
    const onDown = (e: KeyboardEvent): void => {
      if (isTyping(e)) return;
      if (anySurfaceOpen()) return; // TASK-53: game input suppressed while a surface is open
      pressedRef.current.add(keyOf(e));
    };
    const onUp = (e: KeyboardEvent): void => {
      if (isTyping(e)) return;
      pressedRef.current.delete(keyOf(e));
    };
    const onBlur = (): void => {
      pressedRef.current.clear();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // TASK-32: the on-foot prediction loop — one rAF per frame, active only
  // while disembarked (the predictor exists). Maps the pressed keys to the
  // surface input frame (sent on change or at 20 Hz so the server's held
  // frame + acks stay current), steps the shared-model predictor, and drives
  // the character model every frame (position + facing + livery).
  React.useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = charPredictorRef.current;
      const world = worldRef.current;
      if (!p || !world) return;
      const pressed = pressedRef.current;
      const thrust = (pressed.has('w') ? 1 : 0) - (pressed.has('s') ? 1 : 0);
      // TASK-55: the sensitivity scales the LOOK demand (read LIVE off the
      // store each frame — the next input frame picks up a slider change).
      const yaw =
        ((pressed.has('d') ? 1 : 0) - (pressed.has('a') ? 1 : 0)) * settingsState().sensitivity;
      const run = pressed.has('Shift');
      const jump = pressed.has(' ');
      const action = run && jump ? 'run+jump' : run ? 'run' : jump ? 'jump' : undefined;
      const key = `${thrust}|${yaw}|${action ?? ''}`;
      // TASK-73: the SHARED seq counter + cadence (the ship loop stamps
      // the same counter — one monotonic seq per connection).
      const seq = inputSender.shouldSend(now, key);
      if (seq !== null) {
        const payload: InputPayload = {
          seq,
          thrust,
          turn: 0,
          pitch: 0,
          yaw,
          fire: false,
          lock: false,
          ...(action ? { action } : {}),
        };
        clientRef.current?.send('input', payload);
        p.step(dt, now, { seq, input: inputToCharacterInput(payload) });
      } else {
        p.step(dt, now);
      }
      const st = p.getState();
      world.setCharacterTransform(st.pos, st.quat, charLiveryRef.current);
      // TASK-33: the per-frame interaction raycast — cheap by construction
      // (the target list is the sparse seed entities, never the scene
      // graph), anchored at the character's feet + facing. The state
      // machine emits on change only, so React re-renders only on a real
      // show / hide / switch of the bottom-center prompt.
      const raw = resolveInteract(
        interactTargetsRef.current,
        st.pos,
        st.quat,
        { callsign: sessionCallsignRef.current },
        interactRegistry,
      );
      // TASK-73: debounce — a short null streak (the predicted-state
      // flicker at the 3 m / 30° boundary) must not clear the dispatch
      // target while the prompt is up: the last hit (target, distance,
      // prompt, dev hook) stays alive for at most INTERACT_HOLD_FRAMES
      // consecutive null frames. Any hit — including a switch to a
      // different target — re-arms immediately.
      if (raw) {
        interactNullStreakRef.current = 0;
        resolvedTargetRef.current = raw.target;
        resolvedDistanceRef.current = raw.distance;
        // TASK-73: dev hook — the exact raycast state the E key dispatches.
        if (interactDebug) {
          interactDebug.text = raw.text;
          interactDebug.targetId = raw.target.id;
          interactDebug.distance = raw.distance;
          interactDebug.feet = { ...st.pos };
        }
        const next = nextPromptState(promptStateRef.current, raw);
        if (next !== promptStateRef.current) {
          promptStateRef.current = next;
          setInteractPrompt(next.kind === 'visible' ? next.text : null);
        }
      } else if (++interactNullStreakRef.current < INTERACT_HOLD_FRAMES) {
        // flicker frame — the last target + prompt stay alive (E still
        // dispatches them); the streak hides everything past the hold.
      } else {
        interactNullStreakRef.current = 0;
        resolvedTargetRef.current = null;
        resolvedDistanceRef.current = undefined;
        if (interactDebug) {
          interactDebug.text = null;
          interactDebug.targetId = null;
          interactDebug.distance = null;
          interactDebug.feet = null;
        }
        const next = nextPromptState(promptStateRef.current, null);
        if (next !== promptStateRef.current) {
          promptStateRef.current = next;
          setInteractPrompt(null);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [interactRegistry]);

  // TASK-73: the SHIP prediction loop — one rAF per frame, active only
  // while the self entity is the player's ship (the predictor exists; the
  // on-foot / snapshot / destroyed paths clear it). Reads the SHARED
  // pressed set through the ACTIVE control scheme (the RegimeWiring's
  // remapper follows the regime tracker: WASD+QE flight, Space VTOL in
  // atmosphere, surface = zero), stamps the SHARED monotonic seq (20 Hz /
  // on-change cadence), steps the ClientShipPredictor (the SAME shared
  // integrateShip as the server), and drives the self ship mesh + chase
  // camera at RENDER rate from the prediction — the 10 Hz snapshots
  // reconcile it (seeded/reconciled in the self-entity bridge).
  // DOCKED: the server freezes the ship and its FIRST input takes it off,
  // so NO idle frames go out while the docked indicator is up (a held zero
  // frame would launch the ship) and the predictor holds its seeded pose
  // (atmosphere gravity would sink it off the pad); only a real control
  // demand is sent — the next snapshot reconciles onto the undock.
  React.useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = shipPredictorRef.current;
      const world = worldRef.current;
      if (!p || !world) return;
      const docked = dockedIndicator();
      const pressed = effectiveFlightPressed(pressedRef.current, {
        chartOpen: chartOpenRef.current,
      });
      // TASK-55: sensitivity scales the flight LOOK channels (yaw/pitch/
      // roll) — read LIVE off the store each frame (next input frame),
      // thrust / VTOL untouched.
      const input = scaleLookDemand(
        regimeWiring.remapper.readInput(pressed),
        settingsState().sensitivity,
      );
      const nonzero =
        input.thrust !== 0 ||
        input.yaw !== 0 ||
        input.pitch !== 0 ||
        input.roll !== 0 ||
        input.up !== 0;
      const seq = !docked || nonzero ? inputSender.shouldSend(now, shipInputKey(input)) : null;
      if (seq !== null) {
        clientRef.current?.send('input', shipInputToPayload(seq, input));
        p.step(dt, now, { seq, input });
      } else if (!docked) {
        p.step(dt, now);
      }
      // The mesh + chase camera track the prediction at render rate
      // (smooth 60 fps, not the 10 Hz snapshot feed).
      const st = p.getState();
      world.setSelfShipTransform(st.pos, st.quat);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [regimeWiring]);

  // TASK-8: the warp controller. The chart dispatches 'warp-started' on the
  // shared bus; the controller runs the state machine (warp-in → awaiting →
  // warp-out), sends the WS 'warp' frame, and toasts on failure. The world
  // swap itself rides the warp_arrived snapshot (useGameSession → swapWorld).
  React.useEffect(() => {
    if (!session) return;
    const controller = new WarpController({
      requestWarp: (toSystemId) =>
        clientRef.current
          ? clientRef.current.warpTo(toSystemId)
          : Promise.reject(new Error('warp: no active session')),
      onArrived: () => {},
      onFailed: (reason) => store.notify(reason),
    });
    const off = warpSubscribe((e) => {
      if (e.type === 'warp-started') controller.start(e.fromSystemId, e.toSystemId, e.etaSeconds);
    });
    return () => {
      off();
      controller.abort();
    };
  }, [session, store]);

  // TASK-59: detect the device profile at boot (BEFORE the first world
  // load resolves the effective key). A manual override in Settings wins
  // over the detection; 'auto' (the default) means "use this result".
  React.useEffect(() => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    setDetectedProfile(
      detectProfile({
        maxTouchPoints: nav.maxTouchPoints,
        deviceMemory: nav.deviceMemory,
        hardwareConcurrency: nav.hardwareConcurrency,
      }),
    );
  }, []);

  // TASK-59: a USER change of the device profile (the Settings row) takes
  // effect at the NEXT world load — the pipeline re-init is not live for
  // mobile-tier cuts, so the app fires the toast + re-runs the warp
  // transition around a re-load of the SAME system (warp-in → swapWorld →
  // warp-out). A boot-restore of a stored profile never triggers this
  // (the user-change bus only fires from the settings panel path).
  React.useEffect(() => {
    if (!systemId) return;
    const off = deviceProfileChangeSubscribe(() => {
      const world = worldRef.current;
      if (!world) return;
      const system = systemForId(serverSeed, systemId);
      if (!system) return;
      store.notify('Profile applied — re-entering system');
      setWarpPhase('warping-in');
      window.setTimeout(() => {
        // The profile applies at world load (radii live, caps + labels via
        // the bridge) — then the world (re)builds with the new row.
        const key = effectiveProfileKey();
        setLodRadii(PERF_PROFILES[key].lodRadii);
        applyPerfProfile(key);
        worldRef.current?.swapWorld(system);
        setWarpPhase('warp-out');
        window.setTimeout(() => setWarpPhase('idle'), WARP_OUT_MS);
      }, WARP_IN_MS);
    });
    return off;
  }, [systemId, serverSeed, store]);

  React.useEffect(() => {
    void fetchHealth().then((h) => {
      setHealth(h);
      // TASK-71: feed the dev-only __DRIFT__ hook the server-provided seed.
      if (h) {
        reportServerSeed(h.galaxySeed);
        setServerSeed(h.galaxySeed);
      }
    });
  }, []);

  // TASK-40: seed the credits counter from the player's own record on session
  // boot (GET /api/players/me — the only endpoint that exposes a balance, and
  // only the caller's own). Every subsequent sale overwrites it in place via
  // the 'sell' result frame; a boot fetch failure just keeps the counter
  // hidden until the first sale lands.
  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/players/me', {
          headers: { authorization: `Bearer ${session.token}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as { credits?: number };
        if (body.credits !== undefined && !cancelled) setCredits(body.credits);
      } catch {
        // server unreachable — the counter stays hidden until a sale lands
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // TASK-55: restore the player's persisted settings on session boot (GET
  // /api/players/settings). A never-saved player gets the factory defaults
  // (the server normalizes the empty row). applySettings re-tunes the
  // pipeline LIVE (the LOD radii for a restored Low preset update without
  // a reload — same path as a click in the settings panel). A boot fetch
  // failure just keeps the local (default) settings.
  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/players/settings', {
          headers: { authorization: `Bearer ${session.token}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as Partial<Settings>;
        if (!cancelled) applySettings(normalizeSettings(body));
      } catch {
        // server unreachable — keep the local (default) settings
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // TASK-53: the shared panel's actions — the panels never talk to the
  // server themselves (the one-dispatch-site pattern of the cargo panel):
  // onMove/onSell send the WS frames, onRepair / onLivery POST the REST
  // endpoints (the panel's only network-touching controls), and the
  // transient repair error renders under the Repair tab.
  const sendCargoTransfer = (
    resourceId: ResourceId,
    amount: number,
    from: 'inv' | 'hold',
  ): void => {
    clientRef.current?.send('cargo_transfer', { resourceId, amount, from });
  };
  const doLivery = (colors: Livery): void => {
    if (!session) return;
    void fetch('/api/ships/livery', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ colors }),
    }).catch(() => {
      /* the ship keeps its current paint; the picker draft stays */
    });
  };
  const doRepair = (): void => {
    if (!session) return;
    setRepairMessage(null);
    fetch('/api/ships/repair', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
          balance?: number;
        } | null;
        if (body?.balance !== undefined) setCredits(body.balance);
        if (res.ok) return;
        if (body?.code === 'not-docked') setRepairMessage('Repair requires a docked ship.');
        else setRepairMessage(body?.message ?? 'Repair failed.');
      })
      .catch(() => setRepairMessage('Repair failed — server unreachable.'));
  };

  // TASK-70: the three.js starfield owns #game-canvas (mounted outside
  // React on purpose) until the player has a system, when the WorldManager
  // (TASK-8) takes over the same canvas for the in-system view.
  const worldRef = React.useRef<WorldManager | null>(null);
  const worldSeedRef = React.useRef<string | null>(null);
  const starfieldRef = React.useRef<ReturnType<typeof createStarfield> | null>(null);
  React.useEffect(() => {
    if (!systemId) return;
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return;
    if (!worldRef.current || worldSeedRef.current !== serverSeed) {
      // First in-system view (or a seed correction): hand the canvas over.
      starfieldRef.current?.dispose();
      starfieldRef.current = null;
      worldRef.current?.dispose(); // also removes its #remote-labels overlay
      worldRef.current = new WorldManager(canvas, serverSeed);
      worldSeedRef.current = serverSeed;
      // TASK-37: dev-only ore-rock probe hook (reads the live manager lazily
      // — a seed-corrected re-creation stays bound through the ref).
      bindDepositsDebug(depositsDebug, () => worldRef.current?.oreRocks());
      // TASK-36: the callsign-label overlay — a canvas-sibling element (same
      // box, pointer-transparent) so the labels track the viewport exactly.
      const labelsHost = document.createElement('div');
      labelsHost.id = 'remote-labels';
      labelsHost.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
      canvas.parentElement?.insertBefore(labelsHost, canvas.nextSibling);
      worldRef.current.attachRemoteLabels(labelsHost);
      // TASK-72: dev-only self-ship probe — the getter reads the live
      // manager lazily (a seed-corrected re-creation stays bound through
      // the ref), so the projection tracks the chase camera at read time.
      bindSelfShipDebug(selfShipDebug, () => {
        const world = worldRef.current;
        const v = world?.selfShipView() ?? null;
        if (!world || !v) return null;
        return {
          classId: v.classId,
          pos: v.pos,
          rot: v.rot,
          screen: world.projectToScreen(v.pos),
        };
      });
      // TASK-74: the remote-ship probes project LAZILY against the live
      // camera (same pattern — a seed-corrected re-creation stays bound).
      bindRemoteShipsDebug(remoteShipsDebug, () => {
        const world = worldRef.current;
        if (!world) return [];
        return world.remoteShips().map((s) => ({
          id: s.id,
          kind: s.kind as 'ship' | 'ai-ship',
          classId: s.classId,
          callsign: s.callsign,
          pos: s.pos,
          screen: world.projectToScreen(s.pos),
        }));
      });
      // TASK-48.3: the hazard discs + drone meshes read lazily (the frame
      // loop flips visibility every frame, so a cached value would lie).
      bindHazardWorldDebug(hazardWorldDebug, () => {
        const world = worldRef.current;
        if (!world) return { systemId: null, discs: [], drones: [] };
        return {
          systemId: world.currentSystemId,
          discs: world.hazardDiscsView(),
          drones: world.drones(),
        };
      });
    }
    // The world is the pure function (seed, systemId) — boot join and warp
    // arrival (warp_arrived snapshot) take the same swapWorld path.
    // TASK-59: the profile applies at EVERY world load (the effective key's
    // radii live, its FX caps + label cap via the bridge) — so a boot with
    // a stored 'mobile' row (or a warp arrival while mobile) loads the
    // mobile pipeline.
    const key = effectiveProfileKey();
    setLodRadii(PERF_PROFILES[key].lodRadii);
    applyPerfProfile(key);
    const system = systemForId(serverSeed, systemId);
    if (system) {
      const ms = worldRef.current.swapWorld(system);
      reportWorldSwap(systemId, ms);
    }
  }, [systemId, serverSeed]);
  React.useEffect(() => {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const handle = createStarfield(canvas, STARFIELD_SEED);
    starfieldRef.current = handle;
    return () => {
      starfieldRef.current = null;
      handle.dispose();
    };
  }, []);
  React.useEffect(
    () => () => {
      worldRef.current?.dispose();
      worldRef.current = null;
      worldSeedRef.current = null;
    },
    [],
  );

  return (
    <div style={styles.shell}>
      {/* TASK-54: the 3D view is a screen-reader image with a live label. */}
      <canvas
        id="game-canvas"
        role="img"
        aria-label={systemId ? `3D view: flying in system ${systemId}` : '3D view: galaxy'}
        style={styles.canvas}
      />
      <div style={styles.hud}>
        <h1 style={styles.title}>DRIFT</h1>
        <p style={styles.status}>
          {health?.ok ? `server ok — seed ${health.galaxySeed}` : 'server unreachable'}
          {connState === 'reconnecting' && ' · reconnecting…'}
          {connState === 'lost' && ' · connection lost'}
        </p>
        {systemId && (
          <p id="sys-id" style={styles.sysId}>
            sys {systemId} · {store.occupancy} aboard
          </p>
        )}
        {systemId && (
          <button
            id="systems-button"
            type="button"
            onClick={() => {
              // TASK-53: the chart rides the menu stack (M / ESC / CLOSE
              // button all pop it); this is the same open-or-close call.
              if (topSurface()?.kind === 'chart') closeTopSurface();
              else openChart();
            }}
            style={styles.sysButton}
          >
            SYSTEMS (M)
          </button>
        )}
        {!session &&
          (booting ? (
            <p
              id="session-restoring"
              style={{
                position: 'fixed',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94a3b8',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
                letterSpacing: '0.12em',
                zIndex: 120,
              }}
            >
              RESTORING SESSION…
            </p>
          ) : (
            <ClaimsScreen
              expiredCallsign={expiredCallsign}
              onClaimed={(s) => {
                setError(null);
                setExpiredCallsign(null);
                setSession(s);
              }}
            />
          ))}
        {error && !session && (
          <p
            role="alert"
            style={{
              position: 'fixed',
              bottom: 14,
              left: '50%',
              transform: 'translateX(-50%)',
              color: '#f87171',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              zIndex: 121,
            }}
          >
            {error}
          </p>
        )}
      </div>
      {systemId && (
        <ChatLog store={chatStore} onSend={(text) => clientRef.current?.send('chat', { text })} />
      )}
      {/* TASK-56: the first-launch hint line (bottom-center, above the
          prompt) — self-hides after the finale / X / its 5-minute window. */}
      {systemId && session && <GuidanceHint />}
      <PlayerList store={store} />
      <ToastStack store={store} />
      {/* TASK-54: the ONE aria-live surface — HUD summary + announcements,
          at 1 Hz (never the 10 Hz snapshot cadence). */}
      <LiveRegion />

      {/* TASK-53: the modal backdrop — any open surface (chart 111 /
          panels 112) sits above it; the game UI behind (≤ 85) goes dim. */}
      {anyOpen && (
        <div
          id="surface-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 8, 12, 0.4)',
            zIndex: 110,
          }}
        />
      )}
      {chartOpen && session && systemId && (
        <StarChart token={session.token} currentSystemId={systemId} onClose={closeTopSurface} />
      )}
      {/* TASK-53: the ESC menu (top-level surface; the world keeps moving
          underneath — multiplayer, no pause). */}
      {menuOpen && session && (
        <EscMenu
          callsign={session.callsign}
          credits={balance}
          token={session.token}
          onResume={closeTopSurface}
          onSystems={() => {
            openChart();
          }}
          onShips={() => {
            openPanel({
              id: 'ship-panel',
              title: 'SHIP',
              context: dockedNow ? 'docked' : 'flight',
              activeTab: 'overview',
            });
          }}
        />
      )}
      {/* TASK-53: the SHIPS item's target — the shared panel from the menu
          (hold data needs the 'cargo' frame, so the Cargo tab explains how
          to get it; the on-foot inventory tab works straight away). */}
      {panel?.id === 'ship-panel' && (
        <ShipPanel
          id="ship-panel"
          title="SHIP"
          context={dockedNow ? 'docked' : 'flight'}
          activeTab="overview"
          ship={panelShip ?? EMPTY_PANEL_SHIP}
          docked={dockedNow}
          hold={null}
          inventory={invView ? { stacks: invView.stacks, weightUsed: invView.weightUsed } : null}
          balance={balance}
          onMove={sendCargoTransfer}
          onRepair={doRepair}
          onLivery={doLivery}
          repairMessage={repairMessage}
          onClose={closeTopSurface}
        />
      )}
      <WarpOverlay />
      {/* TASK-49: the 'SHIP LOST' moment (2 s, our ship destroyed). */}
      <ShipLostOverlay />
      <ReentryTint />
      {/* TASK-52: the ONE HUD mode switch — the player's active entity kind
          selects the ship subtree (TASK-51 flight HUD + docked/leave prompts
          + CARGO) or the on-foot subtree (exposure meter + weight bar +
          interaction line with the mining radial) — never both. The mode is
          set at the same event as the camera handoff, so the switch is
          atomic with it. */}
      <HudRoot
        mode={hudMode}
        promptText={interactPrompt}
        viewport={viewport}
        navSample={shipNavSample}
        dockTarget={nearestDockTarget}
        stationName={stationNameFor}
        onCargoOpen={() => clientRef.current?.send('cargo_open', {})}
      />
      {/* TASK-50: the combat HUD (target box, weapon readout, threat ping,
          kill feed) — in-ship regions unmount on foot (selfShip null). */}
      <CombatHud
        viewport={viewport}
        camera={combatCamera}
        classId={selfShip?.classId ?? null}
        energy={selfShip?.energy ?? null}
        weapon={weapon}
        onWeapon={(w) => {
          setWeapon(w);
          weaponRef.current = w;
        }}
        lowEnergy={lowEnergy}
        locked={locked}
      />
      {/* TASK-39/53: the cargo panel (the shared ShipPanel in its CARGO
          mode) — driven by the server's per-connection 'cargo' frame,
          riding the menu stack (ESC pops it). */}
      <CargoPanel
        onMove={sendCargoTransfer}
        onRepair={doRepair}
        onLivery={doLivery}
        repairMessage={repairMessage}
        onClose={closeTopSurface}
        ship={panelShip ?? EMPTY_PANEL_SHIP}
        docked={dockedNow}
        balance={balance}
      />
      {/* TASK-40/53: the station dock panel (the shared ShipPanel in its
          DOCK mode — the SELL tab live) — opened by the server's 'ui-open'
          {ui:'dock'} frame, driven by the 'sell' result frame. */}
      <DockPanel
        onSell={(resourceId, amount, source) =>
          clientRef.current?.send('sell', { resourceId, amount, source })
        }
        onMove={sendCargoTransfer}
        onRepair={doRepair}
        onLivery={doLivery}
        repairMessage={repairMessage}
        onClose={closeTopSurface}
        ship={panelShip ?? EMPTY_PANEL_SHIP}
        docked={dockedNow}
      />
      {/* TASK-40: the HUD credit balance (top-right) + the transient "+N cr"
          float at the terminal (both driven by the credits / credit-float
          stores, seeded by /api/players/me and updated on each 'sell'). */}
      <CreditsCounter />
      <CreditFloatLayer />
      {/* TASK-57: dev-only frame monitor (F3) — never shipped in prod. */}
      {import.meta.env.DEV && <FrameMonitorOverlay />}
      {connState === 'lost' && session && (
        <ConnectionLostOverlay onRetry={() => clientRef.current?.retryNow()} />
      )}
    </div>
  );
}

/**
 * TASK-17: the only full-screen UI in v1 — shown when the connection has
 * been down past the auto-retry patience window (30 s). Auto-retry keeps
 * running in the background (a returning server reconnects without a
 * click); the button just skips the current backoff step. The backdrop is
 * pointer-transparent except the card, so it can never block other UI (e.g.
 * the future ESC menu) or keyboard input.
 */
function ConnectionLostOverlay({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      id="connection-lost-overlay"
      style={overlayStyles.backdrop}
      role="alertdialog"
      aria-label="Connection lost"
    >
      <div style={overlayStyles.card}>
        <h2 style={overlayStyles.title}>CONNECTION LOST</h2>
        <p style={overlayStyles.text}>
          The server is unreachable. Drift is reconnecting automatically…
        </p>
        <button id="reconnect-retry" type="button" style={overlayStyles.button} onClick={onRetry}>
          RETRY NOW
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    position: 'fixed',
    inset: 0,
    background: '#0b0e14',
    color: '#d6deeb',
    fontFamily: 'system-ui, sans-serif',
  },
  canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
  hud: {
    position: 'absolute',
    top: '1rem',
    left: '1rem',
    padding: '1rem 1.5rem',
    border: '1px solid #2a3346',
    borderRadius: 12,
    background: 'rgba(17, 21, 31, 0.85)',
  },
  title: { margin: 0, fontSize: '1.4rem', letterSpacing: '0.08em' },
  status: { margin: '0.5rem 0 0', color: '#8b97ab' },
  sysId: { margin: '0.25rem 0 0', color: '#5b6678', fontSize: '0.75rem' },
  sysButton: {
    marginTop: '0.5rem',
    background: '#1d2739',
    border: '1px solid #2a3346',
    borderRadius: 6,
    color: '#d6deeb',
    padding: '0.35rem 0.7rem',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.7rem',
    letterSpacing: '0.08em',
    cursor: 'pointer',
  },
};

const overlayStyles: Record<string, React.CSSProperties> = {
  // Pointer-transparent backdrop: never blocks clicks or keyboard on the UI
  // underneath (the ESC menu, TASK-53, must stay operable).
  backdrop: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(11, 14, 20, 0.55)',
    pointerEvents: 'none',
    zIndex: 100,
  },
  card: {
    pointerEvents: 'auto',
    padding: '1.5rem 2rem',
    border: '1px solid #2a3346',
    borderRadius: 12,
    background: 'rgba(17, 21, 31, 0.95)',
    textAlign: 'center',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  title: { margin: 0, fontSize: '1.1rem', letterSpacing: '0.12em', color: '#f87171' },
  text: { margin: '0.75rem 0 1rem', color: '#8b97ab', fontSize: '0.85rem' },
  button: {
    background: '#1d2739',
    border: '1px solid #2a3346',
    borderRadius: 6,
    color: '#d6deeb',
    padding: '0.45rem 1rem',
    letterSpacing: '0.08em',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};

// TASK-71: dev-only determinism debug hook (no-op in production builds).
installDriftDebug();
// TASK-32: dev-only self-character probe hook (no-op in production builds).
const charDebug = installCharDebug();
// TASK-48.2: dev-only hazard probe hook (no-op in production builds).
installHazardDebug();
const interactDebug = installInteractDebug();
// TASK-37: dev-only ore-rock probe hook (no-op in production builds).
const depositsDebug = installDepositsDebug();
// TASK-72: dev-only self-ship probe hook (no-op in production builds).
const selfShipDebug = installSelfShipDebug();
// TASK-74: dev-only remote-ship probe hook (no-op in production builds).
const remoteShipsDebug = installRemoteShipsDebug();
// TASK-48.3: dev-only hazard-world probe hook (no-op in production builds).
const hazardWorldDebug = installHazardWorldDebug();
// TASK-26.2: dev-only draw-distance budget benchmark hook (no-op in prod).
installStreamDebug();
// TASK-27: dev-only camera handoff probe hook (no-op in production builds).
installCameraDebug();
// TASK-28.3: dev-only atmosphere dome pixel-probe hook (no-op in prod).
installAtmosphereDebug();
// TASK-30: dev-only transition-cycle benchmark hook (no-op in production builds).
installTransitionDebug();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(<App />);
