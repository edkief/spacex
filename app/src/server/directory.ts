import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import type { StateSnapshot } from './ws/snapshot.ts';

/** Who is joining a system. */
export interface DirectoryPlayer {
  playerId: string;
  callsign: string;
  shipId: string;
}

export type JoinResult =
  | { ok: true; snapshot: StateSnapshot }
  | { ok: false; code: 'system-not-found' | 'system-full'; message: string };

/**
 * The seam between the connection layer and the (future) shards. The real shard/router tasks
 * replace the stub below behind this same interface.
 */
export interface SystemDirectory {
  join(systemId: string, player: DirectoryPlayer): Promise<JoinResult>;
  leave(systemId: string, playerId: string): Promise<void>;
}

export interface GalaxyDirectoryOptions {
  seed: string;
  /** Players per system before `system-full` (the PRD target is 16). */
  capacity?: number;
}

/**
 * Stub directory: validates the system id against the generated galaxy for `seed`, counts
 * occupants for the capacity check, and returns an empty snapshot. No simulation, no presence.
 */
export function createGalaxyDirectory(options: GalaxyDirectoryOptions): SystemDirectory {
  const capacity = options.capacity ?? 16;
  const known = new Set(
    generateStars(options.seed).map((star) => generateSystemForStar(options.seed, star).systemId),
  );
  const occupants = new Map<string, Set<string>>();

  return {
    join(systemId, player) {
      if (!known.has(systemId)) {
        return Promise.resolve({ ok: false, code: 'system-not-found', message: 'no such system' });
      }
      const here = occupants.get(systemId) ?? new Set<string>();
      if (!here.has(player.playerId) && here.size >= capacity) {
        return Promise.resolve({ ok: false, code: 'system-full', message: 'system is full' });
      }
      here.add(player.playerId);
      occupants.set(systemId, here);
      return Promise.resolve({
        ok: true,
        snapshot: {
          systemId,
          tick: 0,
          lastInputSeq: 0,
          entities: [],
          nodes: [],
          chat: [],
          players: [],
        },
      });
    },
    leave(systemId, playerId) {
      occupants.get(systemId)?.delete(playerId);
      return Promise.resolve();
    },
  };
}
