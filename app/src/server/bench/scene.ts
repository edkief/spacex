/**
 * Worst-case shard fixture for the server tick benchmark — TASK-60.
 *
 * Builds, in-process and with no network, exactly the shard the
 * acceptance criteria name:
 *
 *   - **16 player connections** — 8 ships in flight firing, 4
 *     on-foot characters walking + mining a deposit, 4 idle
 *     ships parked off to one side.
 *   - **10 AI ships** in `ENGAGE` (hull topped up each tick by the
 *     driver so the combat loop never winds down), spawned with
 *     the TASK-45 patrol fields so `tickAi` runs the real state
 *     machine on them.
 *   - **16 concurrent missiles** — the cap — fired at t = 30 s.
 *   - **20 ground items** + **30 deposits** in range.
 *   - **8 hazard cells** with drones, so the hazard phase walks a
 *     realistic cell + exposure table every tick.
 *
 * The shard runs on the **real** {@link createShard} + real
 * `buildShardContext` (deterministic galaxy), so every phase the
 * benchmark measures is the code the server runs in production.
 *
 * @see ./tickBench.ts for the driver.
 */

import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystemFromStar } from "@shared/galaxy/system.js";
import type { Planet } from "@shared/galaxy/types.js";
import type { ProtocolShipClassId } from "@shared/protocol/index.js";

import { buildShardContext } from "../galaxy/system-data.js";
import { registerHazardCells } from "../shard/hazards.js";
import { makeGroundItemEntity } from "../shard/inventory.js";
import { handleMineStart } from "../shard/mining.js";
import {
  addConnection,
  createShard,
  spawnAiShip,
  spawnCharacter,
  spawnShip,
  type Shard,
  type ShardConnection,
} from "../shard/index.js";
import type { SimEntity } from "../shard/types.js";
import type { Repository } from "../db/repo.js";
import type { Inventory } from "@shared/world/inventory.js";

// ---------------------------------------------------------------------------
// Constants — the acceptance criteria's workload shape
// ---------------------------------------------------------------------------

/** Player connections in the shard. */
export const BENCH_PLAYER_CONNS = 16;
/** Connections flying ships that fire every tick. */
export const BENCH_FLYING_CONNS = 8;
/** Connections on foot, walking + mining. */
export const BENCH_ON_FOOT_CONNS = 4;
/** Connections parked with no input. */
export const BENCH_IDLE_CONNS = 4;
/** AI ships in `ENGAGE`. */
export const BENCH_AI_SHIPS = 10;
/** Ground items scattered on the surface. */
export const BENCH_GROUND_ITEMS = 20;
/** Deposits within mining range of the on-foot players. */
export const BENCH_DEPOSITS = 30;
/** Hazard cells (storm / radzone) with drones. */
export const BENCH_HAZARD_CELLS = 8;
/** Drones per hazard cell. */
export const BENCH_DRONES_PER_CELL = 2;
/** Missile cap — the volley the acceptance criteria name. */
export const BENCH_MISSILE_VOLLEY = 16;
/** Wall-clock time at which the volley fires, ms. */
export const BENCH_VOLLEY_AT_MS = 30_000;
/** Galaxy seed the fixture resolves its system from. */
export const BENCH_SEED = "drift-dev";
/** Stars in the deterministic galaxy. */
export const BENCH_STAR_COUNT = 4;

/** The connection ids + entity ids the driver scripts inputs for. */
export interface BenchShard {
  readonly shard: Shard;
  /** Flying-ship connections, in id order (scripted to fire). */
  readonly flying: readonly ShardConnection[];
  /** On-foot connections (scripted to walk; 2 of them mine). */
  readonly onFoot: readonly ShardConnection[];
  /** Idle connections. */
  readonly idle: readonly ShardConnection[];
  /** Every connection, flying + on foot + idle. */
  readonly connections: readonly ShardConnection[];
  /** AI entity ids. */
  readonly aiIds: readonly string[];
  /** The landable planet the on-foot players stand on. */
  readonly planet: Planet;
  /** Landing-pad id the docked ships sit on. */
  readonly padId: string;
}

// ---------------------------------------------------------------------------
// System resolution
// ---------------------------------------------------------------------------

/** Cached star + planet so repeated bench runs don't re-generate. */
let cachedSystem: { starId: string; planet: Planet } | null = null;

/**
 * Resolve the first landable planet in the dev seed and cache the
 * lookup — the galaxy generation is the slowest part of setting up
 * a run and it is pure.
 */
export function benchSystem(): { starId: string; planet: Planet } {
  if (cachedSystem !== null) return cachedSystem;
  for (const star of generateStars(BENCH_SEED, BENCH_STAR_COUNT)) {
    const system = generateSystemFromStar(BENCH_SEED, star);
    const planet = system.planets.find((p) => p.landable);
    if (planet) {
      cachedSystem = { starId: star.id, planet };
      return cachedSystem;
    }
  }
  throw new Error("bench: no landable planet in the dev seed");
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/**
 * Build the worst-case shard. The sim loop is **not** started
 * (`autoStart: false`) — the driver owns the clock so it can script
 * inputs on a deterministic schedule.
 *
 * @param nowMs Starting wall clock for spawn timestamps.
 */
export function buildBenchShard(nowMs = 1_700_000_000_000): BenchShard {
  const { starId, planet } = benchSystem();
  const context = buildShardContext({
    seed: BENCH_SEED,
    starCount: BENCH_STAR_COUNT,
    systemId: starId,
  });

  const shard = createShard({
    systemId: starId,
    context,
    // No sockets in the benchmark (TASK-18 adds the real connection
    // layer); the frames are counted, not sent.
    send: () => undefined,
    // No sockets in the benchmark (TASK-18 adds the real connection
    // layer); the per-tick encode is still measured because the sim
    // runs it — the frame itself is dropped here.
    broadcast: () => undefined,
    onTickObserver: null,
    autoStart: false,
    // The mining phase persists through the repository; the bench
    // supplies the three-method in-memory shim so the measured path
    // is the real one (call, await, no disk).
    repo: benchRepo(),
    logger: { warn: () => undefined, debug: () => undefined, error: () => undefined },
  });

  const padId = `pad-bench-${planet.id}`;
  const padPos = padPosition(planet);

  const connections: ShardConnection[] = [];
  const flying: ShardConnection[] = [];
  const onFoot: ShardConnection[] = [];
  const idle: ShardConnection[] = [];

  // --- 12 docked/parked player ships (8 flying + 4 idle) -------------
  const classes: ProtocolShipClassId[] = ["interceptor", "freighter", "scout"];
  for (let i = 0; i < BENCH_FLYING_CONNS + BENCH_IDLE_CONNS; i++) {
    const conn = makeConnection(i);
    connections.push(conn);
    addConnection(shard, conn);
    // Ring the fleet around the pad so the flight integrator runs
    // real drag / quat math and the AGGRO cone sees targets.
    const angle = (i / (BENCH_FLYING_CONNS + BENCH_IDLE_CONNS)) * Math.PI * 2;
    const ship = spawnShip(shard, {
      shipId: conn.shipId,
      playerId: conn.playerId,
      callsign: conn.callsign,
      // The 8 shooters are interceptors — the only class with a
      // missile equipped, so the volley reaches the 16-projectile cap.
      classId: i < BENCH_FLYING_CONNS ? "interceptor" : (classes[i % classes.length] ?? "scout"),
      hull: 100,
      shields: 50,
      pos: {
        x: padPos.x + Math.cos(angle) * 400,
        y: padPos.y + 40 + (i % 3) * 10,
        z: padPos.z + Math.sin(angle) * 400,
      },
      vel: { x: -Math.sin(angle) * 60, y: 0, z: Math.cos(angle) * 60 },
      regime: "space",
      bindConnId: conn.connId,
    });
    // The 8 shooters stay in space (regime space + patrol fields are
    // enough for the AI / weapon loops); the idle 4 sit on the pad.
    if (i >= BENCH_FLYING_CONNS) {
      ship.regime = "surface";
      ship.pos.x = padPos.x + (i - BENCH_FLYING_CONNS) * 24;
      ship.pos.z = padPos.z;
      ship.vel.x = 0;
      ship.vel.z = 0;
      ship.onPad = padId;
    }
    if (i < BENCH_FLYING_CONNS) flying.push(conn);
    else idle.push(conn);
  }

  // --- 4 on-foot characters on the pad, mining -----------------------
  for (let i = 0; i < BENCH_ON_FOOT_CONNS; i++) {
    const conn = makeConnection(BENCH_FLYING_CONNS + BENCH_IDLE_CONNS + i);
    connections.push(conn);
    addConnection(shard, conn);
    const ship = spawnShip(shard, {
      shipId: conn.shipId,
      playerId: conn.playerId,
      callsign: conn.callsign,
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: padPos.x + i * 12, y: padPos.y, z: padPos.z },
      regime: "surface",
      originPlanetId: planet.id,
      onPad: padId,
    });
    spawnCharacter(shard, {
      playerId: conn.playerId,
      callsign: conn.callsign,
      ship,
      bindConnId: conn.connId,
    });
    onFoot.push(conn);
  }

  // --- 30 deposits around the pad -----------------------------------
  const depositIds: string[] = [];
  for (let i = 0; i < BENCH_DEPOSITS; i++) {
    const id = `deposit-bench-${i}`;
    depositIds.push(id);
    // The first two sit inside `MINE_RANGE_M` of the two mining
    // characters (the rest ring the pad), so the mining state machine
    // really runs for the whole measurement window.
    const near = i < 2;
    shard.entities.set(
      id,
      makeDepositEntity(id, i, {
        x: padPos.x + (near ? i * 1.5 : Math.cos((i / BENCH_DEPOSITS) * Math.PI * 2) * 30),
        y: padPos.y,
        z: padPos.z + (near ? 1 : Math.sin((i / BENCH_DEPOSITS) * Math.PI * 2) * 30),
      }),
    );
  }

  // Two of the four on-foot players mine (the mining phase is the
  // one with a repository round-trip in it). Their characters are
  // snapped onto the deposit first — `handleMineStart` enforces
  // `MINE_RANGE_M`, and the bench wants the mining state machine
  // running for the whole window, not a "player walked over" gate.
  for (let i = 0; i < Math.min(2, onFoot.length); i++) {
    const conn = onFoot[i];
    if (!conn || conn.entityId === null) continue;
    const character = shard.entities.get(conn.entityId);
    const deposit = shard.entities.get(depositIds[i] ?? "deposit-bench-0");
    if (character && deposit) {
      character.pos.x = deposit.pos.x;
      character.pos.y = deposit.pos.y;
      character.pos.z = deposit.pos.z;
    }
    handleMineStart(shard, {
      connId: conn.connId,
      depositId: depositIds[i] ?? depositIds[0] ?? "deposit-bench-0",
      nowMs,
    });
  }

  // --- 20 ground items ----------------------------------------------
  for (let i = 0; i < BENCH_GROUND_ITEMS; i++) {
    shard.entities.set(
      `ground-bench-${i}`,
      makeGroundItemEntity({
        id: `ground-bench-${i}`,
        pos: {
          x: padPos.x + (i % 5) * 6 - 12,
          y: padPos.y,
          z: padPos.z + Math.floor(i / 5) * 6 - 12,
        },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        resourceType: i % 2 === 0 ? "iron" : "crystal",
        amount: 3,
        spawnedAtMs: nowMs,
      }),
    );
  }

  // --- 10 AI ships, engaged, near the fleet -------------------------
  const aiIds: string[] = [];
  for (let i = 0; i < BENCH_AI_SHIPS; i++) {
    const id = `ai-bench-${i}`;
    aiIds.push(id);
    const angle = (i / BENCH_AI_SHIPS) * Math.PI * 2;
    spawnAiShip(shard, {
      id,
      classId: classes[i % classes.length] ?? "scout",
      pos: {
        x: padPos.x + Math.cos(angle) * 620,
        y: padPos.y + 60,
        z: padPos.z + Math.sin(angle) * 620,
      },
      callsign: `RAIDER-${i}`,
      aiSpawnPos: { x: padPos.x, y: padPos.y + 60, z: padPos.z },
      aiPatrolCenter: { x: padPos.x, y: padPos.y + 60, z: padPos.z },
      aiPatrolRadius: 600 + i * 40,
    });
  }

  // --- 8 hazard cells with 2 drones each ----------------------------
  registerHazardCells(
    shard,
    Array.from({ length: BENCH_HAZARD_CELLS }, (_, i) => {
      const angle = (i / BENCH_HAZARD_CELLS) * Math.PI * 2;
      return {
        hazardId: `hazard-bench-${i}`,
        planetId: planet.id,
        kind: i % 2 === 0 ? ("storm" as const) : ("radzone" as const),
        pos: {
          x: padPos.x + Math.cos(angle) * 1500,
          y: padPos.y,
          z: padPos.z + Math.sin(angle) * 1500,
        },
        radius: 400,
        intensity: 0.4,
        droneCount: BENCH_DRONES_PER_CELL,
        droneIdPrefix: `drone-bench-${i}`,
      };
    }),
    { nowMs },
  );

  return {
    shard,
    flying,
    onFoot,
    idle,
    connections,
    aiIds,
    planet,
    padId,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Repository shim
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory repository covering the three methods the
 * mining state machine calls. Real SQLite would put disk in the
 * measurement; the benchmark is about the sim's CPU, not storage.
 */
function benchRepo(): Repository {
  const inventories = new Map<string, Inventory>();
  return {
    async getInventory(playerId: string) {
      const existing = inventories.get(playerId);
      if (existing) return existing;
      const fresh = emptyInventory();
      inventories.set(playerId, fresh);
      return fresh;
    },
    async saveInventory(playerId: string, inventory: Inventory) {
      inventories.set(playerId, inventory);
      return inventory;
    },
    async upsertDepositState() {
      return undefined;
    },
  } as unknown as Repository;
}

function emptyInventory(): Inventory {
  return { stacks: {}, weightUsed: 0 };
}

/** A unique connection per index, with the shape `SimLoop` drains. */
function makeConnection(index: number): ShardConnection {
  return {
    connId: `conn-bench-${index}`,
    callsign: `BENCH-${index}`,
    playerId: `player-bench-${index}`,
    shipId: `ship-bench-${index}`,
    entityId: null,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
}

/** World-space position of the benchmark pad (beside the planet). */
function padPosition(planet: Planet): { x: number; y: number; z: number } {
  return { x: planet.radiusKm * 1000 + 5_000, y: 0, z: 0 };
}

/**
 * Deposit entity — the same broadcast-only shape `hydrateShardDeposits`
 * mints, built inline so the fixture doesn't need the galaxy seed's
 * deposit placement pass.
 */
function makeDepositEntity(id: string, index: number, padPos: { x: number; y: number; z: number }) {
  const angle = (index / BENCH_DEPOSITS) * Math.PI * 2;
  return {
    id,
    kind: "deposit" as const,
    playerId: null,
    callsign: null,
    classId: null,
    hull: 0,
    shields: 0,
    targetId: null,
    pos: {
      x: padPos.x + Math.cos(angle) * 30,
      y: padPos.y,
      z: padPos.z + Math.sin(angle) * 30,
    },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface" as const,
    originPlanetId: null,
    onPad: null,
    resourceType: (index % 4 === 0 ? "crystal" : "iron") as unknown as SimEntity["resourceType"],
    amount: 500,
  } as unknown as unknown as SimEntity;
}
