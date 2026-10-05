// @vitest-environment happy-dom
/**
 * TASK-56: the boot flow — stored-token resolution.
 *
 * A stored token (drift.token, or the legacy drift.session.v1 object)
 * resolves against GET /api/session: 200 → a ClaimedSession (straight into
 * the game); 401/expired/network/malformed → {ok:false} (silently back to
 * the claims screen, the old callsign recoverable for the expired message).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_KEY,
  TOKEN_KEY,
  clearStoredSession,
  readStoredCallsign,
  readStoredToken,
  restoreSession,
  saveSession,
} from './session-boot';

const SESSION = {
  token: 'tok-123',
  playerId: 'p1',
  callsign: 'test-pilot',
  homeSystemId: 'abcd1234abcd1234',
};

function okProfile(overrides: Record<string, unknown> = {}) {
  return {
    callsign: SESSION.callsign,
    credits: 500,
    playerId: SESSION.playerId,
    homeSystemId: SESSION.homeSystemId,
    lastSystemId: null,
    shipId: 'ship-1',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('token storage', () => {
  it('saveSession writes both keys; clearStoredSession drops both', () => {
    saveSession(SESSION);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-123');
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)!)).toEqual(SESSION);
    clearStoredSession();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('readStoredToken falls back to the legacy full-session object', () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    expect(readStoredToken()).toBe('tok-123');
    expect(readStoredCallsign()).toBe('test-pilot');
  });

  it('corrupt entries read as null (never throw)', () => {
    localStorage.setItem(TOKEN_KEY, 'not-json-but-a-token-string');
    expect(readStoredToken()).toBe('not-json-but-a-token-string');
    localStorage.setItem(SESSION_KEY, '{{{');
    // The bare token key wins; the corrupt object is ignored.
    expect(readStoredToken()).toBe('not-json-but-a-token-string');
    localStorage.setItem(TOKEN_KEY, null as unknown as string);
    localStorage.removeItem(TOKEN_KEY);
    expect(readStoredToken()).toBeNull();
    expect(readStoredCallsign()).toBeNull();
  });
});

describe('restoreSession (token → GET /api/session)', () => {
  it('200 → the ClaimedSession the boot flow joins with', async () => {
    const fetchImpl = vi.fn(async () => Response.json(okProfile())) as unknown as typeof fetch;
    const res = await restoreSession('tok-123', fetchImpl);
    expect(res).toEqual({
      ok: true,
      session: {
        token: 'tok-123',
        playerId: 'p1',
        callsign: 'test-pilot',
        homeSystemId: 'abcd1234abcd1234',
      },
    });
    // The bearer token rides the Authorization header.
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it.each([401, 404, 500])('%i → {ok:false} (no error wall)', async (status) => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ code: 'unauthenticated', reason: 'expired-token' }, { status }),
    ) as unknown as typeof fetch;
    await expect(restoreSession('dead-token', fetchImpl)).resolves.toEqual({ ok: false });
  });

  it('network failure → {ok:false}', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(restoreSession('tok', fetchImpl)).resolves.toEqual({ ok: false });
  });

  it('a malformed 200 body (missing playerId) → {ok:false}', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ callsign: 'x', homeSystemId: 'y' }),
    ) as unknown as typeof fetch;
    await expect(restoreSession('tok', fetchImpl)).resolves.toEqual({ ok: false });
  });

  it('the v1 profile carries lastSystemId: null (home-system join)', async () => {
    const fetchImpl = vi.fn(async () => Response.json(okProfile())) as unknown as typeof fetch;
    const res = await restoreSession('tok', fetchImpl);
    if (!res.ok) throw new Error('expected ok');
    expect(res.session.homeSystemId).toBe('abcd1234abcd1234');
  });
});
