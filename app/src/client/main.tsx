import React from 'react';
import { createRoot } from 'react-dom/client';
import { HealthPayload } from '@shared/health';
import { ClientSession, type ClaimedSession, type ConnectionState } from '@client/net/session';
import { PresenceStore } from '@client/net/presence';
import { ChatStore } from '@client/net/chat';
import { PlayerList } from '@client/hud/player-list';
import { ToastStack } from '@client/hud/toast-stack';
import { ChatLog } from '@client/hud/chat-log';
import { createStarfield } from '@client/render/starfield';
import { WorldManager } from '@client/world/WorldManager';
import { StarChart } from '@client/ui/star-chart';
import { WarpOverlay } from '@client/ui/warp-overlay';
import { ReentryTint } from '@client/ui/reentry-tint';
import { DockedIndicator } from '@client/ui/docked-indicator';
import { LeaveShipPrompt } from '@client/ui/leave-ship-prompt';
import { InteractPrompt } from '@client/ui/interact-prompt';
import { WeightBar } from '@client/ui/weight-bar';
import { inventory, setInventory } from '@client/state/inventory';
import { RESOURCE_IDS } from '@shared/inventory';
import {
  createInteractableRegistry,
  interactableTargetsFrom,
  nextPromptState,
  resolveInteract,
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
import { RegimeWiring } from '@client/state/regime-wiring';
import { CharacterPredictor, characterStateFromWire } from '@client/net/character-prediction';
import { installCharDebug } from '@client/char-debug';
import type { ChatMessage, EntityState, InputPayload } from '@shared/protocol/schemas';
import { inputToCharacterInput } from '@shared/protocol/inputs';
import type { Regime } from '@shared/regime';
import type { Vec3 } from '@shared/physics/vec';

/**
 * TASK-70: the starfield seed. Matches the server's default GALAXY_SEED so
 * every client boots on the same sky; per-system stars arrive with the
 * streaming pipeline (TASK-26).
 */
const STARFIELD_SEED = 'DRIFT-SEED-0001';

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
  // the player's ship entity id (the exit_ship payload). Null when the
  // snapshot batch carries no own entity.
  onSelfEntity?: (self: EntityState | null, shipId: string | null) => void,
  // TASK-32: the last input seq the server APPLIED (10 Hz 'ack' frames) —
  // the character predictor reconciles against it.
  onAck?: (seq: number) => void,
  // TASK-33: every entity_update batch → the interaction raycast's target
  // list (deposits / ships / terminals only — sparse by construction).
  onWorldEntities?: (entities: EntityState[]) => void,
  // TASK-33: a system snapshot (boot / warp / resync) → the target list is
  // rebuilt from GROUND TRUTH (and the prompt never carries stale state).
  onSnapshotEntities?: (entities: EntityState[]) => void,
) {
  const systemParam = React.useMemo(
    () => new URLSearchParams(window.location.search).get('sys'),
    [],
  );
  const [systemId, setSystemId] = React.useState<string | null>(null);
  const [connState, setConnState] = React.useState<ConnectionState>('connecting');
  const systemIdRef = React.useRef<string | null>(null);
  // TASK-25.2: the regime manager — one tracker (local prediction + server
  // authority from self entity_updates) + one controls remapper (the active
  // key scheme). Consumers (flight input, camera) land in TASK-27/31.
  const regimeWiring = React.useMemo(() => new RegimeWiring(), []);

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
          // TASK-33: the server wants a panel open (the dock-terminal
          // interaction answers with {ui:'dock'}). The dock UI that consumes
          // it lands in TASK-40/53 — until then the client just logs it.
          console.debug('[ui-open]', msg.payload);
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
          onSelfEntity?.(self ?? null, shipSelf?.id ?? null);
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
          snapshot.entities.find((e) => e.kind === 'ship' && e.callsign === session.callsign)?.id ??
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

  return { systemId, connState };
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
  const [store] = React.useState(() => new PresenceStore());
  const [chatStore] = React.useState(() => new ChatStore());
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
  const charPressedRef = React.useRef<Set<string>>(new Set());
  const charSeqRef = React.useRef(0);
  const charLastKeyRef = React.useRef('');
  const charLastSendMsRef = React.useRef(0);
  const charPredictorRef = React.useRef<CharacterPredictor | null>(null);
  const charAckedSeqRef = React.useRef(0);
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
  const [interactPrompt, setInteractPrompt] = React.useState<string | null>(null);
  // Re-render on presence events only (join/leave), never on snapshots, so
  // the "N aboard" occupancy below stays live.
  const [, bumpPresence] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => store.subscribe(bumpPresence), [store]);
  const { systemId, connState } = useGameSession(
    session,
    store,
    chatStore,
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
    // TASK-31: the self-entity bridge — on foot: the capsule follows the
    // character (first call spawns it + runs the camera handoff); back in
    // the ship: clear any stale on-foot state.
    (self, shipId) => {
      selfShipIdRef.current = shipId;
      const world = worldRef.current;
      if (!world) return;
      if (self && self.kind === 'character' && self.onFoot) {
        world.setCharacterPos(self.pos);
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
          charAckedSeqRef.current,
          performance.now(),
        );
        if (charDebug) {
          charDebug.pos = { ...self.pos };
          charDebug.rot = self.rot ? { ...self.rot } : undefined;
        }
      } else {
        world.clearCharacter();
        charPredictorRef.current = null;
        // TASK-33: no character → no interaction (the prompt never outlives
        // the on-foot state, e.g. after re-entering the ship).
        resolvedTargetRef.current = null;
        promptStateRef.current = { kind: 'hidden' };
        setInteractPrompt(null);
      }
    },
    // TASK-32: input acks — the predictor reconciles on the next self
    // entity_update against this seq.
    (seq) => {
      charAckedSeqRef.current = seq;
      if (charDebug) charDebug.acked = seq;
    },
    // TASK-33: entity_update batches → the raycast's target list (a pickup
    // by ANY player leaves the list within one snapshot → the prompt hides).
    (entities) => {
      interactTargetsRef.current = interactableTargetsFrom(entities);
    },
    // TASK-33: a system snapshot rebuilds the list from ground truth and
    // clears any stale prompt (boot / warp / resync never carry one).
    (entities) => {
      interactTargetsRef.current = interactableTargetsFrom(entities);
      promptStateRef.current = { kind: 'hidden' };
      setInteractPrompt(null);
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
      // TASK-33: on foot with a prompt up → dispatch the hit target. The
      // registry is the ONLY place an 'interact' frame goes out (AC).
      const target = resolvedTargetRef.current;
      if (!target) return;
      interactRegistry.dispatch(target, (type, payload) => clientRef.current?.send(type, payload));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      const inv = inventory();
      if (!inv) return;
      const resourceId = RESOURCE_IDS.find((id) => (inv.stacks[id] ?? 0) > 0);
      if (!resourceId) return;
      clientRef.current?.send('drop', { resourceId, amount: 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // TASK-32: on-foot key capture — the pressed set the prediction loop
  // maps to input frames (WASD + Shift run + Space jump). Typing in an
  // input (chat) never moves the character; blur drops everything (a
  // stale "held" key would walk the character into the ground).
  React.useEffect(() => {
    const isTyping = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    };
    const keyOf = (e: KeyboardEvent): string => (e.key === 'Shift' ? 'Shift' : e.key.toLowerCase());
    const onDown = (e: KeyboardEvent): void => {
      if (isTyping(e)) return;
      charPressedRef.current.add(keyOf(e));
    };
    const onUp = (e: KeyboardEvent): void => {
      if (isTyping(e)) return;
      charPressedRef.current.delete(keyOf(e));
    };
    const onBlur = (): void => {
      charPressedRef.current.clear();
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
      const pressed = charPressedRef.current;
      const thrust = (pressed.has('w') ? 1 : 0) - (pressed.has('s') ? 1 : 0);
      const yaw = (pressed.has('d') ? 1 : 0) - (pressed.has('a') ? 1 : 0);
      const run = pressed.has('Shift');
      const jump = pressed.has(' ');
      const action = run && jump ? 'run+jump' : run ? 'run' : jump ? 'jump' : undefined;
      const key = `${thrust}|${yaw}|${action ?? ''}`;
      if (key !== charLastKeyRef.current || now - charLastSendMsRef.current >= 50) {
        charSeqRef.current += 1;
        const payload: InputPayload = {
          seq: charSeqRef.current,
          thrust,
          turn: 0,
          pitch: 0,
          yaw,
          fire: false,
          lock: false,
          ...(action ? { action } : {}),
        };
        clientRef.current?.send('input', payload);
        charLastKeyRef.current = key;
        charLastSendMsRef.current = now;
        p.step(dt, now, { seq: payload.seq, input: inputToCharacterInput(payload) });
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
      const resolved = resolveInteract(
        interactTargetsRef.current,
        st.pos,
        st.quat,
        { callsign: sessionCallsignRef.current },
        interactRegistry,
      );
      resolvedTargetRef.current = resolved?.target ?? null;
      const next = nextPromptState(promptStateRef.current, resolved);
      if (next !== promptStateRef.current) {
        promptStateRef.current = next;
        setInteractPrompt(next.kind === 'visible' ? next.text : null);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [interactRegistry]);

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
      worldRef.current?.dispose();
      worldRef.current = new WorldManager(canvas, serverSeed);
      worldSeedRef.current = serverSeed;
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
      <ReentryTint />
      <DockedIndicator />
      <LeaveShipPrompt />
      <InteractPrompt text={interactPrompt} />
      <WeightBar />
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
// TASK-26.2: dev-only draw-distance budget benchmark hook (no-op in prod).
installStreamDebug();
// TASK-27: dev-only camera handoff probe hook (no-op in production builds).
installCameraDebug();
// TASK-28.3: dev-only atmosphere dome pixel-probe hook (no-op in prod).
installAtmosphereDebug();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(<App />);
