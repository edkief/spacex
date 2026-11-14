import { PROTOCOL_VERSION, decodeEnvelope, parseClientMessage } from '@shared/protocol/envelope.ts';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import { isClientType, type ClientPayload, type ClientType } from '@shared/protocol/registry.ts';
import type { Connection } from './connection.ts';
import type { HandlerContext, WsDeps } from './context.ts';
import type { Hub } from './hub.ts';
import { admit } from './state.ts';

/** A handler only ever receives a payload already validated against its message's schema. */
export type Handler<K extends ClientType> = (
  ctx: HandlerContext,
  payload: ClientPayload<K>,
) => void | Promise<void>;

/** Handlers by message type; types without one answer `not-implemented`. */
export type HandlerMap = { [K in ClientType]?: Handler<K> };

export const MAX_UNKNOWN_TYPES = 10;
export const MAX_INVALID_MESSAGES = 50;

/**
 * Builds THE dispatch function: the only path from socket text to a handler. It decodes the
 * envelope, checks the protocol version, the message type, the connection state and the payload
 * schema, in that order, and only then calls the handler with the parsed payload.
 */
export function createDispatcher(handlers: HandlerMap, deps: WsDeps, hub: Hub) {
  /** Calls the handler registered for `type`; the cast is sound because both come from `type`. */
  async function invoke<K extends ClientType>(
    type: K,
    ctx: HandlerContext,
    payload: ClientPayload<K>,
  ): Promise<void> {
    const handler = handlers[type];
    if (!handler) {
      ctx.conn.sendError('not-implemented', `${type} is not implemented yet`);
      return;
    }
    await handler(ctx, payload);
  }

  /**
   * Rejects a message as invalid: structured error to the client (never echoing the payload), a
   * debug log of issue paths only, and a drop once the connection has sent too many.
   */
  function rejectInvalid(conn: Connection, type: string, message: string, issues: string[] = []) {
    conn.sendError('invalid-message', message);
    deps.log.debug({ conn: conn.id, type, issues }, 'invalid message rejected');
    if (conn.recordInvalid(MAX_INVALID_MESSAGES)) {
      conn.close(CLOSE_CODES.tooManyInvalid, 'too-many-invalid-messages');
    }
  }

  return async function dispatch(conn: Connection, frame: string): Promise<void> {
    conn.lastSeenAt = deps.clock();
    const ctx: HandlerContext = { conn, deps, hub };

    const envelope = decodeEnvelope(frame);
    if (!envelope.ok) {
      rejectInvalid(conn, '<envelope>', envelope.error.message, envelope.issues);
      return;
    }
    const { v, type, payload } = envelope.value;

    if (v !== PROTOCOL_VERSION) {
      conn.sendError('version-mismatch', `server speaks protocol ${PROTOCOL_VERSION}`);
      if (conn.state === 'connected') conn.close(CLOSE_CODES.versionMismatch, 'version-mismatch');
      return;
    }

    if (!isClientType(type)) {
      conn.sendError('unknown-type', 'unknown message type');
      conn.unknownTypes += 1;
      if (conn.unknownTypes >= MAX_UNKNOWN_TYPES) {
        conn.close(CLOSE_CODES.tooManyUnknown, 'too-many-unknown-types');
      }
      return;
    }

    const admission = admit(conn.state, type);
    if (!admission.ok) {
      conn.sendError(admission.code, admission.message);
      return;
    }

    const parsed = parseClientMessage(type, payload);
    if (!parsed.ok) {
      rejectInvalid(conn, type, parsed.error.message, parsed.issues);
      return;
    }

    if (parsed.value.type === 'input') {
      const { seq } = parsed.value.payload;
      if (seq <= conn.lastInputSeq) {
        rejectInvalid(conn, type, 'input seq must increase', ['seq:not-increasing']);
        return;
      }
      conn.lastInputSeq = seq;
    }

    try {
      await invoke(parsed.value.type, ctx, parsed.value.payload as never);
    } catch (error) {
      deps.log.error({ err: error, type }, 'message handler failed');
      conn.sendError('internal', 'internal error');
    }
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;

/** Counts and answers a binary frame (the protocol is JSON text only). */
export function rejectBinary(conn: Connection, deps: WsDeps): void {
  conn.sendError('invalid-message', 'binary frames are not supported');
  deps.log.debug({ conn: conn.id }, 'binary frame rejected');
  if (conn.recordInvalid(MAX_INVALID_MESSAGES)) {
    conn.close(CLOSE_CODES.tooManyInvalid, 'too-many-invalid-messages');
  }
}
