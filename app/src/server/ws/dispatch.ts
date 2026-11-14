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

const MAX_UNKNOWN_TYPES = 10;

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

  return async function dispatch(conn: Connection, frame: string): Promise<void> {
    conn.lastSeenAt = deps.clock();
    const ctx: HandlerContext = { conn, deps, hub };

    const envelope = decodeEnvelope(frame);
    if (!envelope.ok) {
      conn.sendError(envelope.error.code, envelope.error.message);
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
      conn.sendError(parsed.error.code, parsed.error.message);
      return;
    }

    if (parsed.value.type === 'input') {
      const { seq } = parsed.value.payload;
      if (seq <= conn.lastInputSeq) {
        conn.sendError('invalid-message', 'input seq must increase');
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
