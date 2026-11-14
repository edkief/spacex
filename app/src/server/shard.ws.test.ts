import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entityUpdateSchema } from '@shared/protocol/world.ts';
import { startTestServer, type ClaimedPlayer, type TestServer } from './testing/testServer.ts';
import type { TestClient } from './testing/wsClient.ts';

describe('live sim over the socket (real shards, real timers)', () => {
  let server: TestServer;
  const open: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer({ shards: true });
  });
  afterAll(async () => {
    open.forEach((client) => client.close());
    await server.close();
  });

  /** Claims a callsign and brings a socket all the way into `systemId` (default: home). */
  async function enter(callsign: string, systemId?: string) {
    const me: ClaimedPlayer = await server.claim(callsign);
    const client = await server.connect();
    open.push(client);
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    client.send('auth', { token: me.token });
    await client.expect('auth_ok');
    client.send('join_system', { systemId: systemId ?? me.homeSystemId });
    const entered = await client.expect('enter_system');
    return { me, client, entered };
  }

  /** Reads messages until one of `type` satisfies `match`. */
  async function until(client: TestClient, type: string, match: (payload: never) => boolean) {
    for (let i = 0; i < 400; i++) {
      const message = await client.next();
      if (message.type === type && match(message.payload as never)) return message.payload;
    }
    throw new Error(`no matching ${type}`);
  }
  const idle = {
    thrust: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    up: 0,
    brake: false,
    fire: false,
    lock: false,
  };

  it('enters with the own ship in the snapshot and receives 10 Hz entity updates', async () => {
    const { me, client, entered } = await enter('SIM-ALPHA');
    const snapshot = entered['snapshot'] as { entities: { id: string }[] };
    expect(snapshot.entities.map((entity) => entity.id)).toContain(me.shipId);
    const update = await until(client, 'entity_update', () => true);
    expect(entityUpdateSchema.safeParse(update).success).toBe(true);
  });

  it('moves the ship in response to inputs and echoes the applied seq', async () => {
    const { me, client } = await enter('SIM-BRAVO');
    client.send('input', { ...idle, seq: 1, action: 'undock' });
    for (let seq = 2; seq <= 12; seq++) {
      client.send('input', { ...idle, seq, thrust: 1, action: 'none' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    type Update = {
      lastInputSeq: number;
      entities: { id: string; vel: { x: number; y: number; z: number } }[];
    };
    const update = (await until(
      client,
      'entity_update',
      (payload: Update) => payload.lastInputSeq >= 12,
    )) as Update;
    const mine = update.entities.find((entity) => entity.id === me.shipId)!;
    expect(Math.hypot(mine.vel.x, mine.vel.y, mine.vel.z)).toBeGreaterThan(10);
  });

  it('shows two pilots in the same system to each other, with presence on join and leave', async () => {
    const first = await enter('SIM-CHARLIE');
    const second = await enter('SIM-DELTA', first.me.homeSystemId);
    const joined = (await until(first.client, 'presence', () => true)) as {
      joined: { callsign: string }[];
    };
    expect(joined.joined.map((player) => player.callsign)).toEqual(['SIM-DELTA']);
    type Update = { entities: { id: string }[] };
    const update = (await until(second.client, 'entity_update', () => true)) as Update;
    expect(update.entities.map((entity) => entity.id)).toEqual(
      expect.arrayContaining([first.me.shipId, second.me.shipId]),
    );
    second.client.close();
    const left = (await until(
      first.client,
      'presence',
      (payload: { left: string[] }) => payload.left.length > 0,
    )) as { left: string[] };
    expect(left.left).toEqual([second.me.playerId]);
  });
});
