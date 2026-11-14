import type { IncomingMessage } from 'node:http';
import type { ErrorCode } from '@shared/protocol/errors.ts';
import type { ServerConfig } from '../config.ts';

export type UpgradeVerdict =
  { ok: true } | { ok: false; status: 400 | 403; code: ErrorCode; message: string };

/**
 * Decides whether a WebSocket upgrade request may proceed:
 * - no query string at all (tokens must never travel in a URL);
 * - the Origin must be same-origin, i.e. its host:port equals the request's Host (or the first
 *   X-Forwarded-Host when TRUST_PROXY is on). The Vite dev proxy keeps Host and Origin as the
 *   browser sent them, so this holds in dev without any special case;
 * - a missing Origin (non-browser clients, tests) is allowed only outside production.
 */
export function checkUpgrade(request: IncomingMessage, config: ServerConfig): UpgradeVerdict {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.search !== '') {
    return {
      ok: false,
      status: 400,
      code: 'invalid-request',
      message: 'query strings are not allowed',
    };
  }

  const origin = request.headers.origin;
  if (origin === undefined) {
    return config.isProduction
      ? { ok: false, status: 403, code: 'forbidden-origin', message: 'origin required' }
      : { ok: true };
  }

  const forwarded = request.headers['x-forwarded-host'];
  const hostHeader = config.trustProxy
    ? ((Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ??
      request.headers.host)
    : request.headers.host;
  let originHost: string | undefined;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    originHost = undefined;
  }
  if (originHost && hostHeader && originHost === hostHeader.toLowerCase()) return { ok: true };
  return {
    ok: false,
    status: 403,
    code: 'forbidden-origin',
    message: 'cross-origin WebSocket refused',
  };
}
