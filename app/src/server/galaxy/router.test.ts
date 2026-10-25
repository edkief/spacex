import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router } from './router';
import { repo } from '../db/repo';
import { persistService } from '../persist';

vi.mock('../db/repo', () => ({
  repo: {
    loadSystemState: vi.fn(),
  },
}));

vi.mock('../persist', () => ({
  persistService: {
    onShardShutdown: vi.fn(),
  },
}));

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    router = new Router({
      reapGraceMs: 60000,
    });
  });

  it('should spawn a shard on demand', async () => {
    (repo.loadSystemState as any).mockResolvedValue({ ships: [], nodes: [] });

    const shard = await router.getShard('sys-1');
    expect(shard).toBeDefined();
    expect(shard.systemId).toBe('sys-1');
    expect(repo.loadSystemState).toHaveBeenCalledWith('sys-1');
  });

  it('should collapse concurrent spawns', async () => {
    (repo.loadSystemState as any).mockResolvedValue({ ships: [], nodes: [] });

    const p1 = router.getShard('sys-1');
    const p2 = router.getShard('sys-1');

    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);
    expect(repo.loadSystemState).toHaveBeenCalledTimes(1);
  });

  it('should enforce player cap', async () => {
    (repo.loadSystemState as any).mockResolvedValue({ ships: [], nodes: [] });

    const shard = await router.getShard('sys-1');

    // Fill shard to capacity (16)
    for (let i = 0; i < 16; i++) {
      shard.connections.set(`p${i}`, { playerId: `p${i}`, lastSeq: 0, inputQueue: [] } as any);
    }

    const result = await router.joinSystem('sys-1', 'p17', {
      playerId: 'p17',
      callsign: 'p17',
      lastSeq: 0,
      inputQueue: [],
    } as any);
    expect(result).toEqual({ code: 'system-full', message: 'System is at maximum capacity' });
  });

  it('should reap empty shards after grace period', async () => {
    (repo.loadSystemState as any).mockResolvedValue({ ships: [], nodes: [] });

    const shard = await router.getShard('sys-1');

    // Shard is empty
    await router.reapEmptyLoop();

    // Advance time by 60s + 1ms
    vi.setSystemTime(Date.now() + 60001);

    await router.reapEmptyLoop();

    expect(router.getStats().shards.length).toBe(0);
    expect(persistService.onShardShutdown).toHaveBeenCalledWith('sys-1', shard);
  });

  it('should not reap shard if players join during grace', async () => {
    (repo.loadSystemState as any).mockResolvedValue({ ships: [], nodes: [] });

    const shard = await router.getShard('sys-1');
    await router.reapEmptyLoop();

    // Advance time by 30s
    vi.setSystemTime(Date.now() + 30000);

    // Player joins
    shard.connections.set('p1', { playerId: 'p1', lastSeq: 0, inputQueue: [] } as any);

    // Advance time by another 40s (total 70s, past grace)
    vi.setSystemTime(Date.now() + 70000);

    await router.reapEmptyLoop();

    expect(router.getStats().shards.length).toBe(1);
  });

  it('should handle shutdownAll', async () => {
    (repo.loadSystemState as any).mockResolvedValue({ ships: [], nodes: [] });

    await router.getShard('sys-1');
    await router.getShard('sys-2');

    await router.shutdownAll();

    expect(router.getStats().shards.length).toBe(0);
    expect(persistService.onShardShutdown).toHaveBeenCalledTimes(2);
  });

  it('should handle a reconnect storm and reuse the shard', async () => {
    (repo.loadSystemState as any).mockResolvedValue({ ships: [], nodes: [] });
    const systemId = 'sys-storm';

    // 1. 16 clients join
    for (let i = 0; i < 16; i++) {
      await router.joinSystem(systemId, `p${i}`, {
        playerId: `p${i}`,
        callsign: `p${i}`,
        lastSeq: 0,
        inputQueue: [],
      } as any);
    }
    const shard1 = await router.getShard(systemId);
    const gen1 = shard1.generation;

    // 2. All leave
    for (let i = 0; i < 16; i++) {
      router.leaveSystem(systemId, `p${i}`);
    }

    // 3. 10 rejoin within 2s (before reap)
    for (let i = 0; i < 10; i++) {
      await router.joinSystem(systemId, `p${i}`, {
        playerId: `p${i}`,
        callsign: `p${i}`,
        lastSeq: 0,
        inputQueue: [],
      } as any);
    }

    const shard2 = await router.getShard(systemId);
    expect(shard2).toBe(shard1);
    expect(shard2.generation).toBe(gen1);
    expect(repo.loadSystemState).toHaveBeenCalledTimes(1);
  });

  it('should not leak shards after many join/leave cycles', async () => {
    (repo.loadSystemState as any).mockResolvedValue({ ships: [], nodes: [] });
    const systems = ['s1', 's2', 's3', 's4', 's5'];

    for (let cycle = 0; cycle < 20; cycle++) {
      for (const sys of systems) {
        // Join a few
        for (let i = 0; i < 3; i++) {
          await router.joinSystem(sys, `p${cycle}-${i}`, {
            playerId: `p${cycle}-${i}`,
            callsign: `p${cycle}-${i}`,
            lastSeq: 0,
            inputQueue: [],
          } as any);
        }
        // Leave all
        for (let i = 0; i < 3; i++) {
          router.leaveSystem(sys, `p${cycle}-${i}`);
        }
      }
    }

    // Trigger reap
    await router.reapEmptyLoop();
    vi.setSystemTime(Date.now() + 60001);
    await router.reapEmptyLoop();

    expect(router.getStats().shards.length).toBe(0);
  });
});
