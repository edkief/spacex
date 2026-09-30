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
import { installDriftDebug, reportServerSeed } from '@client/drift-debug';
import type { ChatMessage } from '@shared/protocol/schemas';

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
  onError: (msg: string) => void,
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
  const [session, setSession] = React.useState<ClaimedSession | null>(readSession);
  const [error, setError] = React.useState<string | null>(null);
  const [store] = React.useState(() => new PresenceStore());
  const [chatStore] = React.useState(() => new ChatStore());
  const clientRef = React.useRef<ClientSession | null>(null);
  // Re-render on presence events only (join/leave), never on snapshots, so
  // the "N aboard" occupancy below stays live.
  const [, bumpPresence] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => store.subscribe(bumpPresence), [store]);
  const { systemId, connState } = useGameSession(session, store, chatStore, clientRef, (msg) => {
    setError(msg);
    setSession(null); // token may be stale → back to the claim form
    localStorage.removeItem(SESSION_KEY);
  });

  React.useEffect(() => {
    void fetchHealth().then((h) => {
      setHealth(h);
      // TASK-71: feed the dev-only __DRIFT__ hook the server-provided seed.
      if (h) reportServerSeed(h.galaxySeed);
    });
  }, []);

  // TASK-70: the three.js starfield owns #game-canvas (mounted outside
  // React on purpose). Placeholder until TASK-26 streams per-system views.
  React.useEffect(() => {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const handle = createStarfield(canvas, STARFIELD_SEED);
    return () => handle.dispose();
  }, []);

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

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(<App />);
