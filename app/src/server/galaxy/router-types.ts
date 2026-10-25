export interface RouterOptions {
  reapGraceMs?: number;
  maxPlayersPerSystem?: number;
  connSender?: (connId: string, type: string, payload: string) => void;
}

export interface RouterShardStats {
  systemId: string;
  name: string;
  players: number;
  uptimeMs: number;
}

export interface RouterStats {
  shards: RouterShardStats[];
}

export interface JoinResult {
  shard: any;
  systemId: string;
  snapshot: any[];
}

export interface JoinRejection {
  code: 'system-full' | 'internal-error';
  message: string;
}

export interface RouterConnectionContext {
  connId: string;
  playerId: string;
  systemId: string | null;
}
