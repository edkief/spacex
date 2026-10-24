import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { repo } from './repo';
import { db, schema, initDb } from './client';
import { migrate } from './client';
import { InsufficientCreditsError } from './types';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';

const TEST_DB_PATH = path.join('/tmp/opencode', 'credits_test.sqlite');

describe('Credits Repository Atomicity', () => {
  beforeEach(async () => {
    process.env.DB_DRIVER = 'sqlite';
    process.env.DB_PATH = TEST_DB_PATH;

    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    initDb();
    await migrate();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('should handle concurrent withdrawals atomically', async () => {
    const player = await repo.createPlayer('ConcurrencyAce', 'sol');

    // Starting balance is 500.
    // 100 withdrawals of 10 credits each.
    // Only 50 should succeed.

    const withdrawals = Array.from({ length: 100 }).map(() => repo.withdrawCredits(player.id, 10));

    const results = await Promise.allSettled(withdrawals);

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    expect(succeeded).toBe(50);
    expect(failed).toBe(50);

    const result = await db.select().from(schema.players).where(eq(schema.players.id, player.id));
    expect(result[0].credits).toBe(0);
  });

  it('should rollback on mid-failure in a transaction', async () => {
    const player = await repo.createPlayer('TxTest', 'sol');

    await expect(repo.withdrawCredits(player.id, 1000)).rejects.toThrow(InsufficientCreditsError);

    const result = await db.select().from(schema.players).where(eq(schema.players.id, player.id));
    expect(result[0].credits).toBe(500);
  });
});
