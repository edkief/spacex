import React from 'react';
import { createRoot } from 'react-dom/client';
import { HealthPayload } from '@shared/health';
import { ClientSession, type ClaimedSession, type ConnectionState } from '@client/net/session';
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
  pushKillEvent,
} from '@client/state/kill-feed';
import { showShipLost } from '@client/state/ship-lost';
import { ChatLog } from '@client/hud/chat-log';
import { createStarfield } from '@client/render/starfield';
import { WorldManager } from '@client/world/WorldManager';
import type { SelfShipInput } from '@client/world/self-ship';
import { StarChart } from '@client/ui/star-chart';
import { WarpOverlay } from '@client/ui/warp-overlay';
import { ShipLostOverlay } from '@client/ui/ship-lost-overlay';
import { ReentryTint } from '@client/ui/reentry-tint';
import { DockedIndicator } from '@client/ui/docked-indicator';
import { LeaveShipPrompt } from '@client/ui/leave-ship-prompt';
import { InteractPrompt } from '@client/ui/interact-prompt';
import { WeightBar } from '@client/ui/weight-bar';
import { HazardHud } from '@client/ui/hazard-hud';
import { clearHazard, setHazardFrame, type HazardFrame } from '@client/state/hazards';
import { CargoPanel } from '@client/ui/cargo-panel';
import { openCargoPanel } from '@client/state/cargo';
import { DockPanel } from '@client/ui/dock-panel';
import { CreditsCounter, CreditFloatLayer } from '@client/ui/credits-hud';
import {
  openDockPanel,
  applySellResult,
  type DockHoldView,
  type DockInventoryView,
} from '@client/state/dock';
import { setCredits } from '@client/state/credits';
import { pushCreditFloat } from '@client/state/credit-float';
import { MiningHud } from '@client/ui/mining-hud';
import { inventory, setInventory } from '@client/state/inventory';
import {
  setMiningActive,
  setMiningEnded,
  type MiningActiveFrame,
  type MiningEndedFrame,
} from '@client/state/mining';
import { RESOURCE_IDS } from '@shared/inventory';
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
import { dockedIndicator, isDocked, setDockedIndicator } from '@client/state/docked';
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
import type { ChatMessage, EntityState, InputPayload } from '@shared/protocol/schemas';
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

const SESSION_KEY = 'drift.session.v1';

function readSession(): ClaimedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<ClaimedSession>;
    if (
      typeof s.token === 'string' &&
      typeof s.playerId === 'string' &&
      typeof s.callsign === 'string' &&
      typeof s.homeSystemId === 'string'
    ) {
      return s as ClaimedSession;
    }
  } catch {
    // corrupt entry — fall through to the claim form
  }
  return null;
}

function saveSession(s: ClaimedSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
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
          const entities = (msg.payload as { entities: EntityState[] }).entities;
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
          // regime is 'docked' with a padId set (HUD stub; full HUD TASK-51).
          if (self) setDockedIndicator(isDocked(self.regime, self.padId));
          // TASK-34: weight bar — the server's self entity carries the
          // inventory (updates within one snapshot of any pickup/drop).
          setInventory(self?.inventory ?? null);
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
        // TASK-34: a warp must never carry a stale weight bar either.
        setInventory(null);
        // TASK-48.2: a warp must never carry a stale hazard state either
        // (the exposure pool is per-player, non-persistent, on-foot only).
        clearHazard();
        // TASK-33: a system snapshot rebuilds the interaction target list
        // from ground truth (and resets any stale prompt state).
        onSnapshotEntities?.(snapshot.entities);
        // TASK-31: a system snapshot is the ground truth for the player's
        // ACTIVE entity — on foot (character present, e.g. reconnect after a
        // disembark) the capsule stays; otherwise clear any stale on-foot
        // state (warp arrival, boot).
        const charSelf = snapshot.entities.find(
          (e) => e.kind === 'character' && e.callsign === session.callsign,
        );
        onSelfEntity?.(
          charSelf ??
            snapshot.entities.find(
              (e) => e.kind !== 'character' && e.callsign === session.callsign,
            ) ??
            null,
          snapshot.entities.find((e) => e.kind === 'ship' && e.callsign === session.callsign) ??
            null,
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

/** Minimal callsign claim form; on success the session boots automatically. */
function ClaimForm({
  onClaimed,
  error,
}: {
  onClaimed: (s: ClaimedSession) => void;
  error: string | null;
}) {
  const [callsign, setCallsign] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [fail, setFail] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFail(null);
    try {
      const res = await fetch('/api/callsigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callsign }),
      });
      const body = (await res.json()) as Partial<ClaimedSession> & { code?: string };
      if (!res.ok || !body.token || !body.playerId || !body.homeSystemId) {
        setFail(`claim failed: ${body.code ?? res.status}`);
        return;
      }
      const session = body as ClaimedSession;
      saveSession(session);
      onClaimed(session);
    } catch {
      setFail('claim failed: server unreachable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={claimStyles.card}>
      <label style={claimStyles.label} htmlFor="callsign-input">
        CALLSIGN
      </label>
      <input
        id="callsign-input"
        style={claimStyles.input}
        value={callsign}
        onChange={(e) => setCallsign(e.target.value)}
        placeholder="3-16 alphanumerics"
        maxLength={16}
        autoComplete="off"
        spellCheck={false}
      />
      <button id="join-button" type="submit" style={claimStyles.button} disabled={busy}>
        {busy ? 'JOINING…' : 'JOIN THE DRIFT'}
      </button>
      {(fail || error) && (
        <p style={claimStyles.error} role="alert">
          {fail ?? error}
        </p>
      )}
    </form>
  );
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
  const [session, setSession] = React.useState<ClaimedSession | null>(readSession);
  const [error, setError] = React.useState<string | null>(null);
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
  // TASK-39: the ship-HUD 'Cargo' button (stub until the full HUD, TASK-51)
  // renders exactly while the self entity IS the ship (in flight or docked
  // in the cockpit) — on foot the prompt path (Open cargo) takes over.
  const [inShip, setInShip] = React.useState(false);
  // TASK-43: the weapon HUD state — the active weapon (1/2 keys, client
  // state), the SELF ship's classId + energy (10 Hz entity_update), and the
  // two transient server denial prompts (error frames {code}).
  const [weapon, setWeapon] = React.useState<WeaponId>('laser');
  const [selfShip, setSelfShip] = React.useState<{ classId: string; energy: number | null } | null>(
    null,
  );
  const [lowEnergy, setLowEnergy] = React.useState(false);
  const [locked, setLocked] = React.useState(false);
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
      setSession(null); // token may be stale → back to the claim form
      localStorage.removeItem(SESSION_KEY);
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
        onFootRef.current = true; // TASK-73: Q-drop gate (on foot only)
        // TASK-73: disembark drops the ship predictor (the shared seq
        // counter survives — re-entry re-seeds the predictor, not the seq).
        shipPredictorRef.current = null;
        store.setSelfOnFoot(true); // TASK-36: PlayerList icon (self row)
        setInShip(false); // TASK-39: the HUD Cargo button is in-ship only
        selfShipRef.current = false; // TASK-43: on foot = no weapons (v1)
        setSelfShip(null); // TASK-43: hide the weapon HUD on foot
        world.setCharacterPos(self.pos);
        charPosRef.current = { ...self.pos }; // TASK-48.3: drone-hit FX anchor
        // TASK-72: the ship stays rendered while on foot — it sits docked
        // (frozen, but still in every batch) and is the object the character
        // walks back to. Update the mesh from the ship entity every batch.
        world.setSelfShip(ship ? selfShipStateFrom(ship) : null);
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
        setInShip(self?.kind === 'ship'); // TASK-39: ship-HUD Cargo button
        // TASK-43: the weapon HUD tracks the SELF ship (classId for the
        // loadout, energy for the bar) + the fire handlers' ship refs.
        if (self && self.kind === 'ship') {
          selfShipRef.current = true;
          selfPosRef.current = { ...self.pos };
          setSelfShip({ classId: self.classId, energy: self.energy ?? null });
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

  // TASK-7: the star chart (M key or the Systems button); typing in an
  // input (chat) never toggles it.
  const [chartOpen, setChartOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'm' || e.key === 'M') setChartOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  React.useEffect(() => {
    if (!systemId) setChartOpen(false); // no system → nothing to chart
  }, [systemId]);

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
      if (chartOpenRef.current) return;
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
      if (chartOpenRef.current) return;
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
      if (chartOpenRef.current) return;
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
      const yaw = (pressed.has('d') ? 1 : 0) - (pressed.has('a') ? 1 : 0);
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
      const input = regimeWiring.remapper.readInput(pressed);
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
        return { classId: v.classId, pos: v.pos, rot: v.rot, screen: world.projectToScreen(v.pos) };
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
      <canvas id="game-canvas" style={styles.canvas} />
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
            onClick={() => setChartOpen((v) => !v)}
            style={styles.sysButton}
          >
            SYSTEMS (M)
          </button>
        )}
        {!session && (
          <ClaimForm
            onClaimed={(s) => {
              setError(null);
              setSession(s);
            }}
            error={error}
          />
        )}
      </div>
      {systemId && (
        <ChatLog store={chatStore} onSend={(text) => clientRef.current?.send('chat', { text })} />
      )}
      <PlayerList store={store} />
      <ToastStack store={store} />

      {chartOpen && session && systemId && (
        <StarChart
          token={session.token}
          currentSystemId={systemId}
          onClose={() => setChartOpen(false)}
        />
      )}
      <WarpOverlay />
      {/* TASK-49: the 'SHIP LOST' moment (2 s, our ship destroyed). */}
      <ShipLostOverlay />
      <ReentryTint />
      <DockedIndicator />
      <LeaveShipPrompt />
      <InteractPrompt text={interactPrompt} />
      <WeightBar />
      {/* TASK-48.2: the hazard HUD (radiation meter + 'SHIELD BURN' /
          'RECOVERING' prompts) — driven by the server's 'hazard' frame. */}
      <HazardHud />
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
      {/* TASK-39: the ship-HUD 'Cargo' button (stub until the full HUD,
          TASK-51) — in-ship (in flight or docked) it opens the cargo panel
          with the hold ONLY ('cargo_open' — no inventory side in flight). */}
      {inShip && (
        <button
          id="ship-hud-cargo"
          type="button"
          onClick={() => clientRef.current?.send('cargo_open', {})}
          style={{
            position: 'fixed',
            bottom: '2rem',
            right: '6.5rem', // left of the weight bar (right 2rem, 120 px)
            zIndex: 85,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.08em',
            color: '#9fb0c3',
            background: 'rgba(15, 20, 28, 0.8)',
            border: '1px solid #2c3a4d',
            borderRadius: '4px',
            padding: '0.35rem 0.6rem',
            cursor: 'pointer',
          }}
        >
          CARGO
        </button>
      )}
      {/* TASK-39: the cargo panel (INVENTORY | CARGO HOLD, Move buttons) —
          driven by the server's per-connection 'cargo' frame. */}
      <CargoPanel
        onMove={(resourceId, amount, from) =>
          clientRef.current?.send('cargo_transfer', { resourceId, amount, from })
        }
      />
      {/* TASK-40: the station dock panel (SELL tab live; SHIPS/REPAIR are
          TASK-53 stubs) — opened by the server's 'ui-open' {ui:'dock'} frame,
          driven by the 'sell' result frame. The panel sends the 'sell' frame. */}
      <DockPanel
        onSell={(resourceId, amount, source) =>
          clientRef.current?.send('sell', { resourceId, amount, source })
        }
      />
      {/* TASK-40: the HUD credit balance (top-right) + the transient "+N cr"
          float at the terminal (both driven by the credits / credit-float
          stores, seeded by /api/players/me and updated on each 'sell'). */}
      <CreditsCounter />
      <CreditFloatLayer />
      {/* TASK-38: the hold-to-mine channel HUD (radial progress, ore
          counter, 'Backpack full' / 'Depleted') — server-timed. */}
      <MiningHud />
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

const claimStyles: Record<string, React.CSSProperties> = {
  card: { marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  label: {
    fontSize: '0.7rem',
    letterSpacing: '0.12em',
    color: '#8b97ab',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  input: {
    background: '#0b0e14',
    border: '1px solid #2a3346',
    borderRadius: 6,
    color: '#d6deeb',
    padding: '0.4rem 0.6rem',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  button: {
    background: '#1d2739',
    border: '1px solid #2a3346',
    borderRadius: 6,
    color: '#d6deeb',
    padding: '0.4rem 0.6rem',
    letterSpacing: '0.08em',
    cursor: 'pointer',
  },
  error: { margin: 0, color: '#f87171', fontSize: '0.8rem' },
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
