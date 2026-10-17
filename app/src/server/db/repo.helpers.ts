/**
 * Shared helpers used by both driver-specific repository implementations.
 *
 * The two repos (`createSqliteRepository` and `createPgRepository`) differ
 * only in how they:
 *   1. Hand raw rows back from the driver (SQLite returns `string` for
 *      timestamps/text, Postgres returns native Date objects).
 *   2. Express upserts (`onConflictDoUpdate` is the same API on both; only
 *      the row types differ).
 *
 * Everything else — validation, clamping, business-rule checks, unique-
 * violation mapping — lives here in driver-agnostic helpers so each
 * implementation stays a thin wrapper over drizzle's query builder.
 */
import { z } from "zod";
import { CallsignTakenError, InsufficientCreditsError, NotFoundError } from "./errors.js";
import type { CreateSystemRegistryInput } from "./repo.js";

/** ISO-string timestamp with millisecond precision. */
export function isoNow(): string {
  return new Date().toISOString();
}

/** Clamp an integer to [lo, hi]. Used for hull/shields percentages. */
export function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isInteger(value)) {
    throw new Error(`Expected integer, got ${value}`);
  }
  return Math.max(lo, Math.min(hi, value));
}

/** Parse an ISO string or Date-like input into a `Date`. */
export function parseDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`Invalid date value: ${String(value)}`);
}

/** Parse a JSON-encoded TEXT column into a JS object. */
export function parseJsonField(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`Invalid JSON in ${field}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * Map a low-level driver error to a typed business error when possible.
 * Anything we can't classify is re-thrown unchanged.
 */
export function mapUniqueViolation(err: unknown, callsign: string): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(msg)) {
    if (
      /players\.callsign_unique/i.test(msg) ||
      /players_callsign_unique/i.test(msg) ||
      /players\.callsign/i.test(msg)
    ) {
      return new CallsignTakenError(callsign);
    }
  }
  // Postgres uses SQLSTATE 23505 for unique_violation; Drizzle surfaces it.
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  ) {
    if (/callsign/i.test(msg)) {
      return new CallsignTakenError(callsign);
    }
  }
  return err;
}

/** Validate that a `addCredits`/`withdrawCredits` amount is a positive int. */
export function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}: amount must be > 0, got ${value}`);
  }
}

/** Resolve `CreateSystemRegistryInput` to a row-shaped object the driver likes. */
export function systemRegistryInsertValues(
  row: CreateSystemRegistryInput,
  lastActiveAt: Date | string,
): {
  systemId: string;
  name: string;
  shardActive: boolean;
  lastActiveAt: Date | string;
} {
  return {
    systemId: row.systemId,
    name: row.name,
    shardActive: row.shardActive,
    lastActiveAt,
  };
}

/** Re-export z so other modules can avoid an extra import. */
export { z };
// Re-export the typed errors for short references downstream.
export { CallsignTakenError, InsufficientCreditsError, NotFoundError };
