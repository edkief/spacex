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

export interface ClientSessionOptions {
  /** Injected for tests; defaults to the environment's native WebSocket. */
  wsFactory?: () => WebSocket;
  /** Every validated frame (including enter_system/presence). */
  onMessage?: (msg: ClientInbound) => void;
  onClose?: (code: number) => void;
}

export interface ClaimedSession {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
}

/**
 * TASK-15: minimal browser WS protocol client — hello → auth(token) on
 * open, then join_system resolves with the enter_system snapshot. No
 * reconnection / resync here (TASK-17 owns that); the caller feeds the
 * PresenceStore through onMessage.
 */
export class ClientSession {
  private readonly ws: WebSocket;
  private openPromise: Promise<void> | null = null;
  private openResolve: (() => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private joinPromise: Promise<StateSnapshot> | null = null;
  private joinResolve: ((snapshot: StateSnapshot) => void) | null = null;
  private joinReject: ((err: Error) => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly session: ClaimedSession,
    private readonly options: ClientSessionOptions = {},
  ) {
    this.ws = options.wsFactory ? options.wsFactory() : new WebSocket(this.url);
    this.ws.onopen = () => {
      this.ws.send(encodeMessage('hello', { v: PROTOCOL_VERSION }));
      this.ws.send(
        encodeMessage('auth', { token: this.session.token, callsign: this.session.callsign }),
      );
      this.openResolve?.();
      this.openReject = null;
      this.openResolve = null;
    };
    this.ws.onmessage = (event: MessageEvent) => this.handleRaw(String(event.data));
    this.ws.onclose = (event: CloseEvent) => {
      // A close before the join answer fails the pending join (drop = leave).
      this.joinReject?.(new Error(`connection closed (code ${event.code})`));
      this.joinReject = null;
      this.joinResolve = null;
      this.options.onClose?.(event.code);
    };
  }

  /** Opens the socket and performs the hello → auth handshake. */
  connect(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });
    this.ws.onerror = () => {
      this.openReject?.(new Error(`websocket open failed: ${this.url}`));
      this.openReject = null;
    };
    return this.openPromise;
  }

  /** Joins a system; resolves with the enter_system snapshot. */
  joinSystem(systemId: string): Promise<StateSnapshot> {
    if (this.joinPromise) return this.joinPromise;
    this.joinPromise = new Promise<StateSnapshot>((resolve, reject) => {
      this.joinResolve = resolve;
      this.joinReject = reject;
      this.ws.send(encodeMessage('join_system', { systemId }));
    });
    return this.joinPromise;
  }

  /** Send a validated outbound frame (no-op while the socket is not open). */
  send<T extends MessageType>(type: T, payload: PayloadSchemas[T]): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeMessage(type, payload));
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      // already closed
    }
  }

  private handleRaw(data: string): void {
    const decoded = decodeMessage(data);
    if (!decoded.ok) return;
    const parsed = parseMessage(decoded.envelope.type, decoded.envelope.payload);
    if (!parsed.ok) return;
    if (parsed.type === 'enter_system' && this.joinResolve) {
      const resolve = this.joinResolve;
      this.joinResolve = null;
      this.joinReject = null;
      resolve((parsed.payload as { snapshot: StateSnapshot }).snapshot);
    } else if (parsed.type === 'error' && this.joinReject) {
      const reject = this.joinReject;
      const { code, message } = parsed.payload as { code: string; message: string };
      this.joinResolve = null;
      this.joinReject = null;
      reject(new Error(`join_system failed (${code}): ${message}`));
    }
    this.options.onMessage?.({ type: parsed.type, payload: parsed.payload });
  }
}
