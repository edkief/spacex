import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { errorBody, type ErrorCode } from '@shared/protocol/errors.ts';

/** Largest REST request body accepted, in bytes. */
export const REST_BODY_LIMIT = 16 * 1024;

/** Sends the one error shape ({code, message}) used by REST and WebSocket alike. */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  return reply.code(status).send(errorBody(code, message));
}

/**
 * Validates `data` against `schema` with safeParse. On failure it replies 400 `invalid-request`
 * (never echoing the input; issue paths are logged at debug level) and returns undefined.
 */
export function parseOr400<S extends z.ZodType>(
  schema: S,
  data: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): z.infer<S> | undefined {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}:${i.code}`);
  request.log.debug({ issues }, 'invalid request rejected');
  sendError(reply, 400, 'invalid-request', 'invalid request');
  return undefined;
}

/**
 * Installs uniform error handling: malformed bodies, oversize bodies and unsupported media types
 * become 400/413/415 `invalid-request`, unknown /api routes 404 `not-found`, and anything
 * unexpected a generic 500 `internal` (the cause is logged, never returned).
 */
export function installErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      request.log.debug({ status }, 'client error');
      return sendError(reply, status, 'invalid-request', 'invalid request');
    }
    request.log.error({ err: error }, 'request failed');
    return sendError(reply, 500, 'internal', 'internal error');
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return sendError(reply, 404, 'not-found', 'not found');
    return reply.code(404).type('text/plain').send('Not Found');
  });
}
