/** Shape of the `/api/health` response, shared by the server and any client that reads it. */
export interface HealthResponse {
  ok: true;
  galaxySeed: string;
}

/**
 * Builds the health payload for a given galaxy seed.
 * Pure and environment-agnostic so it behaves identically in Node and the browser.
 */
export function buildHealth(galaxySeed: string): HealthResponse {
  return { ok: true, galaxySeed };
}
