import { describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { stateSnapshotSchema } from '@shared/protocol/world.ts';
import { createGalaxyDirectory } from './directory.ts';

const SEED = 'drift-dev-seed-001';
const ids = generateStars(SEED).map((star) => generateSystemForStar(SEED, star).systemId);
const player = (n: number) => ({ playerId: `p${n}`, callsign: `PILOT-${n}`, shipId: `s${n}` });

describe('galaxy system directory (stub)', () => {
  it('joins real systems of the seed with an empty, schema-valid snapshot', async () => {
    const directory = createGalaxyDirectory({ seed: SEED });
    const result = await directory.join(ids[3]!, player(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stateSnapshotSchema.safeParse(result.snapshot).success).toBe(true);
    expect(result.snapshot).toMatchObject({ systemId: ids[3], entities: [], players: [] });
  });

  it('rejects ids that are not systems of this galaxy', async () => {
    const directory = createGalaxyDirectory({ seed: SEED });
    for (const id of ['0000000000000000', 'ffffffffffffffff', 'nope', '']) {
      expect(await directory.join(id, player(1))).toMatchObject({
        ok: false,
        code: 'system-not-found',
      });
    }
  });

  it('knows only its own seed’s galaxy', async () => {
    const other = createGalaxyDirectory({ seed: 'another-seed' });
    expect(await other.join(ids[0]!, player(1))).toMatchObject({
      ok: false,
      code: 'system-not-found',
    });
  });

  it('enforces capacity, lets a rejoining player in, and frees a slot on leave', async () => {
    const directory = createGalaxyDirectory({ seed: SEED, capacity: 2 });
    const id = ids[1]!;
    expect((await directory.join(id, player(1))).ok).toBe(true);
    expect((await directory.join(id, player(2))).ok).toBe(true);
    expect(await directory.join(id, player(3))).toMatchObject({ ok: false, code: 'system-full' });
    expect((await directory.join(id, player(1))).ok).toBe(true);
    await directory.leave(id, 'p2');
    expect((await directory.join(id, player(3))).ok).toBe(true);
    expect((await directory.join(ids[2]!, player(4))).ok).toBe(true);
  });
});
