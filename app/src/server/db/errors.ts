/** A player with this callsign already exists. */
export class CallsignTakenError extends Error {
  constructor(readonly callsign: string) {
    super(`callsign already taken: ${callsign}`);
    this.name = 'CallsignTakenError';
  }
}

/** Withdrawal exceeds the player's balance. */
export class InsufficientCreditsError extends Error {
  constructor(
    readonly playerId: string,
    readonly requested: number,
    readonly balance: number,
  ) {
    super(`insufficient credits: requested ${requested}, balance ${balance}`);
    this.name = 'InsufficientCreditsError';
  }
}

/** The requested row does not exist. */
export class NotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

/** True when the driver surfaced a UNIQUE-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|duplicate key value/i.test(msg);
}
