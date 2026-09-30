import {
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  parseMessage,
  type MessageType,
} from '@shared/protocol';
import type { PayloadSchemas, StateSnapshot } from '@shared/protocol/schemas';

/** A validated inbound frame: type + schema-checked payload. */
export interface ClientInbound {
  type: string;
  payload: unknown;
}

/**
 * TASK-17: connection lifecycle as seen by the UI.
 * - 'connecting'    initial connect in flight
 * - 'connected'     joined (initial or after a reconnect resync)
 * - 'reconnecting'  socket dropped, auto-retry with backoff running
 * - 'lost'          disconnected longer than the patience window: the
 *                   'Connection lost' overlay (with Retry button) shows;
 *                   auto-retry keeps running in the background
 * - 'closed'        deliberate close() or initial join never happened
 */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'lost' | 'closed';

/** First auto-retry delay (1 s, TASK-17 step 2). */
export const RETRY_BASE_MS = 1_000;
/**
 * Exponential backoff delay CAP (technical note: capped at 5 s — 1, 2, 4,
 * 5, 5, …). The patience WINDOW before 'lost' is separate (RETRY_GIVE_UP_MS).
 */
export const RETRY_CAP_MS = 5_000;
/**
 * After this long disconnected the state becomes 'lost' (overlay + Retry
 * button). Auto-retry continues; a server that comes back reconnects the
 * player without any user action.
 */
export const RETRY_GIVE_UP_MS = 30_000;

export interface ClientSessionOptions {
  /** Injected for tests; defaults to the environment's native WebSocket. */
  wsFactory?: () => WebSocket;
  /** Every validated frame (including enter_system/presence). */
  onMessage?: (msg: ClientInbound) => void;
  onClose?: (code: number) => void;
  /**
   * TASK-17: every enter_system snapshot — the initial join AND each
   * reconnect resync. `reconnect` distinguishes a resync (reset prediction
   * + remote buffers, rebuild presence, keep UI state if the system is
   * unchanged) from the first join (full boot).
   */
  onSnapshot?: (snapshot: StateSnapshot, reconnect: boolean) => void;
  /** TASK-17: connection lifecycle transitions (drives the HUD + overlay). */
  onState?: (state: ConnectionState) => void;
  /** TASK-17: backoff tuning (tests inject smaller values). */
  retry?: { baseMs?: number; capMs?: number; giveUpMs?: number };
}

export interface ClaimedSession {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
}

/**
 * Browser WS protocol client — hello → auth(token) on open, then
 * join_system resolves with the enter_system snapshot.
 *
 * TASK-17: reconnect and resync. After the first successful join, any
 * unexpected socket close starts an auto-retry loop (1 s exponential
 * backoff capped at 5 s) that re-runs auth + join_system on the SAME
 * system. Each resync delivers a fresh full snapshot (the server ship
 * kept living while we were away) via onSnapshot(snapshot, true); the
 * caller resets its PredictionEngine/RemoteBuffers and rebuilds presence
 * (the prediction rewind path absorbs the gap). After 30 s disconnected
 * the state is 'lost' (UI overlay with Retry → retryNow()); retries keep
 * running in the background.
 */
export class ClientSession {
  private readonly url: string;
  private readonly session: ClaimedSession;
  private readonly options: ClientSessionOptions;

  private ws: WebSocket | null = null;
  private isOpen = false;
  private state: ConnectionState = 'closed';
  private closedByUser = false;
  /** True once the first join succeeded; auto-reconnect needs it. */
  private hadConnected = false;
  /** The system we (re)join; null until the first successful join. */
  private lastSystemId: string | null = null;
  /** On the next socket open, auto-send join_system(lastSystemId). */
  private autoJoin = false;

  private openPromise: Promise<void> | null = null;
  private openResolve: (() => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private joinPromise: Promise<StateSnapshot> | null = null;
  private joinResolve: ((snapshot: StateSnapshot) => void) | null = null;
  private joinReject: ((err: Error) => void) | null = null;

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  /** epoch ms when the current down-stretch began (0 = connected). */
  private downSince = 0;
  private lostReported = false;

  constructor(url: string, session: ClaimedSession, options: ClientSessionOptions = {}) {
    this.url = url;
    this.session = session;
    this.options = options;
  }

  /** Current lifecycle state (HUD indicator, overlay). */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Opens the socket and performs the hello → auth handshake. */
  connect(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.closedByUser = false;
    this.setState('connecting');
    this.openPromise = new Promise((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });
    this.dial();
    return this.openPromise;
  }

  /** Joins a system; resolves with the enter_system snapshot. */
  joinSystem(systemId: string): Promise<StateSnapshot> {
    if (this.joinPromise) return this.joinPromise;
    this.lastSystemId = systemId;
    this.joinPromise = new Promise<StateSnapshot>((resolve, reject) => {
      this.joinResolve = resolve;
      this.joinReject = reject;
      if (!this.ws || !this.isOpen) {
        // Joining requires an open, authed socket (call connect() first).
        this.joinResolve = null;
        this.joinReject = null;
        this.joinPromise = null;
        reject(new Error('joinSystem: socket not open (call connect() first)'));
        return;
      }
      this.ws.send(encodeMessage('join_system', { systemId }));
    });
    return this.joinPromise;
  }

  /** Send a validated outbound frame (no-op while the socket is not open). */
  send<T extends MessageType>(type: T, payload: PayloadSchemas[T]): void {
    if (this.isOpen && this.ws) this.ws.send(encodeMessage(type, payload));
  }

  /**
   * TASK-17: manual retry from the 'Connection lost' overlay. Dials
   * immediately (skipping the current backoff step) and re-arms the
   * patience window.
   */
  retryNow(): void {
    if (this.closedByUser || !this.lastSystemId) return;
    this.lostReported = false;
    this.downSince = Date.now();
    this.cancelRetryTimer();
    this.setState('reconnecting');
    this.autoJoin = true;
    this.dial();
  }

  close(): void {
    this.closedByUser = true;
    this.cancelRetryTimer();
    if (this.openReject) {
      const reject = this.openReject;
      this.openReject = null;
      this.openResolve = null;
      reject(new Error('session closed before connect'));
    }
    try {
      this.ws?.close(1000);
    } catch {
      // already closed
    }
  }

  /** One socket: create, wire handlers, keep everything else as is. */
  private dial(): void {
    const ws = this.options.wsFactory ? this.options.wsFactory() : new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.isOpen = true;
      ws.send(encodeMessage('hello', { v: PROTOCOL_VERSION }));
      ws.send(
        encodeMessage('auth', { token: this.session.token, callsign: this.session.callsign }),
      );
      // Reconnect: re-join the SAME system right after auth (the initial
      // join is still driven by the caller's joinSystem()).
      if (this.autoJoin && this.lastSystemId) {
        ws.send(encodeMessage('join_system', { systemId: this.lastSystemId }));
      }
      if (this.openResolve) {
        const resolve = this.openResolve;
        this.openResolve = null;
        this.openReject = null;
        resolve();
      }
    };
    ws.onmessage = (event: MessageEvent) => this.handleRaw(String(event.data));
    ws.onclose = (event: CloseEvent) => this.handleClose(event.code);
    ws.onerror = () => {
      // Initial connect: surface the failure. During a reconnect the
      // follow-up close drives the retry — nothing else to do here.
      if (this.openReject) {
        const reject = this.openReject;
        this.openReject = null;
        this.openResolve = null;
        reject(new Error(`websocket open failed: ${this.url}`));
      }
    };
  }

  private handleClose(code: number): void {
    this.isOpen = false;
    this.options.onClose?.(code);
    if (this.openReject) {
      const reject = this.openReject;
      this.openReject = null;
      this.openResolve = null;
      reject(new Error(`connection closed (code ${code})`));
    }
    // A close before the join answer fails the pending join (drop = leave).
    if (this.joinReject) {
      const reject = this.joinReject;
      this.joinReject = null;
      this.joinResolve = null;
      this.joinPromise = null;
      reject(new Error(`connection closed (code ${code})`));
    }
    // Auto-reconnect only after the first successful join: an initial join
    // failure is the caller's error path (claim form), not a drop.
    if (!this.lastSystemId) {
      this.setState('closed');
      return;
    }
    this.scheduleRetry();
  }

  /**
   * TASK-17: one retry step — 1 s exponential backoff capped at 5 s. When
   * the down-stretch outgrows the patience window (30 s) the state becomes
   * 'lost' (overlay with Retry) — but retries keep running in the
   * background, so a returning server needs no click.
   */
  private scheduleRetry(): void {
    if (this.closedByUser) return;
    const base = this.options.retry?.baseMs ?? RETRY_BASE_MS;
    const cap = this.options.retry?.capMs ?? RETRY_CAP_MS;
    const giveUpMs = this.options.retry?.giveUpMs ?? RETRY_GIVE_UP_MS;
    const now = Date.now();
    if (this.downSince === 0) this.downSince = now;
    this.retryAttempt += 1;
    if (!this.lostReported && now - this.downSince >= giveUpMs) {
      this.lostReported = true;
      this.setState('lost');
    } else if (this.state !== 'lost') {
      this.setState('reconnecting');
    }
    const delay = Math.min(cap, base * 2 ** (this.retryAttempt - 1));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closedByUser) return;
      this.autoJoin = true;
      this.dial();
    }, delay);
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Resync complete: clear the retry bookkeeping, state → 'connected'. */
  private resetRetryState(): void {
    this.cancelRetryTimer();
    this.retryAttempt = 0;
    this.downSince = 0;
    this.lostReported = false;
  }

  private handleRaw(data: string): void {
    const decoded = decodeMessage(data);
    if (!decoded.ok) return;
    const parsed = parseMessage(decoded.envelope.type, decoded.envelope.payload);
    if (!parsed.ok) return;
    if (parsed.type === 'enter_system') {
      const snapshot = (parsed.payload as { snapshot: StateSnapshot }).snapshot;
      // Distinguish first join (boot) from a reconnect resync (TASK-17):
      // the resync snapshot is the full state including OUR ship at its
      // idle position — the caller resets prediction/remote buffers and
      // rebuilds presence from it (prediction rewind absorbs the gap).
      const isReconnect = this.hadConnected;
      this.hadConnected = true;
      this.lastSystemId = snapshot.systemId;
      this.autoJoin = false;
      this.resetRetryState();
      this.setState('connected');
      if (this.joinResolve) {
        const resolve = this.joinResolve;
        this.joinResolve = null;
        this.joinReject = null;
        this.joinPromise = null;
        resolve(snapshot);
      }
      this.options.onSnapshot?.(snapshot, isReconnect);
    } else if (parsed.type === 'error' && (this.joinReject || this.autoJoin)) {
      const reject = this.joinReject;
      this.joinReject = null;
      this.joinResolve = null;
      this.joinPromise = null;
      const { code, message } = parsed.payload as { code: string; message: string };
      if (this.autoJoin) {
        // Reconnect join failed (e.g. system-full): drop the socket so the
        // close path retries with backoff.
        this.autoJoin = false;
        this.ws?.close();
      } else if (reject) {
        reject(new Error(`join_system failed (${code}): ${message}`));
      }
    }
    this.options.onMessage?.({ type: parsed.type, payload: parsed.payload });
  }

  private setState(next: ConnectionState): void {
    if (next === this.state) return;
    this.state = next;
    this.options.onState?.(next);
  }
}
