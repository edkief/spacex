import { InvalidAmountError } from './errors.ts';

/** Largest credit balance: the Postgres `integer` maximum, enforced on SQLite too for parity. */
export const MAX_CREDITS = 2_147_483_647;

/** Throws InvalidAmountError unless `amount` is a positive safe integer. */
export function assertPositiveInt(amount: number, what: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new InvalidAmountError(`${what} must be a positive integer, got ${amount}`);
  }
}
