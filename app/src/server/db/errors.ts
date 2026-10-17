/**
 * Typed errors raised by the Drift persistence layer.
 *
 * The repository never throws plain `Error` for known business outcomes;
 * instead it surfaces these named subclasses so callers can branch on
 * `instanceof` without string-matching messages.
 *
 * Driver-specific errors (unique-constraint failures, FK violations, etc.)
 * are caught at the client boundary and re-thrown as one of these typed
 * errors — see `./client.ts` for the mapping logic.
 */

/** Base class for all repository-level business errors. */
export abstract class RepositoryError extends Error {
  abstract readonly kind: string;
}

/**
 * Raised when a player tries to claim a callsign that is already taken
 * (UNIQUE constraint violation on `players.callsign`).
 */
export class CallsignTakenError extends RepositoryError {
  readonly kind = "callsign_taken" as const;
  constructor(public readonly callsign: string) {
    super(`Callsign already taken: ${callsign}`);
    this.name = "CallsignTakenError";
  }
}

/**
 * Raised when `withdrawCredits` is asked for more than the player has
 * (negative-clamp check on `players.credits`).
 */
export class InsufficientCreditsError extends RepositoryError {
  readonly kind = "insufficient_credits" as const;
  constructor(
    public readonly playerId: string,
    public readonly current: number,
    public readonly requested: number,
  ) {
    super(`Insufficient credits for player ${playerId}: have ${current}, need ${requested}`);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * Raised when a row lookup by primary key/unique column returns no match.
 * Distinct from a driver-level "connection lost" error — call sites that
 * require an existing row should branch on `instanceof NotFoundError`.
 */
export class NotFoundError extends RepositoryError {
  readonly kind = "not_found" as const;
  constructor(
    public readonly entity: string,
    public readonly key: string,
  ) {
    super(`${entity} not found: ${key}`);
    this.name = "NotFoundError";
  }
}
