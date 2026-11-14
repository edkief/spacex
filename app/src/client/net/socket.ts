import {
  PROTOCOL_VERSION,
  decodeEnvelope,
  encodeMessage,
  parseServerMessage,
} from '@shared/protocol/envelope.ts';
import type {
  ClientPayload,
  ClientType,
  ServerMessage,
  ServerPayload,
} from '@shared/protocol/registry.ts';

export type SocketStatus = 'connecting' | 'handshaking' | 'online' | 'closed' | 'error';

/** The slice of a browser WebSocket this module uses; tests supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface GameSocketOptions {
  url: string;
  token: string;
  systemId: string;
  /** Called for every valid server message after the handshake messages were handled. */
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: SocketStatus, detail?: string) => void;
  createSocket?: (url: string) => SocketLike;
}

/**
 * The game connection: opens the socket and walks the handshake (hello -> welcome -> auth ->
 * auth_ok -> join_system -> enter_system), validating every server message against the shared
 * registry. After `enter_system` it is `online` and forwards messages to `onMessage`.
 */
export class GameSocket {
  status: SocketStatus = 'connecting';
  /** Tick and snapshot rates announced by the server in `welcome`. */
  rates: ServerPayload<'welcome'> | undefined;
  private readonly socket: SocketLike;
  private readonly options: GameSocketOptions;

  constructor(options: GameSocketOptions) {
    this.options = options;
    const create = options.createSocket ?? ((url: string) => new WebSocket(url) as SocketLike);
    this.socket = create(options.url);
    this.socket.onopen = () => {
      this.setStatus('handshaking');
      this.send('hello', { v: PROTOCOL_VERSION });
    };
    this.socket.onmessage = (event) => this.receive(event.data);
    this.socket.onerror = () => this.setStatus('error', 'socket error');
    this.socket.onclose = (event) => this.setStatus('closed', `closed (${event.code})`);
  }

  private setStatus(status: SocketStatus, detail?: string): void {
    if (this.status === 'closed') return;
    this.status = status;
    this.options.onStatus(status, detail);
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    const envelope = decodeEnvelope(data);
    if (!envelope.ok) return;
    const parsed = parseServerMessage(envelope.value.type, envelope.value.payload);
    if (!parsed.ok) return;
    const message = parsed.value;
    switch (message.type) {
      case 'welcome':
        this.rates = message.payload;
        this.send('auth', { token: this.options.token });
        return;
      case 'auth_ok':
        this.send('join_system', { systemId: this.options.systemId });
        return;
      case 'ping':
        this.send('pong', { t: message.payload.t });
        return;
      case 'enter_system':
        this.setStatus('online');
        break;
      case 'error':
        if (this.status !== 'online') this.setStatus('error', message.payload.code);
        break;
      default:
        break;
    }
    this.options.onMessage(message);
  }

  /** Sends a client message; silently dropped unless the socket is usable. */
  send<K extends ClientType>(type: K, payload: ClientPayload<K>): void {
    if (this.status === 'closed' || this.status === 'connecting') return;
    this.socket.send(encodeMessage(type, payload));
  }

  close(): void {
    this.socket.close();
  }
}

/** The same-origin WebSocket URL for a path (ws/wss following the page protocol). */
export function socketUrl(path: string, location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}
