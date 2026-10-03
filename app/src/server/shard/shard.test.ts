import { afterEach, describe, expect, it, vi } from 'vitest';

import { generatePlanet, generateSystem } from '@shared/galaxy/system';
import { generateStars } from '@shared/galaxy/stars';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { planetAnchor } from '@shared/galaxy/planets';
import { CELL_SIZE_M, CHUNK_SIZE } from '@shared/galaxy/surface';
import {
  integrateShip,
  restShipState,
  type LandingPadRef,
  type ShipInput,
  type ShipState,
} from '@shared/physics/flight';
import { shipStats } from '@shared/ships';
import type { EntityState, InputPayload } from '@shared/protocol/schemas';

import { decodeMessage } from '@shared/protocol';
import { CHAT_HISTORY_MAX } from '@shared/chat';
import { entityToState, SystemShard, TICK_DT_MS } from './shard';
import { TerrainContext } from './terrain';
import type { SimEntity } from './types';

/**
 * SystemShard unit tests (TASK-13, steps 2-5): latest-input-wins, stale seq
 * protection, 10 Hz snapshot cadence, regime context over chunk-cached
 * terrain, tick histogram, and the 16-ship p95 < 30 ms tick benchmark.
 * The sim loop runs on fake timers; performance.now() still measures real
 * per-tick CPU for the histogram.
 */

const SEED = 'shard-test-seed';

/** A deterministic system for the tests: first star, real generation. */
function testSystem(): SystemGen {
  const star = generateStars(SEED, 4)[0];
  return generateSystem(SEED, star.id);
}

/** A planet with atmosphere (search the first 16 slots; deterministic). */
function atmospherePlanet(): Planet {
  for (let i = 0; i < 16; i++) {
    const p = generatePlanet(SEED, 'atmo-star', i);
    if (p.hasAtmosphere) return p;
  }
  throw new Error('no atmosphere planet in first 16 slots (deterministic seed!)');
}

/** Find a landable planet with a landing pad in chunk (0,0) — always 1 pad. */
function landablePlanet(): Planet {
  for (let i = 0; i < 16; i++) {
    const p = generatePlanet(SEED, 'land-star', i);
    if (p.landable) return p;
  }
  throw new Error('no landable planet in first 16 slots (deterministic seed!)');
}

function makeShard(system: SystemGen = testSystem()): SystemShard {
  return new SystemShard({
    systemId: system.systemId,
    galaxySeed: SEED,
    system,
    repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: { debug() {}, warn() {}, info() {} },
  });
}

/** Fake in-system connection; returns the send log. */
function addFakeConn(shard: SystemShard, playerId: string, callsign: string): { sends: string[] } {
  const sends: string[] = [];
  shard.registerConnection(playerId, callsign, (buffer) => {
    sends.push(buffer);
  });
  return { sends };
}

function makeEntity(
  playerId: string,
  pos: { x: number; y: number; z: number },
  opts: { classId?: string; regime?: 'space' | 'atmosphere'; planetId?: string } = {},
): SimEntity {
  const classId = opts.classId ?? 'scout';
  return {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId,
    classId,
    ship: restShipState(pos, opts.regime ?? 'space'),
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    ...(opts.planetId ? { planetId: opts.planetId } : {}),
  };
}

function input(seq: number, partial: Partial<InputPayload> = {}): InputPayload {
  return {
    seq,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    ...partial,
  };
}

/** Ship state after `n` ticks of `inp` from `start` (reference integration). */
function reference(
  start: ShipState,
  inp: ShipInput,
  n: number,
  regime: 'space' | 'atmosphere',
): ShipState {
  let s = start;
  for (let i = 0; i < n; i++) {
    s = integrateShip(s, inp, TICK_DT_MS / 1000, regime, undefined, 'scout');
  }
  return s;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemShard input queue (TASK-13 step 2)', () => {
  it('latest input per player wins: only the newest enqueued frame integrates', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    const entity = makeEntity('p1', { x: 0, y: 0, z: 0 });
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Alpha');

    // seq 1: yaw only (rotates, no translation). seq 2: full thrust (moves).
    // seq 3: roll only. If ALL three integrated, the ship would have moved
    // along +Z; latest-wins means only seq 3 applies (no thrust → no motion).
    expect(shard.enqueueInput('p1', input(1, { yaw: 1 }))).toBe(true);
    expect(shard.enqueueInput('p1', input(2, { thrust: 1 }))).toBe(true);
    expect(shard.enqueueInput('p1', input(3, { turn: 1 }))).toBe(true);
    const start = {
      ...entity.ship,
      pos: { ...entity.ship.pos },
      vel: { ...entity.ship.vel },
      quat: { ...entity.ship.quat },
    };

    shard.start();
    vi.advanceTimersByTime(TICK_DT_MS); // exactly one tick

    expect(entity.ship.pos).toEqual({ x: 0, y: 0, z: 0 }); // seq 2 did NOT integrate
    const expected = integrateShip(
      start,
      { thrust: 0, yaw: 0, pitch: 0, roll: 1, up: 0 },
      TICK_DT_MS / 1000,
      'space',
      undefined,
      'scout',
    );
    // Quat rotated by exactly one tick of roll (bit-identical to the model).
    expect(entity.ship.quat.x).toBeCloseTo(expected.quat.x, 12);
    expect(entity.ship.quat.z).toBeCloseTo(expected.quat.z, 12);
    shard.stop();
  });

  it('stale seq is ignored (out-of-order protection) and logged as a drop', () => {
    vi.useFakeTimers();
    const drops: string[] = [];
    const shard = new SystemShard({
      systemId: testSystem().systemId,
      galaxySeed: SEED,
      system: testSystem(),
      repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
      shipSwapBus: {
        emitSwap() {},
        onSwap: () => () => {},
        emitLivery() {},
        onLivery: () => () => {},
      },
      log: { debug: (msg) => drops.push(msg), warn() {}, info() {} },
    });
    const entity = makeEntity('p1', { x: 0, y: 0, z: 0 });
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Alpha');
    const conn = [...shard.connections.values()][0];

    expect(shard.enqueueInput('p1', input(5, { thrust: 1 }))).toBe(true);
    expect(shard.enqueueInput('p1', input(3, { thrust: 0, yaw: 1 }))).toBe(false); // stale
    expect(conn.lastSeq).toBe(5);
    expect(drops.some((m) => m.includes('stale'))).toBe(true); // logged at debug

    const start = {
      ...entity.ship,
      pos: { ...entity.ship.pos },
      vel: { ...entity.ship.vel },
      quat: { ...entity.ship.quat },
    };
    shard.start();
    vi.advanceTimersByTime(TICK_DT_MS);
    // Integrated from seq 5 (thrust 1): half-step offset ½·a·dt² along +Z.
    const expected = reference(start, { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0 }, 1, 'space');
    expect(entity.ship.pos.z).toBeCloseTo(expected.pos.z, 12);
    expect(entity.ship.pos.z).toBeGreaterThan(0);
    shard.stop();
  });

  it('input for an unknown player is dropped', () => {
    const shard = makeShard();
    expect(shard.enqueueInput('nobody', input(1))).toBe(false);
  });
});

describe('SystemShard snapshots (TASK-13 step 3)', () => {
  it('broadcasts entity_update exactly 10 Hz: once every 2nd tick, shared buffer', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    const entity = makeEntity('p1', { x: 1, y: 2, z: 3 });
    entity.callsign = 'Alpha';
    entity.hull = 0.5;
    entity.shields = 0.25;
    shard.addEntity(entity);
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    shard.start();
    // 20 ticks = 1000 ms → exactly 10 snapshots (10 Hz).
    vi.advanceTimersByTime(20 * TICK_DT_MS);
    expect(sends).toHaveLength(10);
    // One more tick (odd) must NOT broadcast.
    vi.advanceTimersByTime(TICK_DT_MS);
    expect(sends).toHaveLength(10);
    shard.stop();

    const parsed = JSON.parse(sends[0]) as { type: string; payload: { entities: EntityState[] } };
    expect(parsed.type).toBe('entity_update');
    // TASK-40: the shard now also spawns station terminal entities, so target
    // the ship by id instead of assuming it is the first entity in the buffer.
    const e = parsed.payload.entities.find((x) => x.id === 'ship-p1')!;
    expect(e).toBeDefined();
    expect(e.kind).toBe('ship');
    expect(e.classId).toBe('scout');
    expect(e.callsign).toBe('Alpha');
    expect(e.hull).toBe(0.5); // combat-ready state on the wire
    expect(e.shields).toBe(0.25);
    expect(e.targetId).toBeNull();
    // TASK-14: orientation on the wire (reconciliation angle + remote slerp).
    expect(e.rot).toEqual({ x: 0, y: 0, z: 0, w: 1 }); // at rest → identity
    // Every frame is the same serialized buffer (serialize once, share).
    expect(new Set(sends).size).toBe(1);
  });

  it('fan-out is per-system: only in-system connections receive snapshots', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    const mine = addFakeConn(shard, 'p1', 'Alpha');
    const other = addFakeConn(shard, 'p2', 'Beta');
    shard.addEntity(makeEntity('p2', { x: 9, y: 9, z: 9 }));

    shard.start();
    vi.advanceTimersByTime(2 * TICK_DT_MS); // one snapshot
    expect(mine.sends).toHaveLength(1);
    expect(other.sends).toHaveLength(1); // both are in-system conns → both get it

    // Remove the second connection: only the survivor receives snapshots.
    shard.unregisterConnection('c2');
    vi.advanceTimersByTime(2 * TICK_DT_MS);
    expect(mine.sends).toHaveLength(2);
    expect(other.sends).toHaveLength(1); // stale conn never receives again
    shard.stop();
  });

  it('no broadcast when the system has entities but no connections', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    shard.start();
    vi.advanceTimersByTime(10 * TICK_DT_MS);
    expect(shard.connections.size).toBe(0);
    // No connections → no sends anywhere (nothing to assert on), and the
    // tick still ran (histogram filled) without a broadcast.
    expect(shard.histogram.sampleCount).toBe(10);
    shard.stop();
  });
});

describe('SystemShard input acks (TASK-14 step 2)', () => {
  it('acks the APPLIED seq at snapshot cadence, only when it advanced', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    shard.start();
    vi.advanceTimersByTime(2 * TICK_DT_MS); // snapshot 1, no input → no ack
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]).type).toBe('entity_update');

    // seq 7 enqueued; applied on the next tick.
    expect(shard.enqueueInput('p1', input(7, { thrust: 1 }))).toBe(true);
    vi.advanceTimersByTime(2 * TICK_DT_MS); // snapshot 2 → ack 7
    const ackSeqs = sends
      .filter((s) => JSON.parse(s).type === 'ack')
      .map((s) => (JSON.parse(s) as { payload: { seq: number } }).payload.seq);
    expect(ackSeqs).toEqual([7]);

    // No new input: no duplicate ack at the next snapshot.
    vi.advanceTimersByTime(2 * TICK_DT_MS);
    expect(sends.filter((s) => JSON.parse(s).type === 'ack')).toHaveLength(1);

    // A newer applied input acks again (monotonic advance).
    shard.enqueueInput('p1', input(9, { thrust: 1 }));
    vi.advanceTimersByTime(2 * TICK_DT_MS);
    const seqs = sends
      .filter((s) => JSON.parse(s).type === 'ack')
      .map((s) => (JSON.parse(s) as { payload: { seq: number } }).payload.seq);
    expect(seqs).toEqual([7, 9]);
    shard.stop();
  });

  it('stale (dropped) inputs never ack: appliedSeq only moves on applied seqs', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');
    shard.start();

    shard.enqueueInput('p1', input(5, { thrust: 1 }));
    expect(shard.enqueueInput('p1', input(3, { thrust: 1 }))).toBe(false); // stale
    vi.advanceTimersByTime(4 * TICK_DT_MS);
    const seqs = sends
      .filter((s) => JSON.parse(s).type === 'ack')
      .map((s) => (JSON.parse(s) as { payload: { seq: number } }).payload.seq);
    expect(seqs).toEqual([5]);
    shard.stop();
  });

  it('acks go only to the owning connection (per-conn message, shared buffer intact)', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    shard.addEntity(makeEntity('p2', { x: 9, y: 0, z: 0 }));
    const mine = addFakeConn(shard, 'p1', 'Alpha');
    const other = addFakeConn(shard, 'p2', 'Beta');
    shard.start();

    shard.enqueueInput('p1', input(2, { thrust: 1 }));
    vi.advanceTimersByTime(2 * TICK_DT_MS);
    // Only p1's conn gets the ack; p2 sees the shared snapshot, no ack.
    expect(mine.sends.map((s) => JSON.parse(s).type)).toEqual(['entity_update', 'ack']);
    expect(other.sends.map((s) => JSON.parse(s).type)).toEqual(['entity_update']);
    // And the shared snapshot buffer is still byte-identical across conns.
    expect(mine.sends[0]).toBe(other.sends[0]);
    shard.stop();
  });
});

describe('SystemShard regime context (TASK-13 step 2, atmosphere)', () => {
  it('integrates atmosphere ships against chunk-cached terrain (O(1) heightAt)', () => {
    vi.useFakeTimers();
    const planet = atmospherePlanet();
    const system = {
      ...testSystem(),
      planets: [planet],
    } as SystemGen;
    const shard = makeShard(system);
    // Spawn 150 m above the local terrain (planet amplitudes scale with
    // radius — gas worlds can be hundreds of metres of relief), no pad
    // nearby: the ship free-falls under gravity + quadratic drag.
    // Spawn ~57 u from the planet anchor (10000, 0) so the per-tick
    // resolveRegime keeps the ship inside the 1000 u atmosphere boundary.
    const probe = new TerrainContext(SEED, planet);
    probe.update(10040, 40);
    const startY = probe.heightAt(10040, 40) + 150;
    const entity = makeEntity(
      'p1',
      { x: 10040, y: startY, z: 40 },
      { regime: 'atmosphere', planetId: planet.id },
    );
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Faller');
    // Thrust 0, up 0: pure gravity + drag.
    expect(shard.enqueueInput('p1', input(1))).toBe(true);

    shard.start();
    vi.advanceTimersByTime(50 * TICK_DT_MS); // 50 ticks = 2.5 s of falling

    // Terrain context mirrors what the shard used: same seed + planet.
    const terrain = new TerrainContext(SEED, planet);
    terrain.update(entity.ship.pos.x, entity.ship.pos.z);
    const ground = terrain.heightAt(entity.ship.pos.x, entity.ship.pos.z);
    expect(entity.ship.pos.y).toBeLessThan(startY); // fell
    expect(entity.ship.pos.y).toBeGreaterThanOrEqual(ground - 1e-6); // no tunneling
    shard.stop();
  });

  it('VTOL lift (action: vtol) settles a ship on the pad', () => {
    vi.useFakeTimers();
    const planet = landablePlanet();
    const system = { ...testSystem(), planets: [planet] } as SystemGen;
    const shard = makeShard(system);
    const terrain = new TerrainContext(SEED, planet);
    // The atmosphere is a 1000 u disc around the planet anchor (10000, 0),
    // so cache the anchor's chunk neighborhood and take the closest pad to
    // it (pads are a 25% per-chunk roll; deterministically walk nearby
    // 320 m chunks until one lands a pad).
    const anchor = planetAnchor(0);
    const step = CHUNK_SIZE * CELL_SIZE_M; // 320 m per chunk
    let pad: LandingPadRef | undefined;
    let best = Infinity;
    outer: for (let r = 0; r < 4; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          terrain.update(anchor.x + dx * step, anchor.z + dz * step);
          for (const p of terrain.pads()) {
            const d = Math.hypot(p.x - anchor.x, p.z - anchor.z);
            if (d < best) {
              best = d;
              pad = p;
            }
          }
        }
      }
      if (pad) break outer;
    }
    expect(pad).toBeDefined();
    const chosen = pad as LandingPadRef;
    const ground = terrain.heightAt(chosen.x, chosen.z);

    // Descending toward the pad (VTOL lift is neutral at up=1, so the ship
    // must arrive with downward velocity and settle via ground clamp + drag).
    const entity = makeEntity(
      'p1',
      { x: chosen.x, y: ground + 10, z: chosen.z },
      { regime: 'atmosphere', planetId: planet.id },
    );
    entity.ship.vel = { x: 0, y: -5, z: 0 };
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Hover');

    shard.start();
    // Phase 1: throttle down (no lift) to reach the surface.
    for (let i = 1; i <= 40; i++) {
      shard.enqueueInput('p1', input(i));
      vi.advanceTimersByTime(TICK_DT_MS);
    }
    // Phase 2: full VTOL lift — hover converges to vel.y = 0 on the pad.
    for (let i = 41; i <= 140; i++) {
      shard.enqueueInput('p1', input(i, { action: 'vtol' }));
      vi.advanceTimersByTime(TICK_DT_MS);
    }
    // Settled on the pad within tolerance.
    expect(Math.abs(entity.ship.pos.y - ground)).toBeLessThan(0.5);
    expect(Math.abs(entity.ship.vel.y)).toBeLessThan(1);
    expect(entity.ship.onPad).toBe(chosen.id);
    // The snapshot now reports the docked wire regime (target the ship: the
    // shard also broadcasts station terminal entities — TASK-40).
    const ship = shard.snapshot().find((s) => s.kind === 'ship')!;
    expect(ship.regime).toBe('docked');
    shard.stop();
  });
});

describe('SystemShard timing (TASK-13 step 4)', () => {
  it('records every tick into the histogram', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.start();
    vi.advanceTimersByTime(25 * TICK_DT_MS);
    expect(shard.histogram.sampleCount).toBe(25);
    expect(shard.histogram.percentile(0.95)).toBeGreaterThan(0);
    expect(Number.isFinite(shard.histogram.percentile(0.95))).toBe(true);
    shard.stop();
  });

  it('tick budget: p95 < 30 ms with 16 ships and varied inputs over 60 s simulated', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    const classes = ['scout', 'freighter', 'interceptor'] as const;
    // 16 ships with varied, sustained inputs.
    for (let i = 0; i < 16; i++) {
      const pid = `p${i}`;
      const entity = makeEntity(pid, { x: i * 100, y: 0, z: -i * 50 }, { classId: classes[i % 3] });
      shard.addEntity(entity);
      addFakeConn(shard, pid, `Pilot-${i}`);
    }
    const varied: Array<Partial<InputPayload>> = [
      { thrust: 1, yaw: 1 },
      { thrust: 1, pitch: -1 },
      { thrust: -1, turn: 1 },
      { thrust: 0.5, yaw: 0.25, pitch: 0.5, turn: -0.5 },
    ];
    shard.start();
    // 60 s simulated = 1200 ticks; enqueue a varied input every tick so all
    // 16 ships keep integrating (inputs are consumed once per tick).
    for (let t = 1; t <= 1200; t++) {
      for (let i = 0; i < 16; i++) {
        shard.enqueueInput(`p${i}`, input(t, varied[i % varied.length]));
      }
      vi.advanceTimersByTime(TICK_DT_MS);
    }
    shard.stop();

    expect(shard.sim.tickNumber).toBe(1200);
    expect(shard.histogram.sampleCount).toBe(1200);
    const p50 = shard.histogram.percentile(0.5);
    const p95 = shard.histogram.percentile(0.95);
    const p99 = shard.histogram.percentile(0.99);
    console.log(
      `TASK-13 tick benchmark (16 ships, 1200 ticks): p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
    );
    expect(p95).toBeLessThan(30); // spec budget
    expect(p99).toBeLessThan(30);
  }, 30_000);
});

describe('entityToState mapping', () => {
  it('docked ships and pad-settled ships report the docked wire regime', () => {
    const e = makeEntity('p1', { x: 0, y: 0, z: 0 });
    e.docked = true;
    expect(entityToState(e).regime).toBe('docked');
    e.docked = false;
    e.ship = { ...e.ship, onPad: 'pad-0' };
    expect(entityToState(e).regime).toBe('docked');
    e.ship = { ...e.ship, onPad: undefined };
    expect(entityToState(e).regime).toBe('sublight');
  });

  it('class stats normalize hull/shields at spawn', () => {
    const shard = makeShard();
    const entity = makeEntity('p1', { x: 0, y: 0, z: 0 });
    const cls = shipStats(entity.classId);
    entity.hull = Math.min(1, cls.hull > 0 ? 10 / cls.hull : 0);
    shard.addEntity(entity);
    // Target the ship: the shard also contains station terminal entities (TASK-40).
    const state = shard.snapshot().find((s) => s.kind === 'ship')!;
    expect(state.hull).toBeCloseTo(10 / cls.hull, 12);
  });
});

describe('SystemShard system chat (TASK-16)', () => {
  function chatFrames(sends: string[]): Array<{ from: string; text: string; ts: number }> {
    return sends
      .map((b) => decodeMessage(b))
      .filter(
        (d): d is { ok: true; envelope: { v: number; type: string; payload: unknown } } =>
          d.ok && d.envelope.type === 'chat',
      )
      .map((d) => d.envelope.payload as { from: string; text: string; ts: number });
  }

  it('broadcasts to the WHOLE shard (sender echo included) with server ts', () => {
    const shard = makeShard();
    const a = addFakeConn(shard, 'p1', 'ALPHA');
    const b = addFakeConn(shard, 'p2', 'BRAVO');
    shard.handleChat('ALPHA', 'hello');
    expect(a.sends).toHaveLength(1); // sender echo
    expect(b.sends).toHaveLength(1); // whole shard
    expect(chatFrames(a.sends)).toEqual(chatFrames(b.sends));
    const [m] = chatFrames(a.sends);
    expect(m.from).toBe('ALPHA');
    expect(m.text).toBe('hello');
    expect(m.ts).toBeGreaterThanOrEqual(Date.now() - 5_000);
  });

  it('ts is strictly monotonic even for same-millisecond sends', () => {
    const shard = makeShard();
    const a = addFakeConn(shard, 'p1', 'ALPHA');
    for (let i = 0; i < 5; i++) shard.handleChat('ALPHA', `m${i}`);
    const ts = chatFrames(a.sends).map((m) => m.ts);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it('keeps a 100-message ring buffer exposed to join snapshots', () => {
    const shard = makeShard();
    const a = addFakeConn(shard, 'p1', 'ALPHA');
    for (let i = 0; i < CHAT_HISTORY_MAX + 20; i++) shard.handleChat('ALPHA', `m${i}`);
    const history = shard.chatHistory();
    expect(history).toHaveLength(CHAT_HISTORY_MAX);
    expect(history[0].text).toBe('m20');
    expect(history[history.length - 1].text).toBe(`m${CHAT_HISTORY_MAX + 19}`);
    expect(a.sends).toHaveLength(CHAT_HISTORY_MAX + 20); // broadcast is uncapped
  });
});

describe('SystemShard reconnect and idle continuation (TASK-17)', () => {
  /** Shard with a debug-log capture (stale drops are logged at debug). */
  function makeLoggedShard(): { shard: SystemShard; debugs: string[] } {
    const debugs: string[] = [];
    const shard = new SystemShard({
      systemId: testSystem().systemId,
      galaxySeed: SEED,
      system: testSystem(),
      repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
      shipSwapBus: {
        emitSwap() {},
        onSwap: () => () => {},
        emitLivery() {},
        onLivery: () => () => {},
      },
      log: { debug: (msg) => debugs.push(msg), warn() {}, info() {} },
    });
    return { shard, debugs };
  }

  it('idle continuation: an owner-less ship keeps simulating (coasts on zero input)', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    const entity = makeEntity('p1', { x: 0, y: 0, z: 0 });
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Alpha');

    // One tick of full thrust: the ship picks up velocity along +Z.
    expect(shard.enqueueInput('p1', input(1, { thrust: 1 }))).toBe(true);
    shard.start();
    vi.advanceTimersByTime(TICK_DT_MS);
    const velAfter = { ...entity.ship.vel };
    expect(velAfter.z).toBeGreaterThan(0);

    // The owner drops: held frame cleared, the ship goes IDLE (still in the world).
    shard.leavePlayer('p1');
    expect(shard.connections.size).toBe(0);
    expect(entity.idle).toBe(true);
    expect(entity.heldInput).toBeUndefined();

    // The sim keeps living while the shard lives: 10 more ticks of zero
    // input must integrate the coast exactly like the shared flight model.
    const posAtLeave = { ...entity.ship.pos };
    vi.advanceTimersByTime(10 * TICK_DT_MS);
    const expected = integrateShip(
      { pos: posAtLeave, vel: velAfter, quat: { ...entity.ship.quat }, regime: 'space' },
      { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 },
      10 * (TICK_DT_MS / 1000),
      'space',
      undefined,
      'scout',
    );
    expect(entity.ship.pos.z).toBeCloseTo(expected.pos.z, 9);
    expect(entity.ship.pos.z).toBeGreaterThan(posAtLeave.z); // it MOVED while idle
    expect(entity.heldInput).toBeUndefined();

    // Inputs for an idle ship (no live connection) are dropped.
    expect(shard.enqueueInput('p1', input(2, { thrust: 1 }))).toBe(false);
    shard.stop();
  });

  it('reconnect re-adopts the SAME entity: no duplicate, ship un-idles', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    const entity = makeEntity('p1', { x: 0, y: 0, z: 0 });
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Alpha');
    expect(shard.enqueueInput('p1', input(1, { thrust: 1 }))).toBe(true);
    shard.start();
    vi.advanceTimersByTime(TICK_DT_MS);

    shard.leavePlayer('p1');
    expect(entity.idle).toBe(true);
    const posAtDrop = { ...entity.ship.pos };
    vi.advanceTimersByTime(20 * TICK_DT_MS); // idle drift

    // The player reconnects: a NEW connection is registered for the same
    // player — the entity map must not grow (no duplicate entity; TASK-37:
    // the map also holds the seeded deposits, so compare sizes, not a 1).
    const sizeBeforeReconnect = shard.entities.size;
    addFakeConn(shard, 'p1', 'Alpha');
    expect(shard.entities.size).toBe(sizeBeforeReconnect);
    expect(entity.idle).toBe(false);
    // The ship is where the sim left it (no reset), and the new conn drives it.
    expect(entity.ship.pos.z).toBeGreaterThan(posAtDrop.z);
    expect(shard.enqueueInput('p1', input(2, { thrust: 1 }))).toBe(true);
    shard.stop();
  });

  it('stale (superseded) conn: its inputs drop with a debug log, its late leave is ignored', () => {
    const { shard, debugs } = makeLoggedShard();
    const entity = makeEntity('p1', { x: 0, y: 0, z: 0 });
    shard.addEntity(entity);
    const zombie = { id: 'conn-zombie' };
    const fresh = { id: 'conn-fresh' };
    shard.registerConnection('p1', 'Alpha', () => {}, zombie);
    // Reconnect while the zombie socket is still (half) open: it is superseded.
    shard.registerConnection('p1', 'Alpha', () => {}, fresh);
    expect(shard.connections.size).toBe(1); // the stale slot was evicted
    expect([...shard.connections.values()][0].source).toBe(fresh);
    expect(debugs.some((d) => d.includes('superseded'))).toBe(true);

    // The zombie's input frame resolves to the same playerId — it must be
    // dropped (source mismatch), even though its seq is newer than any the
    // fresh conn sent.
    expect(shard.enqueueInput('p1', input(2, { thrust: 0 }), fresh)).toBe(true);
    expect(shard.enqueueInput('p1', input(9, { thrust: 1 }), zombie)).toBe(false);
    expect(debugs.some((d) => d.includes('stale conn'))).toBe(true);

    // The zombie's LATE close must not tear down the fresh connection.
    shard.leavePlayer('p1', zombie);
    expect(shard.connections.size).toBe(1);
    expect(entity.idle).toBe(false);
    expect(debugs.some((d) => d.includes('stale'))).toBe(true);

    // The real close releases the ship (idle, in the world).
    shard.leavePlayer('p1', fresh);
    expect(shard.connections.size).toBe(0);
    expect(entity.idle).toBe(true);
  });
});
