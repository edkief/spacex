import { describe, expect, it } from 'vitest';

import { Rng, seedFromString } from '@shared/random';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { padsForSystem } from '@shared/world/pads';
import { terminalsFor } from '@shared/world/terminals';
import { quatIdentity } from '@shared/physics/vec';
import { sellUnitPrice } from '@shared/sell';
import { emptyInventory } from '@shared/inventory';
import { SystemShard } from '@server/shard/shard';
import type { SimEntity } from '@server/shard/types';
import type { Repository } from '@server/db/repo';
import type { PlayerRow } from '@server/db/schema';

/**
 * TASK-67 step 3: the economy property test — the long-term guard.
 *
 * A SEEDED random generator emits 1000 sequences of schema-valid game
 * messages against a FRESH shard (in-memory repo stub, fake clock, real sim
 * loop) and after every sequence the invariants must hold:
 *
 *  - IRON CONSERVATION: deposits + holds + inventories + ground items ==
 *    the initial world total − units sold (iron only ever comes from
 *    deposits; selling destroys it; nothing is created from nothing);
 *  - CREDITS BOUNDED BY SALES: the balance is EXACTLY start + Σ earned from
 *    successful sells (sells are the only credit source in a fresh shard);
 *  - NO NEGATIVE BALANCES: every stack ≥ 0, credits ≥ 0;
 *  - ENTITY COUNTS WITHIN CAPS: ≤ 16 projectiles, < 1000 entities (the
 *    snapshot cap).
 *
 * The seed is fixed: a future economy bug makes this fail DETERMINISTICALLY
 * in CI. Runtime target: < 60 s for 1000 sequences.
 */

const GALAXY_SEED = 'DRIFT-SEED-0001';
const PROP_SEED = 'TASK-67-ECONOMY-PROPERTY';
const START_CREDITS = 500;
const PLAYER_ID = 'p-prop';

/** The pad-system context (a landable atmospheric planet with a pad). */
function findPadTarget() {
  for (const star of generateStars(GALAXY_SEED)) {
    const system = generateSystem(GALAXY_SEED, star.id);
    const planet = system.planets.find((p) => p.landable && p.hasAtmosphere);
    if (!planet) continue;
    const pad = padsForSystem(GALAXY_SEED, system).find((p) => p.planetId === planet.id);
    if (pad) return { system, planet, pad };
  }
  throw new Error('no landable atmospheric pad in the seeded galaxy');
}
const { system: SYSTEM, planet: PLANET, pad } = findPadTarget();

interface Ledger {
  /** Credits per the stub repo (the "bank"). */
  credits: number;
  /** Units sold so far (drains the iron world). */
  soldUnits: number;
  /** Iron earned from sells (credits issued). */
  earned: number;
}

/**
 * In-memory repo stub: the real sell commit shape (withTransaction +
 * addCredits + the two stack writers) with no disk. The stub is the source
 * of truth for CREDITS; the shard entity is the source of truth for IRON.
 * Production hands the SAME repo instance to withTransaction, so the stub
 * does the same (only the methods the sell/mining paths use are real).
 */
function makeRepo(ledger: Ledger) {
  const addCredits = async (_pid: string, amount: number): Promise<PlayerRow> => {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`invalid credit amount ${amount}`);
    }
    ledger.credits += amount;
    // Only `credits` is ever read back off the row: the shape is cast away.
    return { credits: ledger.credits } as unknown as PlayerRow;
  };
  const stub = {
    getShipByOwner: async () => undefined,
    getPlayersByIds: async () => [],
    withTransaction: async <T>(fn: (repo: Repository) => Promise<T>): Promise<T> =>
      fn(stub as unknown as Repository),
    addCredits,
    updatePlayerInventory: async () => undefined,
    updateShipCargo: async () => undefined,
  };
  return stub as unknown as Repository;
}

const noopLog = { debug() {}, warn() {}, info() {} };
const noopBus = {
  emitSwap() {},
  onSwap: () => () => {},
  emitLivery() {},
  onLivery: () => () => {},
};

/** Total iron currently in the world (deposits + hold + inventory + ground). */
function worldIron(shard: SystemShard, ship: SimEntity): number {
  let total = 0;
  for (const e of shard.entities.values()) {
    if (e.kind === 'deposit' || e.kind === 'groundItem') {
      if (e.resourceId === 'iron') total += e.quantity ?? 0;
    }
  }
  const hold = ship.cargo ?? { stacks: {} as Record<string, number> };
  total += hold.stacks.iron ?? 0;
  // The player's inventory lives on the SHIP entity; the on-foot character
  // mirrors the SAME stacks reference (syncCharacterInventory), so counting
  // both would double-count. Character covered by the ship count.
  total += (ship.inventory ?? emptyInventory()).iron ?? 0;
  return total;
}

describe('TASK-67: economy property test (1000 seeded sequences vs a fresh shard)', () => {
  it('no sequence of valid messages creates credits or resources from nothing', async () => {
    const t0 = Date.now();
    const ledger: Ledger = { credits: START_CREDITS, soldUnits: 0, earned: 0 };
    const shard = new SystemShard({
      systemId: SYSTEM.systemId,
      galaxySeed: GALAXY_SEED,
      system: SYSTEM,
      repo: makeRepo(ledger),
      shipSwapBus: noopBus,
      log: noopLog,
      now: () => fakeNow,
    });

    let fakeNow = 1_000_000;
    /** Advance the fake clock `ms`, one sim tick per 50 ms (the real dt). */
    const advance = (ms: number): void => {
      const end = fakeNow + ms;
      while (fakeNow < end) {
        fakeNow += 50;
        shard.sim.step(fakeNow);
      }
    };

    // The honest starting point: a docked scout at the pad, its on-foot
    // character at the station terminal, one 50-unit iron deposit 1 m ahead.
    shard.registerConnection(PLAYER_ID, 'prop-test', () => undefined);
    const ship: SimEntity = {
      id: 'ship-prop',
      kind: 'ship',
      playerId: PLAYER_ID,
      callsign: 'prop-test',
      classId: 'scout',
      ship: {
        pos: { ...pad.pos },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: true,
      padId: pad.padId,
      planetId: PLANET.id,
      inventory: emptyInventory(),
    };
    shard.addEntity(ship);
    const terminal = terminalsFor(GALAXY_SEED, SYSTEM).find((t) => t.padId === pad.padId)!;
    // Character bypasses addEntity: it would overwrite playerEntities'
    // ship entry (production creates it via entities.set in handleExitShip).
    shard.entities.set(`char:${PLAYER_ID}`, {
      id: `char:${PLAYER_ID}`,
      kind: 'character',
      playerId: PLAYER_ID,
      callsign: 'prop-test',
      classId: 'scout',
      ship: {
        pos: { ...terminal.pos },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      planetId: PLANET.id,
      charOnGround: true,
      inventory: emptyInventory(),
    });
    const depositId = shard.addDepositForTesting(
      { x: terminal.pos.x, y: terminal.pos.y, z: terminal.pos.z + 1 },
      50,
    );

    // Warm the sim (regime resolution, pad state) before the baseline.
    advance(1_000);
    const initialWorldIron = worldIron(shard, ship);
    expect(initialWorldIron).toBeGreaterThanOrEqual(50); // the seeded deposit + any seeded deposits

    // The seeded generator: pick actions from the VALIDATED inbound message
    // set exactly as routeGameMessage would (schema-valid payloads only).
    const rng = new Rng(seedFromString(PROP_SEED));
    let seq = 1;
    const input = (): void => {
      // Idle input frames (zero thrust/turn): the generator's job is the
      // economy handlers, not movement — a thrust-1 frame would be HELD
      // (latest-wins until replaced) and walk the character off the
      // terminal/deposit, silently disabling the mining + sell paths.
      shard.enqueueInput(PLAYER_ID, {
        seq: seq++,
        thrust: 0,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
      });
    };
    const fire = (): void => {
      shard.handleFire(PLAYER_ID, { weapon: 'laser' });
    };
    const interact = (): void => {
      const targets: string[] = [depositId, 'ship-prop', terminal.terminalId];
      const ground = [...shard.entities.values()]
        .filter((e) => e.kind === 'groundItem')
        .slice(0, 3)
        .map((e) => e.id);
      targets.push(...ground);
      const targetId = rng.pick(targets);
      const actions =
        targetId === depositId
          ? ['mine-start', 'mine-tick', 'mine-stop', 'pickup']
          : targetId === 'ship-prop'
            ? ['open-cargo', 'enter_ship']
            : targetId === terminal.terminalId
              ? [undefined]
              : ['pickup'];
      shard.handleInteract(PLAYER_ID, targetId, rng.pick(actions) as string | undefined);
    };
    const drop = (): void => {
      shard.handleDrop(PLAYER_ID, 'iron', 1 + rng.nextInt(3));
    };
    const cargoTransfer = (): void => {
      shard.handleCargoTransfer(PLAYER_ID, {
        resourceId: 'iron',
        amount: 1 + rng.nextInt(3),
        from: rng.pick(['inv', 'hold']),
      });
    };
    const sell = async (): Promise<void> => {
      const res = await shard.handleSell(PLAYER_ID, {
        resourceId: 'iron',
        amount: 1 + rng.nextInt(10),
        source: rng.pick(['hold', 'inv']),
      });
      if (res.ok) {
        ledger.soldUnits += res.sold;
        ledger.earned += res.earned;
      }
    };
    const chat = (): void => {
      shard.handleChat('prop-test', `prop spam ${seq}`);
    };

    const actions: Array<() => void | Promise<void>> = [
      input,
      input, // weight: inputs are the common case
      fire,
      interact,
      interact,
      interact,
      drop,
      drop,
      cargoTransfer,
      sell,
      sell,
      chat,
    ];

    // TIME BUDGET: dropped ground items despawn after a 300 s ttl (by
    // design) — that is NOT a leak, but the conservation law above cannot
    // tell a ttl despawn from one. The run therefore stays inside the ttl
    // window: at most 5 messages × 50 ms per sequence × 1000 = 250 s + the
    // 1 s warmup < 300 s, so no ground item ever expires mid-run.
    let totalMessages = 0;
    for (let sequence = 0; sequence < 1000; sequence++) {
      const len = 3 + rng.nextInt(3); // 3..5 messages per sequence
      for (let i = 0; i < len; i++) {
        const action = rng.pick(actions);
        await action();
        totalMessages += 1;
        advance(50); // 1 sim tick per message
      }
      // ---- The invariants (checked after EVERY sequence, so a violation
      // ---- pinpoints the sequence that broke it). ----
      const liveShip = shard.entities.get('ship-prop')!;
      const world = worldIron(shard, liveShip);
      expect(
        world,
        `sequence ${sequence}: iron conservation (world ${world} != initial ${initialWorldIron} - sold ${ledger.soldUnits})`,
      ).toBe(initialWorldIron - ledger.soldUnits);
      expect(ledger.credits, `sequence ${sequence}: credits issued`).toBe(
        START_CREDITS + ledger.earned,
      );
      expect(ledger.credits, `sequence ${sequence}: credits bounded by sales`).toBeLessThanOrEqual(
        START_CREDITS + ledger.soldUnits * sellUnitPrice('iron'),
      );
      expect(ledger.credits).toBeGreaterThanOrEqual(0);
      // No negative balances anywhere.
      for (const e of shard.entities.values()) {
        for (const [id, amount] of Object.entries(e.inventory ?? {})) {
          expect(amount, `sequence ${sequence}: stack ${id} on ${e.id}`).toBeGreaterThanOrEqual(0);
        }
        if (e.kind === 'deposit' || e.kind === 'groundItem') {
          expect(
            e.quantity ?? 0,
            `sequence ${sequence}: quantity on ${e.id}`,
          ).toBeGreaterThanOrEqual(0);
        }
      }
      // Entity counts within the documented caps.
      let projectiles = 0;
      for (const e of shard.entities.values()) if (e.kind === 'projectile') projectiles++;
      expect(projectiles, `sequence ${sequence}: projectile cap`).toBeLessThanOrEqual(16);
      expect(shard.entities.size, `sequence ${sequence}: entity cap`).toBeLessThan(1_000);
    }

    // The generator must have exercised the economy: some iron was mined and
    // some sold (a zero-activity run would not guard anything).
    expect(ledger.soldUnits, 'the run sold some iron').toBeGreaterThan(0);
    expect(totalMessages, '1000 sequences of messages').toBeGreaterThanOrEqual(3_000);

    const elapsedMs = Date.now() - t0;
    expect(elapsedMs, `1000 sequences took ${elapsedMs} ms`).toBeLessThan(60_000);
  }, 120_000);
});
