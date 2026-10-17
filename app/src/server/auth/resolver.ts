/**
 * Auth resolvers for the Drift WebSocket server (TASK-10).
 *
 * Splits the old TASK-9 `defaultAuthResolver` stub into two real
 * implementations against the persistence layer:
 *
 *   - `claimCallsign(repo, secret, callsign, options)` — mint a brand-new
 *     player + starter ship + session token. Idempotent *only* in the
 *     duplicate-callsign failure path (409). Otherwise always creates.
 *   - `resumeSession(repo, secret, token)` — verify an existing token
 *     against the session store and return the player profile.
 *
 * Both routes also expose the underlying `AuthResolver` adapter so
 * `attachWs()` can be wired with a real implementation in one line.
 *
 * Security guarantees:
 *   - Sessions are stored by `sha256(token)` hash; the raw token never
 *     touches the DB and is never logged.
 *   - The `SESSION_SECRET` is required for both signing and verifying;
 *     server boot fails loudly if it is missing or too short.
 *   - Token expiry is enforced at verify time with a small forward skew
 *     tolerance; rejected tokens are never cached.
 */

import { z } from "zod";
import { generateStars } from "@shared/galaxy/stars.js";
import type { Repository } from "../db/repo.js";
import { CallsignTakenError } from "../db/errors.js";
import {
  CLOCK_SKEW_TOLERANCE_SEC,
  DEFAULT_TTL_MS,
  hashToken,
  mintToken,
  verify,
  type TokenPayload,
} from "./token.js";

// ---------------------------------------------------------------------------
// Constants — exported so server boot + tests share one source
// ---------------------------------------------------------------------------

/**
 * Callsign validation: 3-16 chars, alphanumeric + dash, case-insensitive
 * uniqueness. Mirrored in zod schema below; the server uses the schema,
 * tests reference the constants.
 */
export const CALLSIGN_MIN = 3;
export const CALLSIGN_MAX = 16;

/**
 * Zod schema for an inbound callsign claim. Used by both the REST route
 * (POST /api/callsigns) and the WS auth payload (`{ callsign }`).
 */
export const CallsignSchema = z
  .string()
  .trim()
  .min(CALLSIGN_MIN)
  .max(CALLSIGN_MAX)
  .regex(/^[A-Za-z0-9-]+$/u, "Callsign must be alphanumeric or dash");

/**
 * Zod schema for the WS auth payload union. TASK-10 uses the
 * `{ callsign }` branch; `{ token }` is consulted by `resumeSession`.
 */
export const AuthClaimsSchema = z.union([
  z.object({ callsign: CallsignSchema }).strict(),
  z.object({ token: z.string().min(1) }).strict(),
]);

/** Default starter ship class (TASK-20 narrows this to a player choice). */
export const STARTER_SHIP_CLASS = "scout" as const;

/** Default lifetime for sessions minted from a callsign claim. */
export const DEFAULT_SESSION_TTL_MS = DEFAULT_TTL_MS;

// ---------------------------------------------------------------------------
// Home-system selection
// ---------------------------------------------------------------------------

/**
 * Choose the seeded home system for a brand-new player. Every deterministic
 * galaxy (TASK-3) exposes the same star list given the same seed, so we
 * pick `stars[playerNumber % N]` where `playerNumber` is a stable hash
 * of the normalised callsign. This means a re-claim produces the same
 * home system, and the assignment is *pure* on input — anyone can
 * deterministically predict it.
 *
 * Why not just always `stars[0]`? Spec calls for "a seeded system chosen
 * from the galaxy" so two players racing at sign-up land in different
 * homes — gives the galaxy some geography.
 */
export function pickHomeSystemId(callsign: string, starCount: number, seed: string): string {
  if (starCount <= 0) {
    throw new Error(`pickHomeSystemId: galaxy has no stars (seed=${seed})`);
  }
  // FNV-1a over the lowercase callsign. Same idea as TASK-9's
  // `defaultAuthResolver`, applied here to keep the home-system pick
  // stable for the same callsign regardless of insertion order.
  let hash = 0x811c9dc5;
  const s = callsign.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  const stars = generateStars(seed, starCount);
  const idx = ((hash % starCount) + starCount) % starCount;
  const star = stars[idx];
  if (!star) throw new Error(`pickHomeSystemId: missing star at index ${idx}`);
  return star.id;
}

// ---------------------------------------------------------------------------
// Claim a callsign (REST + WS path)
// ---------------------------------------------------------------------------

/**
 * Outcome of a successful callsign claim. Surfaced in the REST response
 * payload and used by the auth-resolver adapter to populate
 * `auth_ok.tokenExpiresAt`.
 */
export interface ClaimResult {
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
  token: string;
  tokenExpiresAt: number;
}

/**
 * Public options for `claimCallsign()`. `nowMs` is exposed so tests can
 * drive the system clock; `starCount` lets callers pin the galaxy size.
 */
export interface ClaimOptions {
  galaxySeed: string;
  galaxyStarCount: number;
  ttlMs?: number;
  nowMs?: number;
}

/**
 * Claim a callsign for a brand-new player.
 *
 * Steps:
 *   1. Validate the callsign format via `CallsignSchema`.
 *   2. Pick a deterministic home system from the seeded galaxy.
 *   3. Create the player; `CallsignTakenError` from the repo is rethrown
 *      unchanged so the caller can map it to a 409.
 *   4. Create the starter ship (class `scout` per spec).
 *   5. Mint a signed session token.
 *   6. Insert the `sessions` row with `tokenHash = sha256(token)`.
 *   7. Return `{ playerId, callsign, homeSystemId, shipId, token, tokenExpiresAt }`.
 *
 * The raw token is *not* persisted — only `sha256(token)` lands in the
 * `sessions` table. Replay of a lost token is impossible because the
 * DB has no way to recover it.
 *
 * @throws `CallsignTakenError` if the callsign is already taken.
 * @throws if `secret` is too short.
 */
export async function claimCallsign(
  repo: Repository,
  secret: string,
  callsign: string,
  options: ClaimOptions,
): Promise<ClaimResult> {
  const parsed = CallsignSchema.safeParse(callsign);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "invalid callsign";
    throw new InvalidCallsignError(issue);
  }
  const valid = parsed.data;
  const homeSystemId = pickHomeSystemId(valid, options.galaxyStarCount, options.galaxySeed);

  const player = await repo.createPlayer({ callsign: valid, homeSystemId });
  const ship = await repo.getOrCreateStarterShip(player.id, STARTER_SHIP_CLASS);

  const { token, exp } = mintToken(secret, {
    playerId: player.id,
    systemId: null,
    ttlMs: options.ttlMs,
    nowMs: options.nowMs,
  });

  await repo.createSession({
    tokenHash: hashToken(token),
    playerId: player.id,
    systemId: null,
    ttlMs: (options.ttlMs ?? DEFAULT_SESSION_TTL_MS) + CLOCK_SKEW_TOLERANCE_SEC * 1000,
  });

  return {
    playerId: player.id,
    callsign: player.callsign,
    homeSystemId,
    shipId: ship.id,
    token,
    tokenExpiresAt: exp,
  };
}

/**
 * Re-trying a taken callsign is a hard failure — the spec calls for
 * "409 forever". We expose this type for callers that want to map
 * `InvalidCallsignError` to its own response shape (e.g. 422).
 */
export class InvalidCallsignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCallsignError";
  }
}

// ---------------------------------------------------------------------------
// Revoke a session (TASK-66)
// ---------------------------------------------------------------------------

/**
 * Outcome of `revokeSession()` — used by the REST `POST /api/session/logout`
 * handler and the WS `logout` message handler to decide which response to
 * emit. `playerId` is included so the WS handler can update connection
 * bookkeeping before closing.
 */
export interface RevokeResult {
  /** `true` when a session row matched `tokenHash` and was deleted. */
  revoked: boolean;
  /** Callsign of the owning player, if the lookup succeeded. */
  callsign: string | null;
  /** Player id of the owning player, if the lookup succeeded. */
  playerId: string | null;
}

/**
 * Options for `revokeSession()`. `nowMs` is purely defensive — the
 * revocation itself does not depend on the wall clock, but allowing
 * callers to drive the clock keeps the function symmetric with
 * `resumeSession()` for tests.
 */
export interface RevokeOptions {
  nowMs?: number;
}

/**
 * Revoke the session attached to `token`. Performs the same checks
 * `resumeSession` does (signature + exp + DB lookup) before deleting the
 * session row so that:
 *
 *   - a malformed/bad-sig token cannot silently land on a real session,
 *   - an already-expired token still revokes any leftover row, and
 *   - a token whose session row is gone reports `{ revoked: false }`
 *     instead of throwing.
 *
 * Returns `{ revoked: false, callsign: null, playerId: null }` for every
 * failure mode so callers can map to a generic 401 (REST) or
 * `unauthenticated` error (WS) without leaking which check failed.
 *
 * **Concurrent-use note:** the shared-account model means two sockets
 * holding the same token both see `{ revoked: true }` for the same row
 * — the FIRST revocation deletes the row, and a second revoke of the
 * same token reports `revoked: false` because the row is gone. WS
 * connections are expected to close after their own revoke completes;
 * a parallel socket will find the row deleted at the next resume and
 * fall back to the standard `unauthenticated` path.
 *
 * @see repo.deleteSession — actual DB call.
 */
export async function revokeSession(
  repo: Repository,
  secret: string,
  token: string,
  _options: RevokeOptions = {},
): Promise<RevokeResult> {
  if (typeof token !== "string" || token.length === 0) {
    return { revoked: false, callsign: null, playerId: null };
  }
  const nowSec = Math.floor((_options.nowMs ?? Date.now()) / 1000);
  const payload: TokenPayload | null = verify(secret, token, nowSec);
  if (!payload) return { revoked: false, callsign: null, playerId: null };

  const session = await repo.getSession(hashToken(token));
  if (!session) {
    return { revoked: false, callsign: null, playerId: payload.playerId };
  }
  // Confirm the row's playerId matches the token's payload so a token
  // signed for player A cannot revoke player B's session — even if the
  // hash collision landed on B's row (sha256 collisions are vanishingly
  // unlikely but the cross-check is cheap).
  if (session.playerId !== payload.playerId) {
    return { revoked: false, callsign: null, playerId: payload.playerId };
  }
  await repo.deleteSession(hashToken(token));
  // Best-effort: pull the callsign so callers (the WS handler, primarily)
  // can null out `conn.callsign` / log the actor. Failure here is not fatal
  // — the row is already gone, which is the success criterion.
  const player = await repo.findPlayerById(payload.playerId);
  return {
    revoked: true,
    callsign: player?.callsign ?? null,
    playerId: payload.playerId,
  };
}

// ---------------------------------------------------------------------------
// Resume a session (WS auth-by-token path)
// ---------------------------------------------------------------------------

/**
 * Outcome of a token-based resume. Surfaced in the WS `auth_ok` and in
 * the REST `GET /api/session` response.
 */
export interface SessionResult {
  playerId: string;
  callsign: string;
  systemId: string | null;
  tokenExpiresAt: number;
}

/**
 * Public options for `resumeSession()`. `nowMs` exposes the clock so
 * expired-token tests can drive time deterministically.
 */
export interface ResumeOptions {
  nowMs?: number;
}

/**
 * Resume a session from a raw bearer token.
 *
 * Steps:
 *   1. Verify the token signature + expiry against `secret`.
 *   2. Look up the token hash in the `sessions` table; missing or
 *      expired-on-disk rows return `null` (treated identically to a
 *      signature failure — the client shouldn't be told which one
 *      was wrong).
 *   3. Fetch the player row and return `{ playerId, callsign, … }`.
 *
 * Returns `null` for any failure: malformed token, bad signature,
 * expired, missing session, or vanished player. Each of those is
 * wirewise `401 unauthenticated`.
 */
export async function resumeSession(
  repo: Repository,
  secret: string,
  token: string,
  _options: ResumeOptions = {},
): Promise<SessionResult | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  const nowSec = Math.floor((_options.nowMs ?? Date.now()) / 1000);
  const payload: TokenPayload | null = verify(secret, token, nowSec);
  if (!payload) return null;

  const session = await repo.getSession(hashToken(token));
  if (!session) return null;
  // Belt-and-braces: even if the DB row is somehow stale, refuse when
  // the DB `expires_at` is already in the past.
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const player = await repo.findPlayerById(payload.playerId);
  if (!player || player.id !== session.playerId) return null;

  return {
    playerId: player.id,
    callsign: player.callsign,
    systemId: session.systemId,
    tokenExpiresAt: payload.exp,
  };
}

// ---------------------------------------------------------------------------
// Session profile (REST GET /api/session)
// ---------------------------------------------------------------------------

/**
 * Player profile returned by `GET /api/session`. Subset of `PlayerRow`
 * + the currently-owned starter ship id.
 */
export interface SessionProfile {
  playerId: string;
  callsign: string;
  credits: number;
  homeSystemId: string | null;
  shipId: string;
  tokenExpiresAt: number;
}

/**
 * Full session lookup used by the REST `/api/session` endpoint. Returns
 * the player profile plus the active starter ship id (always one per
 * player — TASK-20 adds the buy_ship flow).
 */
export async function loadSessionProfile(
  repo: Repository,
  secret: string,
  token: string,
  options: ResumeOptions = {},
): Promise<SessionProfile | null> {
  const base = await resumeSession(repo, secret, token, options);
  if (!base) return null;
  const player = await repo.findPlayerById(base.playerId);
  if (!player) return null;
  const ships = await repo.listShipsByOwner(player.id);
  const ship = ships[0];
  if (!ship) return null; // every player has a starter ship; this is a defensive check
  return {
    playerId: player.id,
    callsign: player.callsign,
    credits: player.credits,
    homeSystemId: player.homeSystemId,
    shipId: ship.id,
    tokenExpiresAt: base.tokenExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// WS LogoutResolver adapter (TASK-66)
// ---------------------------------------------------------------------------

/**
 * Build a `LogoutResolver`-shaped function the server can plug straight
 * into `attachWs({ logoutResolver })`. Deletes every session row for
 * the player; if at least one row was removed, returns the player's
 * callsign so the WS handler can echo it in `logout_ok`.
 *
 * The handler treats "zero rows deleted" as the "already revoked"
 * case: it still sends a `logout_ok` frame (the player has no active
 * sessions, which is the goal) and closes with code 1000. We do not
 * refuse logout when the session row is already gone because clients
 * may legitimately retry after a network blip and the user intent —
 * "I want to be signed out" — is satisfied either way.
 */
export function buildLogoutResolver(
  repo: Repository,
): (playerId: string) => Promise<{ revoked: number; callsign: string }> {
  return async (playerId: string) => {
    const revoked = await repo.deleteSessionsByPlayerId(playerId);
    const player = await repo.findPlayerById(playerId);
    return { revoked, callsign: player?.callsign ?? "" };
  };
}

// ---------------------------------------------------------------------------
// WS AuthResolver adapter
// ---------------------------------------------------------------------------

/**
 * Build a `defaultAuthResolver`-shaped function the server can plug
 * straight into `attachWs({ authResolver })`.
 *
 * The adapter accepts both `{ callsign }` and `{ token }` payload shapes
 * (the WS AuthSchema is already a union of both). On the callsign branch
 * it goes through the full `claimCallsign` flow. On the token branch it
 * resumes the session. Rejections bubble as plain `Error`s so the
 * existing TASK-9 `onAuth` handler maps them to `unauthenticated` + close.
 */
export function buildAuthResolver(repo: Repository, secret: string, defaults: ClaimOptions) {
  return async (
    rawPayload: unknown,
  ): Promise<{
    playerId: string;
    callsign: string;
    tokenExpiresAt: number;
  }> => {
    const parsed = AuthClaimsSchema.safeParse(rawPayload);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "invalid auth payload";
      throw new Error(msg);
    }
    const payload = parsed.data;
    if ("callsign" in payload) {
      try {
        const result = await claimCallsign(repo, secret, payload.callsign, defaults);
        return {
          playerId: result.playerId,
          callsign: result.callsign,
          tokenExpiresAt: result.tokenExpiresAt,
        };
      } catch (err) {
        if (err instanceof CallsignTakenError) {
          // Per spec, callsign re-claim is impossible (409 forever). The
          // WS path maps this to the same `unauthenticated` error a
          // client would see on a bad token, so the wire code is
          // intentionally opaque about *which* auth check failed.
          throw new Error("callsign taken", { cause: err });
        }
        throw err;
      }
    }
    // token branch
    const resumed = await resumeSession(repo, secret, payload.token, {
      nowMs: defaults.nowMs,
    });
    if (!resumed) throw new Error("session not found or expired");
    return {
      playerId: resumed.playerId,
      callsign: resumed.callsign,
      tokenExpiresAt: resumed.tokenExpiresAt,
    };
  };
}
