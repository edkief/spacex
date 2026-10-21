/**
 * Session primitives shared by the boot flow (TASK-56).
 *
 * The bearer token lives in one `localStorage` key
 * (`drift.token`) and every session response — whether it comes
 * from `POST /api/callsigns` (a fresh claim) or `GET /api/session`
 * (a restore) — is validated through the same zod schema before the
 * app is allowed to treat it as a session.
 *
 * Split out of `./bootSession.ts` so that file stays about the state
 * machine; persistence + parsing are a separate concern.
 */
import { z } from "zod";

/** localStorage key for the persisted bearer token. */
export const TOKEN_STORAGE_KEY = "drift.token";

/** Token shape returned by `POST /api/callsigns` + `GET /api/session`. */
export interface SessionProfile {
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
  tokenExpiresAt: number;
  /**
   * TASK-56: the system the session was last bound to. `null` on a
   * fresh claim (the claim response has no such field yet); the
   * session endpoint fills it from `sessions.system_id`. v1 falls
   * back to `homeSystemId` whenever it's absent.
   */
  lastSystemId?: string | null;
}

/** Bearer token shape (string). */
export type BearerToken = string;

/**
 * The subset of the `Storage` interface the boot flow needs, so
 * tests can pass a plain object (and a `null` storage simulates a
 * browser with localStorage disabled).
 */
export interface BootStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The browser's `localStorage`, or `null` when it is unavailable
 * (private mode, SSR, a locked-down embedder).
 */
export function defaultBootStorage(): BootStorage | null {
  try {
    return (globalThis as { localStorage?: BootStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

const SessionProfileSchema = z.object({
  playerId: z.string().min(1),
  callsign: z.string().min(1),
  homeSystemId: z.string().min(1),
  shipId: z.string().min(1),
  tokenExpiresAt: z.number(),
  // TASK-56: optional for backwards compatibility — a claim
  // response predates the field, an older server omits it.
  lastSystemId: z.string().min(1).nullish(),
});

/**
 * Validate a session payload from either endpoint. Returns `null`
 * when the shape is wrong so callers fall back to the claims screen
 * rather than booting into a half-known session.
 */
export function parseSessionProfile(json: unknown): SessionProfile | null {
  const parsed = SessionProfileSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Read the bearer token out of storage. Returns `null` when the
 * key is missing, blank, or storage itself is unavailable.
 */
export function readStoredToken(storage: BootStorage | null): string | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(TOKEN_STORAGE_KEY);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
}
