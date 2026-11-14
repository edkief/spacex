import { encodeMessage } from '@shared/protocol/envelope.ts';
import { errorBody, type ErrorCode } from '@shared/protocol/errors.ts';
import type { ServerPayload, ServerType } from '@shared/protocol/registry.ts';
import type { AuthenticatedSession } from '../auth/types.ts';
import { reduce, type ConnEvent, type ConnState } from './state.ts';

/** The slice of a WebSocket the connection logic needs; tests supply a fake. */
export interface Socket {
  send(data: string): void;
  close(code: number, reason?: string): void;
  terminate(): void;
}

let nextId = 1;

/**
 * One client connection: its lifecycle state, authenticated identity and counters. Only the
 * dispatcher and the handlers it invokes touch this; handlers receive parsed payloads only.
 */
export class Connection {
  readonly id = nextId++;
  state: ConnState = 'connected';
  session: AuthenticatedSession | undefined;
  systemId: string | undefined;
  lastInputSeq = -1;
  unknownTypes = 0;
  invalidMessages = 0;
  lastSeenAt: number;
  /** Serialises message handling so async handlers never reorder a client's messages. */
  private chain: Promise<void> = Promise.resolve();
  /** Cleanup callbacks (timers, limiter slots) run exactly once on close. */
  private readonly onCloseCallbacks: (() => void)[] = [];
  private closed = false;

  private readonly socket: Socket;
  readonly ip: string;

  constructor(socket: Socket, ip: string, now: number) {
    this.socket = socket;
    this.ip = ip;
    this.lastSeenAt = now;
  }

  /** Applies a lifecycle event; returns false (and changes nothing) if it is not allowed. */
  transition(event: ConnEvent): boolean {
    const next = reduce(this.state, event);
    if (next === undefined) return false;
    this.state = next;
    return true;
  }

  /** Sends a server message (the payload type is checked against the server registry). */
  send<K extends ServerType>(type: K, payload: ServerPayload<K>): void {
    if (this.closed) return;
    this.socket.send(encodeMessage(type, payload));
  }

  /** Sends a structured error message. */
  sendError(code: ErrorCode, message: string): void {
    this.send('error', errorBody(code, message));
  }

  /** Queues work after this connection's previous work finishes. */
  enqueue(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work, work);
    return this.chain;
  }

  /** Registers a cleanup to run when the connection closes. */
  onClose(callback: () => void): void {
    if (this.closed) callback();
    else this.onCloseCallbacks.push(callback);
  }

  /** Closes the socket with an application close code. */
  close(code: number, reason = ''): void {
    this.socket.close(code, reason);
  }

  /** Drops the socket immediately without a closing handshake. */
  terminate(): void {
    this.socket.terminate();
  }

  /**
   * Counts a rejected-as-invalid message; returns true when the limit is reached and the
   * connection should be dropped.
   */
  recordInvalid(limit: number): boolean {
    this.invalidMessages += 1;
    return this.invalidMessages >= limit;
  }

  /** Marks the connection closed and runs cleanups once. Called by the transport on 'close'. */
  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    for (const callback of this.onCloseCallbacks.splice(0)) callback();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
