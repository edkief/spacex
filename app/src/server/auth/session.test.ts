import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createTokenCodec, TOKEN_SKEW_TOLERANCE_MS } from '@server/auth/token';
import { createSessionService, SESSION_TTL_MS } from '@server/auth/session';
import type { Repository, SessionInput } from '@server/db/repo';
import type { PlayerRow, SessionRow } from '@server/db/schema';

/**
 * Service-level verification table (TASK-66): every case goes through the
 * same verify() the REST and WS paths use (createSessionService), backed by
 * an in-memory fake repo and a fake clock.
 */

const SECRET = 'session-service-secret';

function fakeClock(startMs: number) {
  let now = startMs;
  return { get: () => now, set: (ms: number) => (now = ms), advance: (ms: number) => (now += ms) };
}

function fakeRepo(player: PlayerRow) {
  const rows = new Map<string, SessionRow>();
  const repo = {
    async createSession(input: SessionInput): Promise<SessionRow> {
      const row: SessionRow = {
        tokenHash: input.tokenHash,
        playerId: input.playerId,
        systemId: input.systemId ?? null,
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
      };
      rows.set(row.tokenHash, row);
      return row;
    },
    async findSession(tokenHash: string) {
      return rows.get(tokenHash);
    },
    async setSessionSystem(tokenHash: string, systemId: string | null) {
      const row = rows.get(tokenHash);
      if (row) row.systemId = systemId;
    },
    async deleteSession(tokenHash: string) {
      rows.delete(tokenHash);
    },
    async deleteExpiredSessions() {
      return 0;
    },
    async getPlayersByIds(ids: string[]) {
      return ids.includes(player.id) ? [player] : [];
    },
  };
  return { repo: repo as unknown as Repository, rows };
}

const PLAYER: PlayerRow = {
  id: '00000000-0000-4000-8000-000000000066',
  callsign: 'table-66',
  credits: 500,
  homeSystemId: 'a'.repeat(16),
  createdAt: '2026-01-01T00:00:00.000Z',
};

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);

function setup() {
  const clock = fakeClock(T0);
  const { repo, rows } = fakeRepo(PLAYER);
  const codec = createTokenCodec(SECRET, { now: clock.get });
  const sessions = createSessionService({ repo, codec, now: clock.get });
  return { clock, rows, codec, sessions };
}

/** Flip one character of a valid token at a given index. */
function mutateAt(token: string, index: number, ch: string): string {
  return token.slice(0, index) + ch + token.slice(index + 1);
}

describe('session service verify table (TASK-66)', () => {
  it('accepts a freshly issued token', async () => {
    const { sessions } = setup();
    const token = await sessions.issue(PLAYER.id);
    const result = await sessions.verify(token);
    expect(result).toEqual({ ok: true, player: PLAYER });
  });

  it('rejects every single-character mutation of an issued token', async () => {
    const { sessions } = setup();
    const token = await sessions.issue(PLAYER.id);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let mutated = 0;
    for (let i = 0; i < token.length; i++) {
      for (const ch of alphabet) {
        if (ch === token[i]) continue;
        const forged = mutateAt(token, i, ch);
        const result = await sessions.verify(forged);
        expect(result.ok, `mutation at ${i} (${token[i]} → ${ch}) was accepted`).toBe(false);
        mutated += 1;
      }
    }
    expect(mutated).toBeGreaterThan(100);
  });

  it('rejects every proper truncation of an issued token', async () => {
    const { sessions } = setup();
    const token = await sessions.issue(PLAYER.id);
    for (let len = 1; len < token.length; len++) {
      const result = await sessions.verify(token.slice(0, len));
      expect(result.ok, `prefix of length ${len} was accepted`).toBe(false);
    }
  });

  it('expiry table: past exp rejected, 30 s skew accepted, far future accepted', async () => {
    const { clock, sessions } = setup();
    // issue() stamps exp = now + TTL on both the token and the row, so the
    // table is exercised by moving the shared clock against a fresh issue.
    async function issueAt(offsetMs: number): Promise<string> {
      clock.set(T0 + offsetMs);
      return sessions.issue(PLAYER.id);
    }
    const expectResult = async (
      token: string,
      offsetMs: number,
      expected: 'ok' | 'expired-token',
    ) => {
      clock.set(T0 + offsetMs);
      const result = await sessions.verify(token);
      if (expected === 'ok') {
        expect(result.ok, `offset ${offsetMs} ms should be accepted`).toBe(true);
      } else {
        expect(result, `offset ${offsetMs} ms should be expired`).toEqual({
          ok: false,
          reason: 'expired-token',
        });
      }
    };

    const fresh = await issueAt(0);
    await expectResult(fresh, 0, 'ok'); // fresh
    await expectResult(fresh, SESSION_TTL_MS - 29_000, 'ok'); // 29 s before expiry
    await expectResult(fresh, SESSION_TTL_MS + 29_000, 'ok'); // 29 s into the skew window
    await expectResult(fresh, SESSION_TTL_MS + TOKEN_SKEW_TOLERANCE_MS, 'ok'); // exact boundary
    await expectResult(fresh, SESSION_TTL_MS + TOKEN_SKEW_TOLERANCE_MS + 1_000, 'expired-token');
    await expectResult(fresh, 10 * 365 * 24 * 3600 * 1000, 'expired-token'); // far past

    // A token whose exp is already in the past is rejected outright: issued
    // 8 days ago (TTL 7 d) → exp is a full day behind the current clock.
    const stale = await issueAt(-8 * 24 * 3600 * 1000);
    clock.set(T0);
    expect(await sessions.verify(stale)).toEqual({ ok: false, reason: 'expired-token' });
  });

  it('rejects a well-signed token that was never issued (unknown session)', async () => {
    const { clock, codec, sessions } = setup();
    const token = codec.sign({
      playerId: PLAYER.id,
      exp: Math.floor(clock.get() / 1000) + 3600,
    });
    expect(await sessions.verify(token)).toEqual({ ok: false, reason: 'unknown-session' });
  });

  it('rejects garbage inputs with structured reasons, never throws', async () => {
    const { sessions } = setup();
    for (const garbage of ['', '.', 'a.', '.a', '!!!.###', 'not base64 at all']) {
      const result = await sessions.verify(garbage);
      expect(result.ok, `garbage ${JSON.stringify(garbage)} was accepted`).toBe(false);
    }
  });
});

describe('session revocation + shared account model (TASK-66)', () => {
  it('revoke deletes the sessions row; a second use of the token is rejected', async () => {
    const { rows, sessions } = setup();
    const token = await sessions.issue(PLAYER.id);
    expect((await sessions.verify(token)).ok).toBe(true);

    expect(await sessions.revoke(token)).toBe(true);
    expect(rows.size).toBe(0);
    expect(await sessions.verify(token)).toEqual({ ok: false, reason: 'unknown-session' });
    // Revoking again is idempotent.
    expect(await sessions.revoke(token)).toBe(false);
  });

  it('revoke reports false for tokens that were never issued', async () => {
    const { clock, codec, sessions } = setup();
    const token = codec.sign({ playerId: PLAYER.id, exp: Math.floor(clock.get() / 1000) + 3600 });
    expect(await sessions.revoke(token)).toBe(false);
  });

  it('shared account model: the same token backs concurrent uses until revoked', async () => {
    const { sessions } = setup();
    const token = await sessions.issue(PLAYER.id);
    // Two "connections" verify the same token back-to-back — no single-use
    // semantics: both work while the sessions row exists.
    const [first, second] = await Promise.all([sessions.verify(token), sessions.verify(token)]);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.player.id).toBe(second.player.id);
    }
    // Revocation (logout) kills the token for everyone.
    await sessions.revoke(token);
    expect(await sessions.verify(token)).toEqual({ ok: false, reason: 'unknown-session' });
  });

  it('issue stores only the sha256 hash, never the raw token', async () => {
    const { rows, sessions } = setup();
    const token = await sessions.issue(PLAYER.id);
    const expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
    expect([...rows.keys()]).toEqual([expectedHash]);
    // The raw token is not a key anywhere in the store.
    expect(rows.has(token)).toBe(false);
  });
});
