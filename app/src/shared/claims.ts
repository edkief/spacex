/**
 * Shared callsign schema + availability probe shape — TASK-56.
 *
 * The schema enforces the same constraints the REST + WS paths
 * already enforce server-side (TASK-10), but lives in `@shared/`
 * so the client can also validate the input *before* the network
 * round-trip (the spec calls out: format check FIRST, availability
 * SECOND).
 *
 * The availability probe result shape is a portable TS type so the
 * client doesn't depend on the server route module.
 *
 * @see ../server/auth/resolver.ts for the canonical schema + the
 *      acceptance criteria this mirrors.
 */
import { z } from "zod";

/** Mirror of `CALLSIGN_MIN` from `auth/resolver.ts` — kept in sync
 *  intentionally; duplicating three constants keeps `shared/` free
 *  of server-specific imports. */
export const CALLSIGN_MIN = 3;

/** Mirror of `CALLSIGN_MAX`. */
export const CALLSIGN_MAX = 16;

/**
 * Callsign validation: 3-16 chars, alphanumeric + dash, no
 * surrounding whitespace. The schema trims whitespace so a paste
 * with linebreaks doesn't trigger an error.
 */
export const CallsignSchema = z
  .string()
  .trim()
  .min(CALLSIGN_MIN)
  .max(CALLSIGN_MAX)
  .regex(/^[A-Za-z0-9-]+$/u, "Callsign must be alphanumeric or dash");

/**
 * Wire shape of the availability probe. Mirrors `AvailabilityResult`
 * in `server/routes/callsigns.ts`; duplicated here so a server
 * restart doesn't cascade into a client rebuild.
 */
export interface AvailabilityResult {
  /** The exact callsign the caller asked about (echoed for the UI). */
  callsign: string;
  /** Same value, lowercased — what the DB actually stores. */
  normalized: string;
  /** True when the format is valid AND the callsign is unclaimed. */
  available: boolean;
  /** Machine-readable reason. */
  reason: "available" | "invalid-format" | "taken";
}
