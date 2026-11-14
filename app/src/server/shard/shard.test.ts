import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listSpawnSystems } from '@shared/galaxy/spawn.ts';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import type { SystemGen } from '@shared/galaxy/types.ts';
import { distance } from '@shared/physics/vec.ts';
import { entityUpdateSchema, stateSnapshotSchema } from '@shared/protocol/world.ts';
import { openFixture, type Fixture } from '../db/testing/backends.ts';
import type { DirectoryPlayer } from '../directory.ts';
import { IDLE_INPUT } from './entities.ts';
import { SAVE_EVERY, Shard } from './shard.ts';

const SEED = 'drift-dev-seed-001';

/** The generated home system used by these tests (first eligible spawn system). */
function homeSystem(): SystemGen {
  const spawn = listSpawnSystems(SEED)[0]!;
  const star = generateStars(SEED).find(
    (candidate) => generateSystemForStar(SEED, candidate).systemId === spawn.systemId,
  )!;
  return generateSystemForStar(SEED, star);
}

type Sent = { type: string; payload: unknown };

describe('Shard', () => {
  let fixture: Fixture;
  const system = homeSystem();
  let n = 0;

  beforeAll(async () => {
    fixture = await openFixture('sqlite');
  });
  afterAll(async () => fixture.close());

  /** Creates a player with a starter ship and a recording sink. */
  async function pilot(): Promise<DirectoryPlayer & { sent: Sent[] }> {
    n += 1;
    const callsign = `SHARD-${n}`;
    const player = await fixture.repo.createPlayer({ callsign, homeSystemId: system.systemId });
    const ship = await fixture.repo.getOrCreateStarterShip(player.id);
    const sent: Sent[] = [];
    return {
      playerId: player.id,
      callsign,
      shipId: ship.id,
      sent,
      sink: { send: (type, payload) => sent.push({ type, payload }) },
    };
  }
  const newShard = () => new Shard({ seed: SEED, system, repo: fixture.repo });
  const run = (shard: Shard, ticks: number) => {
    for (let i = 0; i < ticks; i++) shard.tick();
  };
  const input = (seq: number, over: object = {}) => ({
    ...IDLE_INPUT,
    fire: false,
    lock: false,
    seq,
    ...over,
  });

  it('joins a new pilot docked at the system dock with a schema-valid snapshot', async () => {
    const shard = newShard();
    const me = await pilot();
    const snapshot = await shard.join(me);
    expect(stateSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.players).toEqual([
      { playerId: me.playerId, callsign: me.callsign, entityId: me.shipId },
    ]);
    const mine = snapshot.entities.find((entity) => entity.id === me.shipId)!;
    expect(mine.classId).toBe('scout');
    expect(mine.callsign).toBe(me.callsign);
    const docks = system.planets.flatMap((planet) => planet.docks);
    expect(docks.some((dock) => distance(dock.position, mine.pos) < 1e-6)).toBe(true);
    expect(shard.entity(me.shipId)!.state.dockedAt).toBeDefined();
  });

  it('holds a docked ship in place, then undocks and flies on input', async () => {
    const shard = newShard();
    const me = await pilot();
    await shard.join(me);
    const start = shard.entity(me.shipId)!.state.pos;
    shard.input(me.playerId, input(1, { thrust: 1 }));
    run(shard, 20);
    expect(distance(shard.entity(me.shipId)!.state.pos, start)).toBe(0);
    shard.input(me.playerId, input(2, { action: 'undock' }));
    shard.input(me.playerId, input(3, { thrust: 1 })); // same tick: the undock must not be lost
    run(shard, 40);
    const after = shard.entity(me.shipId)!.state;
    expect(after.dockedAt).toBeUndefined();
    expect(distance(after.pos, start)).toBeGreaterThan(50);
  });

  it('applies the latest input per tick and ignores stale sequence numbers', async () => {
    const shard = newShard();
    const me = await pilot();
    await shard.join(me);
    shard.input(me.playerId, input(5, { thrust: 1 }));
    shard.input(me.playerId, input(6, { thrust: -0.5 }));
    shard.input(me.playerId, input(4, { thrust: 1 })); // stale
    shard.input(me.playerId, input(6, { thrust: 1 })); // duplicate
    const entity = shard.entity(me.shipId)!;
    expect(entity.lastSeq).toBe(6);
    expect(entity.input.thrust).toBe(-0.5);
    shard.input('00000000-0000-4000-8000-000000000000', input(99)); // not a member: ignored
    expect(entity.lastSeq).toBe(6);
  });

  it('broadcasts entity updates every second tick with the recipient own lastInputSeq', async () => {
    const shard = newShard();
    const alpha = await pilot();
    const bravo = await pilot();
    await shard.join(alpha);
    await shard.join(bravo);
    alpha.sent.length = 0;
    bravo.sent.length = 0;
    shard.input(alpha.playerId, input(7));
    run(shard, 10);
    const updates = (sent: Sent[]) => sent.filter((message) => message.type === 'entity_update');
    expect(updates(alpha.sent)).toHaveLength(5);
    expect(updates(bravo.sent)).toHaveLength(5);
    const first = updates(alpha.sent)[0]!.payload as { tick: number; lastInputSeq: number };
    expect(entityUpdateSchema.safeParse(first).success).toBe(true);
    expect(first.tick % 2).toBe(0);
    expect(first.lastInputSeq).toBe(7);
    expect((updates(bravo.sent)[0]!.payload as { lastInputSeq: number }).lastInputSeq).toBe(0);
    expect((first as unknown as { entities: unknown[] }).entities).toHaveLength(2);
  });

  it('announces joins and leaves to the others, and keeps abandoned ships in the sim', async () => {
    const shard = newShard();
    const alpha = await pilot();
    const bravo = await pilot();
    await shard.join(alpha);
    await shard.join(bravo);
    expect(alpha.sent.find((message) => message.type === 'presence')?.payload).toEqual({
      joined: [{ playerId: bravo.playerId, callsign: bravo.callsign, entityId: bravo.shipId }],
      left: [],
    });
    expect(bravo.sent.some((message) => message.type === 'presence')).toBe(false);
    await shard.leave(bravo.playerId, bravo.sink);
    expect(alpha.sent.at(-1)).toEqual({
      type: 'presence',
      payload: { joined: [], left: [bravo.playerId] },
    });
    expect(shard.playerCount).toBe(1);
    expect(shard.entity(bravo.shipId)).toBeDefined();
    expect(shard.snapshot(alpha.playerId).entities).toHaveLength(2);
  });

  it('keeps a player with two sockets present until the last one leaves', async () => {
    const shard = newShard();
    const me = await pilot();
    const second = { send: () => undefined };
    await shard.join(me);
    await shard.join({ ...me, sink: second });
    expect(shard.playerCount).toBe(1);
    await shard.leave(me.playerId, second);
    expect(shard.playerCount).toBe(1);
    await shard.leave(me.playerId, me.sink);
    expect(shard.playerCount).toBe(0);
  });

  it('saves a ship on leave and restores its position in a fresh shard', async () => {
    const shard = newShard();
    const me = await pilot();
    await shard.join(me);
    shard.input(me.playerId, input(1, { action: 'undock' }));
    shard.input(me.playerId, input(2, { thrust: 1 }));
    run(shard, 60);
    const flown = shard.entity(me.shipId)!.state;
    await shard.leave(me.playerId, me.sink);
    const stored = await fixture.repo.getShip(me.shipId);
    expect(stored!.state).toBe('flying');
    expect(stored!.position).toMatchObject({ systemId: system.systemId, frame: 'system' });

    const restored = newShard();
    await restored.join(me);
    const state = restored.entity(me.shipId)!.state;
    expect(distance(state.pos, flown.pos)).toBeLessThan(1e-6);
    expect(distance(state.vel, flown.vel)).toBeLessThan(1e-6);
    expect(state.dockedAt).toBeUndefined();
  });

  it('saves dirty ships on the 5 s interval and everything on flush', async () => {
    const shard = newShard();
    const me = await pilot();
    await shard.join(me);
    shard.input(me.playerId, input(1, { action: 'undock' }));
    run(shard, SAVE_EVERY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await fixture.repo.getShip(me.shipId))!.state).toBe('flying');
    const before = (await fixture.repo.getShip(me.shipId))!.position;
    run(shard, 10);
    await shard.flush();
    const after = (await fixture.repo.getShip(me.shipId))!.position;
    expect(after.x === before.x && after.y === before.y && after.z === before.z).toBe(false);
  });

  it('ticks 16 flying ships well inside the 30 ms budget (p95)', async () => {
    const shard = newShard();
    const pilots = [];
    for (let i = 0; i < 16; i++) pilots.push(await pilot());
    for (const p of pilots) await shard.join(p);
    pilots.forEach((p, i) => {
      shard.input(p.playerId, input(1, { action: 'undock' }));
      shard.input(p.playerId, input(2, { thrust: 1, yaw: (i % 5) / 5 - 0.4, pitch: 0.1 }));
    });
    run(shard, 50);
    const durations: number[] = [];
    for (let i = 0; i < 400; i++) {
      const started = performance.now();
      shard.tick();
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)]!;
    console.log(
      `shard tick, 16 ships: median ${durations[200]!.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`,
    );
    expect(p95).toBeLessThan(30);
  });
});
