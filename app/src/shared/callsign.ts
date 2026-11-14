import { z } from 'zod';

/** 3-16 characters of A-Z, a-z, 0-9 and dash, with no leading or trailing dash. */
export const CALLSIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{1,14}[A-Za-z0-9]$/;

/** Validates a callsign and canonicalises it to UPPERCASE (so uniqueness is case-insensitive). */
export const callsignSchema = z
  .string()
  .regex(
    CALLSIGN_PATTERN,
    'callsign must be 3-16 letters, digits or dashes, not starting or ending with a dash',
  )
  .transform((value) => value.toUpperCase());

/** The canonical (stored and compared) form of an already-valid callsign. */
export function canonicalCallsign(callsign: string): string {
  return callsign.toUpperCase();
}
