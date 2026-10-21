/**
 * Boot-session state machine (TASK-56).
 *
 * Wires the first-launch flow together:
 *
 *   1. Read the bearer token from `localStorage` (`drift.token`).
 *   2. If a token exists, GET `/api/session` to validate it. A 200
 *      transitions to `authenticated` and the host can start the WS
 *      handshake with the stored token. A 401 (or a network error)
 *      transitions to `session-expired` / `awaiting-claim` so the
 *      host shows the claims screen (with the expired banner when
 *      the token was rejected rather than simply absent).
 *   3. If no token exists, the machine lands on `awaiting-claim` and
 *      the host renders `<ClaimsScreen>`.
 *   4. While `claiming`, the host's `POST /api/callsigns` is in
 *      flight. A 200 promotes the session to `authenticated` and
 *      persists the token; a 4xx surfaces the message via
 *      `claim-failed`.
 *
 * The machine is deliberately framework-free — a few `useState`s in
 * a component could replicate the flow, but a plain class keeps
 * every transition unit-testable without a browser.
 *
 * @see ./sessionProfile.ts for the storage + payload helpers.
 * @see ./useFirstLaunch.ts for the React host.
 * @see ./*.test.ts for the state-machine cases.
 */
import {
  defaultBootStorage,
  parseSessionProfile,
  readStoredToken,
  TOKEN_STORAGE_KEY,
  type BearerToken,
  type BootStorage,
  type SessionProfile,
} from "./sessionProfile.js";

export type { BearerToken, BootStorage, SessionProfile };
export { parseSessionProfile, readStoredToken, TOKEN_STORAGE_KEY };

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Public boot state.
 *
 *   - `idle`            — constructed but not yet run.
 *   - `validating`      — `GET /api/session` is in flight.
 *   - `authenticated`   — session established; the host should hand
 *                         the token to `DriftClient.startWithSession()`.
 *   - `ready`           — the handshake has been kicked off (the
 *                         client owns reconnect from here).
 *   - `session-expired` — a stored token was rejected; show the
 *                         claims screen with the expired banner.
 *   - `awaiting-claim`  — no token on boot (or a network blip);
 *                         show the claims screen.
 *   - `claiming`        — `POST /api/callsigns` in flight.
 *   - `claim-failed`    — the claim POST returned an error the screen
 *                         should surface.
 */
export type BootState =
  | { kind: "idle" }
  | { kind: "validating"; token: BearerToken }
  | { kind: "authenticated"; profile: SessionProfile; token: BearerToken }
  | { kind: "ready"; profile: SessionProfile; token: BearerToken }
  | { kind: "session-expired"; expiredCallsign: string; token: BearerToken }
  | { kind: "awaiting-claim" }
  | { kind: "claiming"; callsign: string }
  | { kind: "claim-failed"; callsign: string; error: string };

/**
 * Options for {@link BootSession}.
 */
export interface BootSessionOptions {
  /** Storage backend (defaults to `localStorage` when available). */
  storage?: BootStorage | null;
  /** Override the fetch implementation (tests pass a stub). */
  fetchImpl?: typeof fetch;
  /** Override the origin (defaults to `window.location.origin`). */
  origin?: string;
}

/**
 * The boot-session state machine. One instance per app mount.
 */
export class BootSession {
  private state: BootState = { kind: "idle" };
  private readonly listeners = new Set<(state: BootState) => void>();
  private readonly storage: BootStorage | null;
  private readonly fetchImpl: typeof fetch;
  private readonly origin: string;

  constructor(options: BootSessionOptions = {}) {
    this.storage = options.storage === undefined ? defaultBootStorage() : options.storage;
    // Bind the fetcher so callers can pass a bare `fetch` reference;
    // a detached `this` throws `Illegal invocation` in strict mode.
    const defaultFetch: typeof fetch = (() => {
      throw new Error("no fetch implementation");
    }) as unknown as typeof fetch;
    this.fetchImpl =
      options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : defaultFetch);
    this.origin = options.origin ?? (typeof location !== "undefined" ? location.origin : "");
  }

  getSnapshot = (): BootState => this.state;

  subscribe = (listener: (state: BootState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Drop the persisted token and fall back to the claims screen.
   * Used by an explicit sign-out.
   */
  reset(): void {
    this.clearStoredToken();
    this.commit({ kind: "awaiting-claim" });
  }

  /**
   * Validate a token. Returns once the machine has settled on
   * `authenticated` / `session-expired`.
   */
  beginValidation(token: BearerToken): Promise<void> {
    if (this.state.kind === "validating") return Promise.resolve();
    this.commit({ kind: "validating", token });
    return this.runValidate(token);
  }

  /**
   * Validate whatever token is in storage. Resolves to the token
   * that was used (or `null` when there was none), so the caller can
   * thread it into the WS handshake without a second read.
   */
  async runValidationFromStorage(): Promise<string | null> {
    const stored = readStoredToken(this.storage);
    if (stored === null) {
      this.commit({ kind: "awaiting-claim" });
      return null;
    }
    await this.beginValidation(stored);
    return stored;
  }

  /**
   * Issue the claim POST. On 200 the token is persisted and the
   * state becomes `authenticated`; on any other status the machine
   * moves to `claim-failed` with the server's message.
   *
   * @returns `true` when the claim succeeded.
   */
  async claim(callsign: string): Promise<boolean> {
    this.commit({ kind: "claiming", callsign });
    try {
      const res = await this.fetchImpl(`${this.origin}/api/callsigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callsign }),
      });
      if (res.status !== 200) {
        this.commit({
          kind: "claim-failed",
          callsign,
          error: await readErrorMessage(res, `claim failed (${res.status})`),
        });
        return false;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const token = typeof json.token === "string" ? json.token : null;
      const profile = parseSessionProfile(json);
      if (token === null || profile === null) {
        this.commit({
          kind: "claim-failed",
          callsign,
          error: "claim returned an unparseable profile",
        });
        return false;
      }
      if (this.storage !== null) {
        try {
          this.storage.setItem(TOKEN_STORAGE_KEY, token);
        } catch {
          // Storage may be unavailable — the machine still holds the
          // token in memory for the duration of the boot.
        }
      }
      this.commit({ kind: "authenticated", token, profile });
      return true;
    } catch (err) {
      this.commit({
        kind: "claim-failed",
        callsign,
        error: (err as Error).message ?? "claim failed",
      });
      return false;
    }
  }

  /**
   * Promote `authenticated` → `ready` once the host has handed the
   * token to the WS client. Kept separate so the host can tell
   * "have a token" apart from "socket open".
   */
  markReady(): void {
    if (this.state.kind !== "authenticated") return;
    this.commit({ kind: "ready", profile: this.state.profile, token: this.state.token });
  }

  /** Test seam — drive a snapshot in directly. */
  __setForTest(next: BootState): void {
    this.commit(next);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * `GET /api/session`. Every non-200 outcome drops the stored
   * token and lands on the claims screen — the spec is explicit that
   * an expired session must never surface as an error wall, and v1
   * has no recovery path (the player claims a new callsign).
   */
  private async runValidate(token: BearerToken): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.origin}/api/session`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 200) {
        const profile = parseSessionProfile((await res.json()) as Record<string, unknown>);
        if (profile !== null) {
          this.commit({ kind: "authenticated", token, profile });
          return;
        }
      }
      this.commit({ kind: "session-expired", expiredCallsign: "", token });
      this.clearStoredToken();
    } catch {
      // Network blip: keep the token (a later reload can retry) and
      // show the claims screen rather than a dead error state.
      this.commit({ kind: "awaiting-claim" });
    }
  }

  /** Best-effort removal of the persisted token. */
  private clearStoredToken(): void {
    if (this.storage === null) return;
    try {
      this.storage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore — an unusable storage is already handled by reads.
    }
  }

  /** Publish a new state to every subscriber (faulty ones are skipped). */
  private commit(next: BootState): void {
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // A faulty listener must not break the loop.
      }
    }
  }
}

/** Pull `message` out of an error body, falling back to `fallback`. */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : fallback;
  } catch {
    return fallback;
  }
}
