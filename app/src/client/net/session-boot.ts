/**
 * TASK-56: session storage + restore (the boot flow).
 *
 * The token is stored in localStorage (`drift.token`) alongside the full
 * session object (`drift.session.v1`, kept because the e2e suite seeds it
 * and it carries the callsign for the expired-claims message). On boot the
 * app resolves the stored token against `GET /api/session`: 200 → straight
 * into the game (home system); 401/expired/network → silently back to the
 * claims screen (the old callsign shown disabled — v1 has no recovery).
 */

import type { ClaimedSession } from './session';

/** The stored-token key (TASK-56). */
export const TOKEN_KEY = 'drift.token';
/** The full session object key (pre-TASK-56 contract, still written on claim). */
export const SESSION_KEY = 'drift.session.v1';

/** The token, from `drift.token` or the full session object. Null when absent/corrupt. */
export function readStoredToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return t;
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { token?: unknown };
    return typeof s.token === 'string' ? s.token : null;
  } catch {
    return null;
  }
}

/** The stored callsign (null when absent) — for the expired-claims message. */
export function readStoredCallsign(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { callsign?: unknown };
    return typeof s.callsign === 'string' ? s.callsign : null;
  } catch {
    return null;
  }
}

/** Persist a fresh claim (full object + the bare token). */
export function saveSession(s: ClaimedSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  localStorage.setItem(TOKEN_KEY, s.token);
}

/** Drop both keys (expired/revoked token, logout). */
export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

/** The /api/session profile the boot flow resolves. */
export interface SessionProfile {
  callsign: string;
  credits: number;
  playerId: string;
  homeSystemId: string;
  /** v1: always null (the client joins the home system). */
  lastSystemId: string | null;
  shipId: string;
}

export type RestoreResult = { ok: true; session: ClaimedSession } | { ok: false };

/**
 * Resolve a stored token against `GET /api/session`. ANY failure (401, 5xx,
 * network, malformed body) is `{ok: false}` — the caller falls back to the
 * claims screen without an error wall.
 */
export async function restoreSession(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RestoreResult> {
  try {
    const res = await fetchImpl('/api/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as Partial<SessionProfile>;
    if (
      typeof body.callsign !== 'string' ||
      typeof body.playerId !== 'string' ||
      typeof body.homeSystemId !== 'string'
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      session: {
        token,
        playerId: body.playerId,
        callsign: body.callsign,
        homeSystemId: body.homeSystemId,
      },
    };
  } catch {
    return { ok: false };
  }
}
