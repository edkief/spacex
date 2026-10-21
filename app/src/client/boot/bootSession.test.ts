/**
 * Boot-session state machine unit tests (TASK-56).
 *
 * Covers the four flows:
 *
 *   - fresh boot (no stored token) → `awaiting-claim`,
 *   - stored token + 200 /api/session → `authenticated`,
 *   - stored token + 401 → `session-expired` (token cleared),
 *   - stored token + network error → `awaiting-claim` (token kept),
 *   - successful claim POST → `authenticated` + token persisted,
 *   - claim POST 422 → `claim-failed` with the error message.
 *
 * The fetcher is a stub (no real HTTP), the storage is the in-memory
 * shim — no `window`, no `localStorage`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  BootSession,
  TOKEN_STORAGE_KEY,
  parseSessionProfile,
  readStoredToken,
  type BootState,
} from "./bootSession.js";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  raw(key: string): string | null {
    return this.getItem(key);
  }
}

interface FakeFetchOptions {
  json: unknown;
  status: number;
}
function fakeFetch(opts: FakeFetchOptions): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(opts.json), {
      status: opts.status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseSessionProfile", () => {
  it("accepts a valid profile", () => {
    const profile = parseSessionProfile({
      playerId: "p-1",
      callsign: "Pilot-1",
      homeSystemId: "s-1",
      shipId: "sh-1",
      tokenExpiresAt: 123,
    });
    expect(profile).toEqual({
      playerId: "p-1",
      callsign: "Pilot-1",
      homeSystemId: "s-1",
      shipId: "sh-1",
      tokenExpiresAt: 123,
    });
  });
  it("rejects an invalid profile", () => {
    expect(parseSessionProfile(null)).toBeNull();
    expect(parseSessionProfile({ callsign: "x" })).toBeNull();
  });
});

describe("readStoredToken", () => {
  it("returns the raw stored token", () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "  abc  ");
    expect(readStoredToken(storage)).toBe("abc");
  });
  it("returns null on a missing or empty payload", () => {
    expect(readStoredToken(new MemoryStorage())).toBeNull();
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "");
    expect(readStoredToken(storage)).toBeNull();
  });
  it("returns null when storage is unavailable", () => {
    expect(readStoredToken(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fresh boot (no stored token)
// ---------------------------------------------------------------------------

describe("BootSession — fresh boot", () => {
  it("lands on awaiting-claim when storage has no token", async () => {
    const session = new BootSession({
      storage: new MemoryStorage(),
      fetchImpl: fakeFetch({ status: 200, json: {} }),
      origin: "http://test",
    });
    const stored = await session.runValidationFromStorage();
    expect(stored).toBeNull();
    expect(session.getSnapshot().kind).toBe("awaiting-claim");
  });

  it("runValidationFromStorage() emits a state transition", async () => {
    const listener = vi.fn();
    const session = new BootSession({
      storage: new MemoryStorage(),
      fetchImpl: fakeFetch({ status: 200, json: {} }),
      origin: "http://test",
    });
    session.subscribe(listener);
    await session.runValidationFromStorage();
    expect(listener).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stored-token validation
// ---------------------------------------------------------------------------

describe("BootSession — stored token validation", () => {
  it("returns authenticated on a 200 with a complete profile", async () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "tkn-200");
    const session = new BootSession({
      storage,
      fetchImpl: fakeFetch({
        status: 200,
        json: {
          playerId: "p-1",
          callsign: "Pilot-1",
          homeSystemId: "s-1",
          shipId: "sh-1",
          tokenExpiresAt: 999,
        },
      }),
      origin: "http://test",
    });
    const stored = await session.runValidationFromStorage();
    expect(stored).toBe("tkn-200");
    expect(session.getSnapshot().kind).toBe("authenticated");
    const snap = session.getSnapshot();
    if (snap.kind !== "authenticated") throw new Error("expected authenticated");
    expect(snap.token).toBe("tkn-200");
    expect(snap.profile.callsign).toBe("Pilot-1");
    // The token is preserved across validation — the boot session
    // hands it to the WS handshake downstream.
    expect(storage.raw(TOKEN_STORAGE_KEY)).toBe("tkn-200");
  });

  it("clears the stored token + drops to session-expired on 401", async () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "tkn-401");
    const session = new BootSession({
      storage,
      fetchImpl: fakeFetch({
        status: 401,
        json: { code: "unauthenticated", message: "Token invalid or expired" },
      }),
      origin: "http://test",
    });
    await session.runValidationFromStorage();
    const snap = session.getSnapshot();
    expect(snap.kind).toBe("session-expired");
    if (snap.kind !== "session-expired") throw new Error("expected session-expired");
    expect(snap.expiredCallsign).toBe("");
    // The token is wiped — the player has to re-claim.
    expect(storage.raw(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("keeps the stored token + drops to awaiting-claim on a network error", async () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "tkn-net");
    const session = new BootSession({
      storage,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      origin: "http://test",
    });
    await session.runValidationFromStorage();
    const snap = session.getSnapshot();
    expect(snap.kind).toBe("awaiting-claim");
    // The token is kept — a future reload can retry the validation.
    expect(storage.raw(TOKEN_STORAGE_KEY)).toBe("tkn-net");
  });
});

// ---------------------------------------------------------------------------
// Claim flow
// ---------------------------------------------------------------------------

describe("BootSession — claim POST", () => {
  it("returns authenticated on a 200 + persists the token", async () => {
    const storage = new MemoryStorage();
    const session = new BootSession({
      storage,
      fetchImpl: fakeFetch({
        status: 200,
        json: {
          callsign: "Newbie-1",
          token: "tkn-fresh",
          playerId: "p-2",
          homeSystemId: "s-2",
          shipId: "sh-2",
          tokenExpiresAt: 9999,
        },
      }),
      origin: "http://test",
    });
    const ok = await session.claim("Newbie-1");
    expect(ok).toBe(true);
    const snap = session.getSnapshot();
    expect(snap.kind).toBe("authenticated");
    if (snap.kind !== "authenticated") throw new Error("expected authenticated");
    expect(snap.token).toBe("tkn-fresh");
    expect(snap.profile.callsign).toBe("Newbie-1");
    expect(storage.raw(TOKEN_STORAGE_KEY)).toBe("tkn-fresh");
  });

  it("lands on claim-failed on a 422 with the message", async () => {
    const storage = new MemoryStorage();
    const session = new BootSession({
      storage,
      fetchImpl: fakeFetch({
        status: 422,
        json: { code: "invalid-callsign", message: "too short" },
      }),
      origin: "http://test",
    });
    const ok = await session.claim("ab");
    expect(ok).toBe(false);
    const snap = session.getSnapshot();
    expect(snap.kind).toBe("claim-failed");
    if (snap.kind !== "claim-failed") throw new Error("expected claim-failed");
    expect(snap.callsign).toBe("ab");
    expect(snap.error).toBe("too short");
    // The failed claim did NOT persist a token.
    expect(storage.raw(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("lands on claim-failed on a 409 with the message", async () => {
    const session = new BootSession({
      storage: new MemoryStorage(),
      fetchImpl: fakeFetch({
        status: 409,
        json: { code: "callsign-taken", message: "Callsign already claimed" },
      }),
      origin: "http://test",
    });
    const ok = await session.claim("Already-1");
    expect(ok).toBe(false);
    const snap = session.getSnapshot();
    expect(snap.kind).toBe("claim-failed");
    if (snap.kind !== "claim-failed") throw new Error("expected claim-failed");
    expect(snap.callsign).toBe("Already-1");
    expect(snap.error).toBe("Callsign already claimed");
  });

  it("lands on claim-failed on a thrown network error", async () => {
    const session = new BootSession({
      storage: new MemoryStorage(),
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      origin: "http://test",
    });
    const ok = await session.claim("Offline-1");
    expect(ok).toBe(false);
    const snap = session.getSnapshot();
    expect(snap.kind).toBe("claim-failed");
    if (snap.kind !== "claim-failed") throw new Error("expected claim-failed");
    expect(snap.error).toBe("offline");
  });

  it("sends the POST with the rendered JSON body", async () => {
    const stub = vi.fn(fakeFetch({ status: 200, json: {} }));
    const session = new BootSession({
      storage: new MemoryStorage(),
      fetchImpl: stub as unknown as typeof fetch,
      origin: "http://test",
    });
    void session.claim("Pilot-1");
    expect(stub).toHaveBeenCalledWith(
      "http://test/api/callsigns",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ callsign: "Pilot-1" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle + manual reset
// ---------------------------------------------------------------------------

describe("BootSession — reset + subscribe", () => {
  it("reset() drops to awaiting-claim and clears the stored token", async () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "tkn-stale");
    const session = new BootSession({
      storage,
      fetchImpl: fakeFetch({ status: 200, json: {} }),
      origin: "http://test",
    });
    session.reset();
    expect(session.getSnapshot().kind).toBe("awaiting-claim");
    expect(storage.raw(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("listeners fire on every state transition", async () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "tkn-listen");
    const session = new BootSession({
      storage,
      fetchImpl: fakeFetch({
        status: 200,
        json: {
          playerId: "p-1",
          callsign: "Pilot-1",
          homeSystemId: "s-1",
          shipId: "sh-1",
          tokenExpiresAt: 999,
        },
      }),
      origin: "http://test",
    });
    const listener = vi.fn();
    session.subscribe(listener);
    await session.runValidationFromStorage();
    // validating → authenticated = 2 commits
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("unsubscribe handle detaches the listener", async () => {
    const storage = new MemoryStorage();
    const session = new BootSession({
      storage,
      fetchImpl: fakeFetch({ status: 200, json: {} }),
      origin: "http://test",
    });
    const listener = vi.fn();
    const off = session.subscribe(listener);
    off();
    await session.runValidationFromStorage();
    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// markReady — promotes authenticated → ready once the WS handshake
// has been handed the token.
// ---------------------------------------------------------------------------

describe("BootSession — markReady", () => {
  it("promotes authenticated → ready", async () => {
    const storage = new MemoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "tkn-ready");
    const session = new BootSession({
      storage,
      fetchImpl: fakeFetch({
        status: 200,
        json: {
          playerId: "p-1",
          callsign: "Pilot-1",
          homeSystemId: "s-1",
          shipId: "sh-1",
          tokenExpiresAt: 999,
        },
      }),
      origin: "http://test",
    });
    await session.runValidationFromStorage();
    expect(session.getSnapshot().kind).toBe("authenticated");
    session.markReady();
    expect(session.getSnapshot().kind).toBe("ready");
  });
  it("is a no-op outside of the authenticated state", () => {
    const session = new BootSession({
      storage: new MemoryStorage(),
      fetchImpl: fakeFetch({ status: 200, json: {} }),
      origin: "http://test",
    });
    const before: BootState = session.getSnapshot();
    session.markReady();
    expect(session.getSnapshot()).toBe(before);
  });
});
