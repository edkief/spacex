/**
 * TASK-60: the worst-case shard, built in-process (no HTTP, no sockets —
 * TASK-18 adds the real-connection layer). Shared by the 120 s benchmark
 * (tickWorstCase.ts) and the fast 10 s CI check (tick-budget-ci.spec.ts),
 * so both measure the SAME scripted scene:
 *
 * - 16 player connections (the shard cap): 8 in flight FIRING (interceptors,
 *   laser cadence + a missile every 2 s so in-flight missiles hover at the
 *   PROJECTILE_CAP = 16), 4 on foot (walking + an active 1.5 s mining
 *   channel each), 4 idle (connected, zero input — coasting);
 * - 10 AI ships (TASK-46 engaged): 5 at ~450 m ahead of the firing line
 *   (inside the 600 m aggro range — full state machine + fire intents),
 *   5 at 3–6 km (the DORMANT fast path territory);
 * - 20 ground items + 30 deposits clustered on the landable pad (they ride
 *   every 10 Hz snapshot — the snapshot-build/serialize cost at full size).
 *
 * All positions are deterministic (fixed seed, fixed offsets) — the same
 * build reproduces the same sim on every machine.
 */
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { restShipState } from '@shared/physics/flight';
import { quatFromEuler, type Vec3 } from '@shared/physics/vec';
import { padsForSystem } from '@shared/world/pads';
import type { InputPayload } from '@shared/protocol/schemas';
import {
  SystemShard,
  type TickPhase,
} from '@server/shard/shard';
import { createAiState, makeWaypoints, mulberry32 } from '@server/shard/ai';
import type { SimEntity } from '@server/shard/types';

export const BENCH_SEED = 'tick-bench-seed';

/** The scripted scene (the AC's worst case). */
export const FIRING_PLAYERS = 8;
export const FOOT_PLAYERS = 4;
export const IDLE_PLAYERS = 4;
export const AI_SHIPS = 10;
export const GROUND_ITEMS = 20;
export const DEPOSITS = 30;

export type PlayerRole = 'firing' | 'foot' | 'idle';

export interface WorstCaseOptions {
  /** Accumulator for the per-phase tick table (AC 3). */
  phaseProfile?: (phase: TickPhase, ms: number) => void;
  /** False = pre-tuning baseline (no dormant AI fast path). */
  dormantAi?: boolean;
}

export interface WorstCase {
  shard: SystemShard;
  /** playerId → role (the driver logs the mix). */
  roles: Map<string, PlayerRole>;
  /** The 10 AI entity ids (5 near-field, 5 far-field). */
  aiIds: string[];
  /**
   * Script one frame of every player's input (call at ~10 Hz; `frame` is a
   * monotonically increasing counter owned by the caller). Deterministic:
   * the same frame sequence reproduces the same sim.
   */
  sendScript(frame: number): void;
  /** The t=30 s event: every firing player drops a missile at once (the cap burst). */
  missileVolley(): void;
  /** Total bytes pushed through conn.send (the snapshot broadcast volume). */
  bytesSent(): number;
}

/** A quiet logger — the bench reads the histogram, not the log. */
const SILENT = { debug() {}, warn() {}, info() {} };

function input(playerId: string, seq: number, partial: Partial<InputPayload>): InputPayload {
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

/** The deterministic firing line: 8 interceptors across 1.4 km, nose +Z. */
function firingPos(i: number): Vec3 {
  return { x: 1000 + i * 200, y: 20 + (i % 3) * 15, z: (i % 2) * 40 };
}

/** One near-field AI ~450 m ahead of firing player `i` (nose toward it). */
function nearAiPos(i: number): Vec3 {
  return { x: firingPos(i).x, y: firingPos(i).y + 25, z: firingPos(i).z + 450 };
}

/** The far-field AI ring: 3–6 km out (the dormant territory). */
function farAiPos(i: number): Vec3 {
  return { x: 3000 + i * 600, y: 100, z: -3000 - i * 600 };
}

export function buildWorstCase(opts: WorstCaseOptions = {}): WorstCase {
  const star = generateStars(BENCH_SEED, 4)[0];
  const system = generateSystem(BENCH_SEED, star.id);
  const shard = new SystemShard({
    systemId: system.systemId,
    galaxySeed: BENCH_SEED,
    system,
    // The bench places its own 10 AI ships deterministically (5 near / 5
    // far) — the seeded roster is out (its count is seed-dependent).
    spawnRogues: false,
    repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: SILENT,
    phaseProfile: opts.phaseProfile,
    dormantAi: opts.dormantAi,
  });

  const roles = new Map<string, PlayerRole>();
  const playerIds: string[] = [];
  const seqs = new Map<string, number>();
  let shardBytes = 0; // bytes pushed through conn.send (the snapshot volume)
  const nextSeq = (playerId: string) => {
    const n = (seqs.get(playerId) ?? 0) + 1;
    seqs.set(playerId, n);
    return n;
  };

  // --- 16 connections: the send() is a byte counter (ws.send of a
  // pre-serialized buffer is an enqueue — the serialize cost is measured
  // in the shard's 'snapshot-serialize' phase, not here).
  for (let i = 0; i < FIRING_PLAYERS + FOOT_PLAYERS + IDLE_PLAYERS; i++) {
    const id = `bench-p${String(i).padStart(2, '0')}`;
    playerIds.push(id);
    roles.set(id, i < FIRING_PLAYERS ? 'firing' : i < FIRING_PLAYERS + FOOT_PLAYERS ? 'foot' : 'idle');
    shard.registerConnection(id, `BENCH${i}`, (buffer) => {
      shardBytes += buffer.length;
    });
  }

  // --- 8 in flight: interceptors (laser + missile) on the firing line.
  for (let i = 0; i < FIRING_PLAYERS; i++) {
    const id = playerIds[i];
    shard.addEntity(makeShipEntity(id, 'interceptor', firingPos(i)));
  }

  // --- 4 on foot: docked at the first pad, then disembarked.
  const pad = padsForSystem(BENCH_SEED, system)[0];
  const footIds = playerIds.slice(FIRING_PLAYERS, FIRING_PLAYERS + FOOT_PLAYERS);
  for (let i = 0; i < FOOT_PLAYERS; i++) {
    const id = footIds[i];
    const shipPos: Vec3 = { x: pad.pos.x + i * 3, y: pad.pos.y, z: pad.pos.z };
    const entity = makeShipEntity(id, 'scout', shipPos);
    entity.docked = true;
    entity.padId = pad.padId;
    entity.planetId = pad.planetId;
    shard.addEntity(entity);
  }

  // --- 4 idle: far out in space, connected, zero input.
  for (let i = 0; i < IDLE_PLAYERS; i++) {
    const id = playerIds[FIRING_PLAYERS + FOOT_PLAYERS + i];
    shard.addEntity(makeShipEntity(id, 'scout', { x: 9000 + i * 100, y: 0, z: 9000 }));
  }

  // --- 10 AI ships: 5 near-field (engaged) + 5 far-field (dormant).
  const aiIds: string[] = [];
  for (let i = 0; i < AI_SHIPS; i++) {
    const near = i < AI_SHIPS / 2; // first 5 are near-field
    const pos = near ? nearAiPos(i) : farAiPos(i - AI_SHIPS / 2);
    const id = `ai:bench:${i}`;
    // Near-field AI faces the firing line (nose -Z toward the players);
    // far-field keeps the default +Z heading on its patrol loop.
    const quat = near ? quatFromEuler(0, Math.PI, 0) : quatFromEuler(0, 0, 0);
    shard.addEntity({
      id,
      kind: 'ai-ship',
      playerId: null,
      callsign: `BENCH-AI-${i}`,
      classId: 'interceptor',
      ship: { ...restShipState(pos, 'space'), quat },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      energy: 100,
    });
    const center = near ? { x: pos.x, y: pos.y, z: pos.z + 300 } : { ...pos };
    const state = createAiState(id, Date.now(), makeWaypoints(mulberry32(i + 1), center, 300));
    shard.ai.set(id, state);
    aiIds.push(id);
  }

  // --- 4 on foot: disembark at the pad, each mines its own deposit.
  const mineDepositIds: string[] = [];
  for (let i = 0; i < FOOT_PLAYERS; i++) {
    const id = footIds[i];
    const ship = shard.entities.get(`ship-${id}`)!;
    shard.handleExitShip(id, ship.id);
  }
  for (let i = 0; i < DEPOSITS; i++) {
    // 30 deposits fanned 12 m apart around the pad — the first 4 sit 2 m
    // from a miner (mining range), the rest ride the snapshot in range.
    const id = shard.addDepositForTesting(
      { x: pad.pos.x + 12 + (i % 6) * 12, y: pad.pos.y, z: pad.pos.z + Math.floor(i / 6) * 12 },
      100,
      'iron',
    );
    if (i < FOOT_PLAYERS) {
      mineDepositIds.push(id);
      const miner = footIds[i];
      const char = shard.entities.get(`char:${miner}`)!;
      // Stand 2 m off the deposit (the 3 m interact range).
      shard.teleportCharacterForTesting(miner, {
        x: char.ship.pos.x,
        y: pad.pos.y,
        z: char.ship.pos.z + 2,
      });
      shard.handleInteract(miner, id, 'mine-start');
    }
  }

  // --- 20 ground items near the pad (300 s ttl, in every snapshot).
  for (let i = 0; i < GROUND_ITEMS; i++) {
    shard.entities.set(`groundItem:bench:${i}`, {
      id: `groundItem:bench:${i}`,
      kind: 'groundItem',
      playerId: null,
      classId: 'groundItem',
      ship: {
        pos: { x: pad.pos.x - 8 + (i % 5) * 4, y: pad.pos.y, z: pad.pos.z + 6 + Math.floor(i / 5) * 4 },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatFromEuler(0, 0, 0),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      quantity: 1,
      resourceId: 'iron',
      ttl: 6000, // 300 s at 20 Hz (GROUND_ITEM_TTL)
      planetId: pad.planetId,
    });
  }

  // --- The scripted input driver (called at ~10 Hz by the bench).
  // `frame` = 10 Hz counter: frame%10 = 1 s cadence, frame%20 = 2 s cadence.
  function sendScript(frame: number): void {
    // Every 5 s: re-park the firing line at its base (the forward thrust
    // would otherwise drive the players THROUGH the near-field AI — this
    // keeps the combat continuously active, a deterministic pattern).
    if (frame % 50 === 0) {
      for (let i = 0; i < FIRING_PLAYERS; i++) {
        shard.teleportForTesting(playerIds[i], firingPos(i));
      }
    }
    // Every 10 s: top up the AI hulls (the bench AI is not in the shard's
    // respawn sweep — without this the 8 firing players grind the 5
    // near-field rogues down in ~15 s and the combat dies mid-run).
    if (frame % 100 === 0) {
      for (const id of aiIds) {
        const e = shard.entities.get(id);
        if (!e) continue;
        if (e.destroyed) {
          e.destroyed = false;
          e.destroyedAtMs = undefined;
        }
        if (e.hull < 0.6) {
          e.hull = 1;
          e.shields = 1;
        }
      }
    }
    for (let i = 0; i < FIRING_PLAYERS; i++) {
      const id = playerIds[i];
      // Ping-pong thrust (2 s forward, 2 s back): the players oscillate in
      // front of the near-field AI (~200–450 m ahead, nose +Z) so the
      // missile's nose-cone target stays valid the whole run — a forward
      // thrust would drive them THROUGH the AI and the fires would be
      // denied (no target behind the nose). A laser at ~0.7/s + a missile
      // every 2 s (the 0.5/s cooldown): ~6 energy/s spent vs the 10/s regen
      // (fires stay affordable) and 4 missiles/s vs the ~3–4 s flight time
      // hovers the PROJECTILE_CAP (16).
      const window = Math.floor(frame / 20);
      const thrust = window % 2 === 0 ? 1 : -1;
      shard.enqueueInput(id, input(id, nextSeq(id), { thrust }));
      if (frame % 15 === 0) shard.handleFire(id, { weapon: 'laser' });
      if (frame % 20 === 0) shard.handleFire(id, { weapon: 'missile' });
    }
    for (let i = 0; i < FOOT_PLAYERS; i++) {
      const id = footIds[i];
      // Walk forward on odd seconds, pause on even (a deterministic
      // walk-and-stop pattern); re-assert the held mining channel at 2 Hz.
      const second = Math.floor(frame / 10);
      shard.enqueueInput(id, input(id, nextSeq(id), { thrust: second % 2 === 1 ? 1 : 0 }));
      if (frame % 5 === 0) shard.handleInteract(id, mineDepositIds[i], 'mine-tick');
    }
    // Idle players send NOTHING (that is the script).
  }

  function missileVolley(): void {
    // The t=30 s event: all 8 firing players drop missiles at once — with
    // the ~8 already in flight the PROJECTILE_CAP (16) is hit and the
    // oldest-expire rule engages (logged by the shard).
    for (let i = 0; i < FIRING_PLAYERS; i++) {
      shard.handleFire(playerIds[i], { weapon: 'missile' });
    }
  }

  return {
    shard,
    roles,
    aiIds,
    sendScript,
    missileVolley,
    /** Total bytes pushed through conn.send (the snapshot broadcast volume). */
    bytesSent: () => shardBytes,
  };
}

function makeShipEntity(playerId: string, classId: string, pos: Vec3): SimEntity {
  return {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId,
    classId,
    ship: restShipState(pos, 'space'),
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    energy: 100,
  };
}
