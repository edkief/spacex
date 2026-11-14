/** A player with this callsign already exists. */
export class CallsignTakenError extends Error {
  readonly callsign: string;
  constructor(callsign: string) {
    super(`Callsign already taken: ${callsign}`);
    this.name = 'CallsignTakenError';
    this.callsign = callsign;
  }
}

/** A withdrawal asked for more credits than the player holds. */
export class InsufficientCreditsError extends Error {
  readonly requested: number;
  readonly balance: number;
  constructor(requested: number, balance: number) {
    super(`Insufficient credits: requested ${requested}, balance ${balance}`);
    this.name = 'InsufficientCreditsError';
    this.requested = requested;
    this.balance = balance;
  }
}

/** The referenced row does not exist. */
export class NotFoundError extends Error {
  readonly entity: string;
  readonly id: string;
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
    this.entity = entity;
    this.id = id;
  }
}

/** A credit amount that is not a non-negative safe integer within the allowed range. */
export class InvalidAmountError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

/** A stored row failed validation on read (manual edit or schema drift). */
export class CorruptRowError extends Error {
  constructor(entity: string, id: string, detail: string) {
    super(`Corrupt ${entity} row ${id}: ${detail}`);
    this.name = 'CorruptRowError';
  }
}

/** Collects an error and its `cause` chain (drivers and Drizzle wrap errors differently). */
function chain(error: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    found.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

/**
 * True when `error` is a unique/primary-key violation mentioning `hint` (a column or constraint
 * name fragment). Recognises SQLite (SQLITE_CONSTRAINT_UNIQUE/PRIMARYKEY) and Postgres (23505).
 */
export function isUniqueViolation(error: unknown, hint: string): boolean {
  return chain(error).some((link) => {
    const code = typeof link['code'] === 'string' ? link['code'] : '';
    const text = [link['message'], link['constraint'], link['detail']].join(' ');
    const unique =
      code === '23505' ||
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
    return unique && text.includes(hint);
  });
}
