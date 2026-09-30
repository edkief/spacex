/** Payload returned by the REST health endpoint. */
export interface HealthPayload {
  ok: boolean;
  galaxySeed: string;
}

/** One active shard in the galaxy health payload (TASK-11). */
export interface GalaxyShardHealth {
  systemId: string;
  name: string;
  players: number;
  uptimeMs: number;
}

/** Payload of GET /api/galaxy/health (auth) — the router's active shards. */
export interface GalaxyHealthPayload {
  shards: GalaxyShardHealth[];
}
