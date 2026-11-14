import type { IncomingMessage } from 'node:http';

const IP_CHARS = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The client's IP for limits. Behind a trusted reverse proxy (TRUST_PROXY=true) it is the
 * first X-Forwarded-For entry; otherwise the socket's remote address. Malformed forwarded
 * values fall back to the socket address so a client cannot invent an arbitrary key.
 */
export function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  const remote = request.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return remote;
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first && IP_CHARS.test(first) ? first : remote;
}
