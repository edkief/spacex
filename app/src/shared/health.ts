/**
 * Shared health-check payload.
 *
 * Used by both the Fastify handler in `src/server` and the client-side
 * status indicators in `src/client`. Living in `src/shared` keeps the
 * wire shape in one place so server and client never drift.
 */
export interface HealthPayload {
  ok: boolean;
  galaxySeed: string;
}

/** Default payload used when no server config is available (tests, SSR). */
export const FALLBACK_HEALTH: HealthPayload = {
  ok: true,
  galaxySeed: "DRIFT-SEED-0001",
};

/** Pure constructor so tests can build snapshots without side effects. */
export function makeHealth(galaxySeed: string): HealthPayload {
  return { ok: true, galaxySeed };
}
