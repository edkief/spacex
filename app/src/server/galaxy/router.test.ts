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
    
    const result = await router.joinSystem('sys-1', 'p17');
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
});
