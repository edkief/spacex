/**
 * Discovery module tests — TASK-37.
 *
 * Covers:
 *   - In-range player flips `discovered` in memory + persists
 *   - Out-of-range player does NOT flip
 *   - Already-discovered deposits short-circuit (no DB write)
 *   - `applyPersistedDiscovery` mirrors the DB state into memory
 *   - Discovery flag flips survive a restart (via the persisted row)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { active, installRepoHooks } from "../db/repo.test.shared.js";
import type { Repository } from "../db/repo.js";
import { ChatRingBuffer } from "../chat.js";
import { DISCOVERY_RANGE_M, depositsForSimple, type Deposit } from "@shared/world/deposits.js";
import { applyPersistedDiscovery, discoverNearbyDeposits } from "./discovery.js";
import type { Shard, ShardConnection, SimEntity } from "./types.js";

const DEV_SEED = "drift-dev-seed-001";
const SYSTEM_ID = "0102030405060710";

/** Build a minimal Shard-shaped fixture for the discovery tests. */
function makeFixture(): { shard: Shard; deposits: ReadonlyMap<string, Deposit> } {
  const depositsList = depositsForSimple(DEV_SEED, SYSTEM_ID);
  if (depositsList.length === 0) {
    throw new Error(`expected deposits for ${SYSTEM_ID}`);
  }
  const deposits = new Map<string, Deposit>();
  for (const d of depositsList) {
    deposits.set(d.depositId, d);
  }
  const entities = new Map<string, SimEntity>();
  for (let i = 0; i < depositsList.length; i++) {
    const d = depositsList[i]!;
    const entity: SimEntity = {
      id: d.depositId,
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: d.pos.x, y: d.pos.y, z: d.pos.z },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: d.planetId,
      onPad: null,
      resourceType: d.resourceId,
      amount: d.amount,
      initialAmount: d.amount,
      depositSeq: i,
      discovered: false,
    };
    entities.set(d.depositId, entity);
  }
  const shard = {
    systemId: SYSTEM_ID,
    connections: new Map<string, ShardConnection>(),
    entities,
    send: () => undefined,
    broadcast: () => undefined,
    sim: { currentTick: 1 },
    events: new EventEmitter(),
    chatLog: new ChatRingBuffer(),
    persist: {},
    generation: 1,
    stats: () => ({}) as unknown,
    shutdown: () => undefined,
    context: {} as unknown,
    dirtyShipSpawns: new Map(),
    onTickObserver: null,
  } as unknown as Shard;
  return { shard, deposits };
}

/** Add a connected character at a given world position. */
function addCharacter(
  shard: Shard,
  pos: { x: number; y: number; z: number },
  connId = "conn-test",
): ShardConnection {
  const entityId = `char:${connId}`;
  const conn: ShardConnection = {
    connId,
    callsign: connId.toUpperCase(),
    playerId: connId,
    shipId: `ship-${connId}`,
    entityId,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  shard.connections.set(connId, conn);
  const character: SimEntity = {
    id: entityId,
    kind: "character",
    playerId: connId,
    callsign: connId.toUpperCase(),
    classId: null,
    hull: 0,
    shields: 0,
    targetId: null,
    pos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: null,
    onPad: null,
  };
  shard.entities.set(entityId, character);
  return conn;
}

installRepoHooks();

describe("discoverNearbyDeposits", () => {
  let fixture: ReturnType<typeof makeFixture> | null = null;
  let repo: Repository | null = null;

  beforeEach(() => {
    fixture = makeFixture();
    repo = active().repo;
  });

  afterEach(() => {
    fixture = null;
    repo = null;
  });

  it("flips `discovered` when a player comes within range and persists", async () => {
    if (!fixture || !repo) throw new Error("fixture not initialised");
    const { shard, deposits } = fixture;
    // Pick the first deposit and put a character at its position.
    const firstDeposit = Array.from(deposits.values())[0]!;
    addCharacter(shard, firstDeposit.pos);

    const flipped = await discoverNearbyDeposits(shard, repo, deposits);
    expect(flipped).toBeGreaterThanOrEqual(1);
    const target = shard.entities.get(firstDeposit.depositId) as SimEntity | undefined;
    expect(target?.discovered).toBe(true);

    // Persisted: listDepositStates has at least one row for this system
    // with discovered=true.
    const rows = await repo.listDepositStates(SYSTEM_ID);
    const matchingRow = rows.find((r) => r.id === firstDeposit.depositId);
    expect(matchingRow).toBeDefined();
    expect(matchingRow?.discovered).toBe(true);
  });

  it("does not flip when the player is out of range", async () => {
    if (!fixture || !repo) throw new Error("fixture not initialised");
    const { shard, deposits } = fixture;
    // Place the character far from every deposit.
    addCharacter(shard, { x: 1_000_000, y: 0, z: 1_000_000 });

    const flipped = await discoverNearbyDeposits(shard, repo, deposits);
    expect(flipped).toBe(0);
    for (const entity of shard.entities.values()) {
      if (entity.kind === "deposit") {
        expect(entity.discovered).toBe(false);
      }
    }
    const rows = await repo.listDepositStates(SYSTEM_ID);
    expect(rows.length).toBe(0);
  });

  it("short-circuits already-discovered deposits (no DB write)", async () => {
    if (!fixture || !repo) throw new Error("fixture not initialised");
    const { shard, deposits } = fixture;
    const firstDeposit = Array.from(deposits.values())[0]!;
    // Mark the entity as discovered already.
    const target = shard.entities.get(firstDeposit.depositId) as SimEntity | undefined;
    expect(target).toBeDefined();
    target!.discovered = true;

    addCharacter(shard, firstDeposit.pos);
    const flipped = await discoverNearbyDeposits(shard, repo, deposits);
    expect(flipped).toBe(0);
    // No row should be written because the deposit was already
    // discovered — we skip persistence for short-circuited entries.
    const rows = await repo.listDepositStates(SYSTEM_ID);
    expect(rows.length).toBe(0);
  });

  it("respects the spec's 50 m discovery radius", async () => {
    if (!fixture || !repo) throw new Error("fixture not initialised");
    expect(DISCOVERY_RANGE_M).toBe(50);
  });
});

describe("applyPersistedDiscovery", () => {
  let fixture: ReturnType<typeof makeFixture> | null = null;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture = null;
  });

  it("marks every entity whose id is in the set as discovered", () => {
    if (!fixture) throw new Error("fixture not initialised");
    const { shard, deposits } = fixture;
    const ids = new Set<string>();
    let count = 0;
    for (const d of deposits.values()) {
      if (count >= 3) break;
      ids.add(d.depositId);
      count++;
    }
    applyPersistedDiscovery(shard, ids);
    let matched = 0;
    for (const d of deposits.values()) {
      const entity = shard.entities.get(d.depositId);
      if (ids.has(d.depositId)) {
        expect(entity?.discovered).toBe(true);
        matched++;
      } else {
        expect(entity?.discovered).toBe(false);
      }
    }
    expect(matched).toBe(3);
  });

  it("marks every entity NOT in the set as undiscovered (defensive reset)", () => {
    if (!fixture) throw new Error("fixture not initialised");
    const { shard } = fixture;
    // First, flip all to discovered in memory.
    for (const e of shard.entities.values()) {
      if (e.kind === "deposit") e.discovered = true;
    }
    // Then apply an empty set — should reset all.
    applyPersistedDiscovery(shard, new Set());
    for (const e of shard.entities.values()) {
      if (e.kind === "deposit") expect(e.discovered).toBe(false);
    }
  });
});
