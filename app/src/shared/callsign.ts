import { z } from 'zod';

/** 3-16 chars, alphanumeric + dash (uniqueness is case-insensitive). */
export const CALLSIGN_PATTERN = /^[A-Za-z0-9-]{3,16}$/;

/**
 * Callsign input schema (shared by server routes and the future client).
 * The transform folds the value to lowercase so the callsign column gives
 * case-insensitive uniqueness without any per-driver collation tricks.
 */
export const callsignSchema = z
  .string()
  .min(3, 'callsign must be 3-16 characters')
  .max(16, 'callsign must be 3-16 characters')
  .regex(CALLSIGN_PATTERN, 'callsign must be alphanumeric with dashes (a-z, 0-9, -)')
  .transform((value) => value.toLowerCase());

export type Callsign = z.infer<typeof callsignSchema>;
