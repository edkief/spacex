import { expect, it } from 'vitest';
import { NotFoundError } from './errors.ts';
import type { NodeState } from './types.ts';
import { describeBackends, uniqueCallsign } from './testing/backends.ts';

describeBackends('sessions', (fx) => {
  const makePlayer = () =>
    fx().repo.createPlayer({ callsign: uniqueCallsign(), homeSystemId: 'sys' });
  const hash = () => `hash-${uniqueCallsign()}`;

  it('creates, reads, updates and deletes a session', async () => {
    const { repo, clock } = fx();
    const player = await makePlayer();
    const tokenHash = hash();
    const expiresAt = new Date(clock.now().getTime() + 60_000);
    const created = await repo.createSession({ tokenHash, playerId: player.id, expiresAt });
    expect(created).toEqual({
      tokenHash,
      playerId: player.id,
      systemId: null,
      createdAt: clock.now(),
      expiresAt,
    });
    expect(await repo.getSession(tokenHash)).toEqual(created);
    await repo.setSessionSystem(tokenHash, 'sys-9');
    expect((await repo.getSession(tokenHash))?.systemId).toBe('sys-9');
    await repo.setSessionSystem(tokenHash, null);
    expect((await repo.getSession(tokenHash))?.systemId).toBeNull();
    expect(await repo.deleteSession(tokenHash)).toBe(true);
    expect(await repo.deleteSession(tokenHash)).toBe(false);
    expect(await repo.getSession(tokenHash)).toBeUndefined();
  });

  it('raises NotFoundError when updating an unknown session', async () => {
    await expect(fx().repo.setSessionSystem('nope', 'x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects sessions for unknown players and duplicate token hashes', async () => {
    const { repo, clock } = fx();
    const expiresAt = new Date(clock.now().getTime() + 1000);
    await expect(
      repo.createSession({ tokenHash: hash(), playerId: 'ghost', expiresAt }),
    ).rejects.toThrow();
    const player = await makePlayer();
    const tokenHash = hash();
    await repo.createSession({ tokenHash, playerId: player.id, expiresAt });
    await expect(
      repo.createSession({ tokenHash, playerId: player.id, expiresAt }),
    ).rejects.toThrow();
  });

  it('deletes a player’s sessions and only the expired ones on cleanup', async () => {
    const { repo, clock } = fx();
    const player = await makePlayer();
    const other = await makePlayer();
    const now = clock.now().getTime();
    const [old1, old2, fresh, theirs] = [hash(), hash(), hash(), hash()];
    await repo.createSession({
      tokenHash: old1,
      playerId: player.id,
      expiresAt: new Date(now - 1),
    });
    await repo.createSession({ tokenHash: old2, playerId: other.id, expiresAt: new Date(now) });
    await repo.createSession({
      tokenHash: fresh,
      playerId: player.id,
      expiresAt: new Date(now + 1),
    });
    await repo.createSession({
      tokenHash: theirs,
      playerId: other.id,
      expiresAt: new Date(now + 9),
    });
    expect(await repo.deleteExpiredSessions(clock.now())).toBeGreaterThanOrEqual(2);
    expect(await repo.getSession(old1)).toBeUndefined();
    expect(await repo.getSession(old2)).toBeUndefined();
    expect(await repo.getSession(fresh)).toBeDefined();
    expect(await repo.deleteSessionsForPlayer(player.id)).toBe(1);
    expect(await repo.getSession(theirs)).toBeDefined();
  });
});

describeBackends('resource node state', (fx) => {
  const state = (
    nodeId: string,
    systemId: string,
    q: number,
    respawnAt: Date | null = null,
  ): NodeState => ({
    nodeId,
    systemId,
    quantityRemaining: q,
    respawnAt,
  });

  it('upserts, updates and lists by system', async () => {
    const { repo } = fx();
    const sys = `ns-${uniqueCallsign()}`;
    const respawn = new Date(Date.UTC(2031, 1, 2, 3, 4, 5, 6));
    await repo.upsertNodeState(state(`${sys}-a`, sys, 40));
    await repo.upsertNodeState(state(`${sys}-b`, sys, 0, respawn));
    await repo.upsertNodeState(state(`${sys}-other`, 'another-system', 7));
    expect(await repo.listNodeStates(sys)).toEqual([
      state(`${sys}-a`, sys, 40),
      state(`${sys}-b`, sys, 0, respawn),
    ]);
    await repo.upsertNodeState(state(`${sys}-a`, sys, 12, respawn));
    expect((await repo.listNodeStates(sys))[0]).toEqual(state(`${sys}-a`, sys, 12, respawn));
    expect(await repo.listNodeStates('empty-system')).toEqual([]);
  });

  it('upserts large batches, last write wins for repeated ids', async () => {
    const { repo } = fx();
    const sys = `batch-${uniqueCallsign()}`;
    const states = Array.from({ length: 450 }, (_, i) => state(`${sys}-${i}`, sys, i));
    await repo.upsertNodeStates([...states, state(`${sys}-3`, sys, 999)]);
    const listed = await repo.listNodeStates(sys);
    expect(listed).toHaveLength(450);
    expect(listed.find((s) => s.nodeId === `${sys}-3`)?.quantityRemaining).toBe(999);
    await repo.upsertNodeStates([]);
  });

  it('rejects negative or fractional quantities', async () => {
    const { repo } = fx();
    await expect(repo.upsertNodeState(state('x', 's', -1))).rejects.toThrow();
    await expect(repo.upsertNodeState(state('x', 's', 1.5))).rejects.toThrow();
  });
});

describeBackends('system registry', (fx) => {
  it('upserts a system, flags its shard and stamps last activity', async () => {
    const { repo, clock } = fx();
    const systemId = `reg-${uniqueCallsign()}`;
    const created = await repo.upsertSystem({ systemId, name: 'Alpha' });
    expect(created).toEqual({ systemId, name: 'Alpha', shardActive: false, lastActiveAt: null });
    clock.advance(1000);
    const active = await repo.setShardActive(systemId, true);
    expect(active).toEqual({
      systemId,
      name: 'Alpha',
      shardActive: true,
      lastActiveAt: clock.now(),
    });
    const renamed = await repo.upsertSystem({ systemId, name: 'Beta' });
    expect(renamed).toMatchObject({ name: 'Beta', shardActive: true });
    expect((await repo.setShardActive(systemId, false)).shardActive).toBe(false);
    expect(await repo.getSystem(systemId)).toMatchObject({ name: 'Beta', shardActive: false });
  });

  it('raises NotFoundError for an unknown system and returns undefined on get', async () => {
    const { repo } = fx();
    await expect(repo.setShardActive('ghost', true)).rejects.toBeInstanceOf(NotFoundError);
    expect(await repo.getSystem('ghost')).toBeUndefined();
  });
});

describeBackends('transactions', (fx) => {
  it('commits everything on success', async () => {
    const { repo } = fx();
    const callsign = uniqueCallsign();
    const ship = await repo.transaction(async (tx) => {
      const player = await tx.createPlayer({ callsign, homeSystemId: 'sys' });
      const created = await tx.getOrCreateStarterShip(player.id);
      await tx.saveCargo(created.id, [{ resourceType: 'iron', quantity: 2 }]);
      return created;
    });
    expect((await repo.findPlayerByCallsign(callsign))?.id).toBe(ship.ownerId);
    expect(await repo.getCargo(ship.id)).toEqual([{ resourceType: 'iron', quantity: 2 }]);
  });

  it('rolls everything back when the callback throws', async () => {
    const { repo } = fx();
    const callsign = uniqueCallsign();
    await expect(
      repo.transaction(async (tx) => {
        await tx.createPlayer({ callsign, homeSystemId: 'sys' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await repo.findPlayerByCallsign(callsign)).toBeUndefined();
  });

  it('flattens nested transactions and does not interleave concurrent ones', async () => {
    const { repo } = fx();
    const player = await repo.createPlayer({ callsign: uniqueCallsign(), homeSystemId: 's' });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        repo.transaction((tx) => tx.transaction((inner) => inner.addCredits(player.id, 1))),
      ),
    );
    expect((await repo.getPlayer(player.id))?.credits).toBe(510);
  });
});
