import { expect, it } from 'vitest';
import { MAX_CREDITS } from './amounts.ts';
import {
  CallsignTakenError,
  InsufficientCreditsError,
  InvalidAmountError,
  NotFoundError,
} from './errors.ts';
import { describeBackends, uniqueCallsign } from './testing/backends.ts';

describeBackends('players and credits', (fx) => {
  const make = (credits?: number) =>
    fx().repo.createPlayer({
      callsign: uniqueCallsign(),
      homeSystemId: 'sys-home',
      ...(credits === undefined ? {} : { credits }),
    });

  it('creates a player with defaults and reads it back by id and callsign', async () => {
    const { repo, clock } = fx();
    clock.set(Date.UTC(2031, 4, 5, 6, 7, 8, 9));
    const created = await make();
    expect(created.credits).toBe(500);
    expect(created.homeSystemId).toBe('sys-home');
    expect(created.createdAt).toEqual(new Date(Date.UTC(2031, 4, 5, 6, 7, 8, 9)));
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await repo.getPlayer(created.id)).toEqual(created);
    expect(await repo.findPlayerByCallsign(created.callsign)).toEqual(created);
  });

  it('honours an explicit starting balance', async () => {
    expect((await make(1234)).credits).toBe(1234);
  });

  it('returns undefined for unknown players', async () => {
    const { repo } = fx();
    expect(await repo.getPlayer('nope')).toBeUndefined();
    expect(await repo.findPlayerByCallsign('nobody-here')).toBeUndefined();
  });

  it('raises CallsignTakenError for a duplicate callsign and keeps the original', async () => {
    const { repo } = fx();
    const first = await make();
    const duplicate = repo.createPlayer({ callsign: first.callsign, homeSystemId: 'other' });
    await expect(duplicate).rejects.toBeInstanceOf(CallsignTakenError);
    await expect(duplicate).rejects.toMatchObject({ callsign: first.callsign });
    expect((await repo.findPlayerByCallsign(first.callsign))?.id).toBe(first.id);
  });

  it('validates player input', async () => {
    const { repo } = fx();
    await expect(repo.createPlayer({ callsign: '', homeSystemId: 'x' })).rejects.toThrow();
    await expect(
      repo.createPlayer({ callsign: uniqueCallsign(), homeSystemId: 'x', credits: -1 }),
    ).rejects.toThrow();
  });

  it('adds and withdraws credits, returning the new balance', async () => {
    const { repo } = fx();
    const player = await make();
    expect(await repo.addCredits(player.id, 250)).toBe(750);
    expect(await repo.withdrawCredits(player.id, 700)).toBe(50);
    expect((await repo.getPlayer(player.id))?.credits).toBe(50);
    expect(await repo.withdrawCredits(player.id, 50)).toBe(0);
  });

  it('raises InsufficientCreditsError without changing the balance', async () => {
    const { repo } = fx();
    const player = await make(100);
    const attempt = repo.withdrawCredits(player.id, 101);
    await expect(attempt).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(attempt).rejects.toMatchObject({ requested: 101, balance: 100 });
    expect((await repo.getPlayer(player.id))?.credits).toBe(100);
  });

  it('raises NotFoundError for unknown players', async () => {
    const { repo } = fx();
    await expect(repo.addCredits('ghost', 5)).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.withdrawCredits('ghost', 5)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects the invalid amount %s',
    async (amount) => {
      const { repo } = fx();
      const player = await make();
      await expect(repo.addCredits(player.id, amount)).rejects.toBeInstanceOf(InvalidAmountError);
      await expect(repo.withdrawCredits(player.id, amount)).rejects.toBeInstanceOf(
        InvalidAmountError,
      );
      expect((await repo.getPlayer(player.id))?.credits).toBe(500);
    },
  );

  it('refuses additions that would overflow the maximum balance', async () => {
    const { repo } = fx();
    const player = await make(MAX_CREDITS - 5);
    await expect(repo.addCredits(player.id, 6)).rejects.toBeInstanceOf(InvalidAmountError);
    expect(await repo.addCredits(player.id, 5)).toBe(MAX_CREDITS);
  });

  it('is atomic: 100 concurrent withdrawals of 10 from 500 succeed exactly 50 times', async () => {
    const { repo } = fx();
    const player = await make(500);
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => repo.withdrawCredits(player.id, 10)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(50);
    expect(failed).toHaveLength(50);
    for (const r of failed) expect(r.reason).toBeInstanceOf(InsufficientCreditsError);
    expect((await repo.getPlayer(player.id))?.credits).toBe(0);
  });

  it('loses no updates under concurrent additions', async () => {
    const { repo } = fx();
    const player = await make(0);
    await Promise.all(Array.from({ length: 60 }, () => repo.addCredits(player.id, 7)));
    expect((await repo.getPlayer(player.id))?.credits).toBe(420);
  });

  it('never lets the balance go negative at the database level', async () => {
    const { handle } = fx();
    const player = await make(5);
    const { players } = handle.tables;
    const { eq, sql } = await import('drizzle-orm');
    await expect(
      handle.run((db) =>
        db
          .update(players)
          .set({ credits: sql`-1` })
          .where(eq(players.id, player.id)),
      ),
    ).rejects.toThrow();
  });
});
