/**
 * Abuse-test raw WS client + server harness (TASK-67).
 *
 * The whole point of this module is to give the cheat tests a way to
 * pretend to be the worst possible client: send arbitrary JSON to the
 * real WS server, see how it reacts, and assert that the server
 * refused every attempted bypass. There is *no* game logic in this
 * client — it's a one-shot WebSocket + a queue for whatever the server
 * sends back.
 *
 * The harness boots a real Fastify + WS server with a real in-memory
 * SQLite repository, a real in-process shard (with deposits + AI ships
 * seeded so fire / mine / sell have targets), and uses the *production*
 * attachWs code paths. The only difference from a normal client is
 * that the harness reaches in directly to record final shard state
 * (credit balance, deposit amounts, entity counts) so each test can
 * assert "the cheater gained nothing".
 *
 * Acceptance criteria for TASK-67 step 1:
 *   - `bootAbuseServer()` — returns the WS URL, the live Shard, the
 *     Repository, and an `openCheater()` factory.
 *   - `openCheater(url)` — returns a `Cheater` with `send(json)` /
 *     `sendText(str)` / `sendRaw(buf)` / `close()` / `nextFrame(n)`
 *     / `expectClose(code)` / `waitFor(code, n)` seams.
 *
 * The cheater is intentionally dumb: it never runs the handshake
 * state machine, never validates its own outbound frames, and never
 * pretends to be a game client. The tests can drive it through the
 * proper handshake (so the connection lives long enough to attempt
 * the cheat) or skip straight to "fire 30 weapons per second" — both
 * patterns exercise the same server code paths.
 */
import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import { type WebSocket as WsClient } from "ws";

import { attachWs, type WsHandle, type WsHandleOptions } from "../../src/server/ws.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "../../src/shared/protocol/index.js";
import { createSqliteTestDb } from "../../src/server/db/client.js";
import { createSqliteRepository } from "../../src/server/db/repo.sqlite.js";
import type { Repository } from "../../src/server/db/repo.js";
import { createShard } from "../../src/server/shard/index.js";
import { makeAiEntity, makePlayerEntity } from "../../src/server/shard/entity.js";
import { cargoHoldFor } from "../../src/shared/world/cargo.js";
import { addToCargo } from "../../src/shared/world/cargoOps.js";
import { emptyInventory } from "../../src/shared/world/inventoryOps.js";
import { depositsFor } from "../../src/shared/world/deposits.js";
import { resourceBasePrice } from "../../src/shared/resources.js";
import type { Shard, ShardSystemContext, SimEntity } from "../../src/server/shard/types.js";
import type { ProtocolEntityState } from "../../src/shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Cheater — minimal WS client. Sends whatever the test hands it; records
// every frame the server sends back.
// ---------------------------------------------------------------------------

/** Frame captured from the wire, raw text + parsed JSON (when applicable). */
export interface CapturedFrame {
  raw: string;
  parsed: { v: number; type: string; payload: unknown } | null;
}

/** Outbound / inbound seam for a single connected WS. */
export class Cheater {
  public readonly ws: WsClient;
  /** Frames the server has pushed to this client, in arrival order. */
  public readonly received: CapturedFrame[] = [];
  /** Close event payload, populated on the first `close` event. */
  public closeInfo: { code: number; reason: string } | null = null;
  private readonly emitter = new EventEmitter();

  constructor(ws: WsClient) {
    this.ws = ws;
    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
      let parsed: CapturedFrame["parsed"];
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      this.received.push({ raw: text, parsed });
      this.emitter.emit("frame", this.received[this.received.length - 1]!);
    });
    ws.on("close", (code, reasonBuf) => {
      this.closeInfo = { code, reason: reasonBuf.toString("utf8") };
      this.emitter.emit("close", this.closeInfo);
    });
  }

  /** Send an arbitrary JSON-serialisable object. NO server-side
   *  validation runs before transmission — that's the whole point. */
  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  /** Send a pre-encoded envelope (typed protocol frame). */
  sendFrame(type: string, body: unknown): void {
    this.ws.send(encodeEnvelope(type as never, body as never));
  }

  /** Send a raw string frame (lets the test craft malicious JSON). */
  sendText(text: string): void {
    this.ws.send(text);
  }

  /** Send a raw Buffer (lets the test exceed 64 KB / send binary). */
  sendRaw(buf: Buffer): void {
    this.ws.send(buf);
  }

  /** Wait until `count` frames have arrived, or reject after `timeoutMs`. */
  waitForFrames(count: number, timeoutMs = 2_000): Promise<CapturedFrame[]> {
    if (this.received.length >= count) {
      return Promise.resolve(this.received.slice(0, count));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off("frame", onFrame);
        reject(new Error(`waitForFrames timeout: wanted ${count}, got ${this.received.length}`));
      }, timeoutMs);
      const onFrame = (): void => {
        if (this.received.length >= count) {
          clearTimeout(timer);
          this.emitter.off("frame", onFrame);
          resolve(this.received.slice(0, count));
        }
      };
      this.emitter.on("frame", onFrame);
    });
  }

  /** Wait until the WS is closed (or reject after `timeoutMs`). */
  waitForClose(timeoutMs = 3_000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo !== null) {
      return Promise.resolve(this.closeInfo);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off("close", onClose);
        reject(new Error("waitForClose timeout"));
      }, timeoutMs);
      const onClose = (info: { code: number; reason: string }): void => {
        clearTimeout(timer);
        this.emitter.off("close", onClose);
        resolve(info);
      };
      this.emitter.on("close", onClose);
    });
  }

  /** Force-close the underlying socket (used by tests to clean up). */
  close(): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.close();
  }

  /** Frames filtered to type === `type`. Convenience for assertions. */
  framesOfType(type: string): CapturedFrame[] {
    return this.received.filter((f) => f.parsed?.type === type);
  }

  /** Errors the server has pushed. */
  errors(): Array<{ code: string; message: string }> {
    const out: Array<{ code: string; message: string }> = [];
    for (const f of this.received) {
      if (f.parsed?.type === "error") {
        const p = f.parsed.payload as { code?: string; message?: string };
        if (typeof p.code === "string") {
          out.push({ code: p.code, message: p.message ?? "" });
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// World fixture — a single shard with a docked ship, a deposit, and an
// AI ship so every action has a valid target.
// ---------------------------------------------------------------------------

const SYSTEM_ID = "0000000000000abc"; // 16-hex systemId (TASK-4 contract)
const STAR_ID = "0000000000000abc";
const PLANET_ID = "planet-abuse";
const PAD_ID = "pad-abuse";

/** Snapshot of the seeded entities + connections so tests can compare. */
export interface AbuseWorld {
  /** The live shard — tests can read `entities`, `connections`, `sim`. */
  shard: Shard;
  /** Repository for credit / inventory / cargo assertions. */
  repo: Repository;
  /** Underlying SQLite close handle (tests should call this in afterEach). */
  closeDb: () => void;
  /** Callsign → playerId for the seeded players. */
  playerIds: Record<string, string>;
  /** Callsign → entityId for the seeded player ships. */
  playerEntityIds: Record<string, string>;
  /** Callsign → entityId for the on-foot character (TASK-31). */
  characterEntityIds: Record<string, string>;
  /** AI ship entity id (always `"ai-abuse-1"`). */
  aiEntityId: string;
  /** Deposit entity id (always `"deposit-abuse-1"`). */
  depositEntityId: string;
  /** Initial credit balance for the seeded pilot. */
  initialCredits: number;
  /** Initial deposit `amount` (after seeding). */
  initialDepositAmount: number;
  /** All frames the shard has pushed to any client, in arrival order. */
  sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }>;
}

/** Boot a full abuse-test world. Always returns a fresh in-memory shard. */
export async function bootAbuseWorld(): Promise<AbuseWorld> {
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);

  // Seed a player with a docked ship so fire / mine / sell have a target.
  const player = await repo.createPlayer({ callsign: "PILOT-ABUSE", homeSystemId: SYSTEM_ID });
  const shipRow = await repo.getOrCreateStarterShip(player.id, "scout");
  const baseCargo = cargoHoldFor("scout");
  const { hold: cargo } = addToCargo(baseCargo, "iron", 100);
  await repo.saveShipState(shipRow.id, { cargo });
  await repo.saveInventory(player.id, emptyInventory());
  await repo.addCredits(player.id, 500); // 500 starter credits

  const sentFrames: AbuseWorld["sentFrames"] = [];

  const playerEntity: SimEntity = makePlayerEntity({
    id: `entity:${shipRow.id}`,
    shipId: shipRow.id,
    playerId: player.id,
    callsign: player.callsign,
    classId: "scout",
    hull: 100,
    shields: 50,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: PLANET_ID,
    onPad: PAD_ID,
  });

  const aiEntity = makeAiEntity({
    id: "ai-abuse-1",
    classId: "scout",
    pos: { x: 100, y: 0, z: 0 },
  });

  // Seed a deposit close enough to the player that mine commands are
  // in-range. `resourceBasePrice` + `resourceWeight` resolve the catalog.
  const depositList = depositsFor({
    seed: "drift-abuse-seed",
    systemId: "0000000000000001",
  });
  if (depositList.length === 0) throw new Error("abuse harness: no deposits seeded");
  const depositSpec = depositList[0]!;
  const initialDepositAmount = depositSpec.amount;
  const depositEntity: SimEntity = {
    id: depositSpec.depositId,
    kind: "deposit",
    playerId: null,
    callsign: null,
    classId: null,
    hull: 0,
    shields: 0,
    targetId: null,
    pos: depositSpec.pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: PLANET_ID,
    onPad: null,
    resourceType: depositSpec.resourceId,
    amount: initialDepositAmount,
    initialAmount: initialDepositAmount,
    depositSeq: 0,
    discovered: true,
  };

  const entities = new Map<string, SimEntity>();
  entities.set(playerEntity.id, playerEntity);
  entities.set(aiEntity.id, aiEntity);
  entities.set(depositEntity.id, depositEntity);

  // A character (on-foot) entity, parked next to the deposit so
  // mining tests have a valid character to bind. Distinct entity
  // id from the ship so a test can rebind the connection between
  // them (most cheats stay on the ship; mining cheats re-bind
  // to the character via `exit_ship` first).
  const characterEntity: SimEntity = {
    id: `character:${player.id}`,
    kind: "character",
    playerId: player.id,
    callsign: player.callsign,
    classId: null,
    hull: 100,
    shields: 0,
    targetId: null,
    pos: { x: depositSpec.pos.x, y: depositSpec.pos.y, z: depositSpec.pos.z },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: PLANET_ID,
    onPad: null,
    onShipId: shipRow.id,
  };
  entities.set(characterEntity.id, characterEntity);

  const shard: Shard = createShard({
    systemId: SYSTEM_ID,
    context: makeContext(),
    send: (connId, frame) => {
      sentFrames.push({ connId, frame: frame as { type: string; payload: unknown } });
    },
    broadcast: () => undefined,
    autoStart: false,
    repo,
  });
  // Start the sim loop (the abuse tests need mining cadence +
  // weapon cooldown to tick). The production boot path starts the
  // sim inside `attachWs`-adjacent wiring, but the harness skips
  // that step so we don't double-start.
  shard.sim.start();
  // Hydrate the live shard with our seed entities (createShard ships
  // with an empty registry; the abuse world pre-populates it).
  for (const [id, e] of entities) {
    shard.entities.set(id, e);
  }

  const app = Fastify({ logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);

  // Compute the address here so we can return it; `app.server.address()`
  // returns `null` once the server is closed.
  void app;
  const wsOptions: WsHandleOptions = {
    authResolver: async (payload) => {
      const callsign = (payload as { callsign?: string }).callsign ?? "anon";
      const p = await repo.createPlayer({ callsign, homeSystemId: SYSTEM_ID });
      await repo.getOrCreateStarterShip(p.id, "scout");
      await repo.saveInventory(p.id, emptyInventory());
      return { playerId: p.id, callsign, tokenExpiresAt: Date.now() + 60_000 };
    },
    joinResolver: async (systemId, callsign) => ({
      systemId,
      entities: [...shard.entities.values()].map(entityToWire),
      nodes: [],
      chat: [],
      players: [callsign],
      serverTickHz: 20,
      snapshotTick: 0,
    }),
    logoutResolver: async (playerId) => {
      const p = await repo.findPlayerById(playerId);
      return { revoked: 1, callsign: p?.callsign ?? "" };
    },
    warpResolver: async () => {
      throw Object.assign(new Error("warp disabled in abuse harness"), {
        code: "same-system",
        targetSystemId: SYSTEM_ID,
      });
    },
    shardFor: () => shard,
    repo,
  };
  const wsHandle = attachWs(app, "/ws", wsOptions);
  const url = `ws://127.0.0.1:${port}/ws`;

  const initialBalance = (await repo.getBalance(player.id)) ?? 500;

  return {
    shard,
    repo,
    closeDb: close,
    playerIds: { [player.callsign]: player.id },
    playerEntityIds: { [player.callsign]: playerEntity.id },
    characterEntityIds: { [player.callsign]: characterEntity.id },
    aiEntityId: aiEntity.id,
    depositEntityId: depositEntity.id,
    initialCredits: initialBalance,
    initialDepositAmount,
    sentFrames,
    // Surface for cleanup; not part of the public surface.
    __wsHandle: wsHandle,
    __app: app,
    __port: port,
    __url: url,
  } as AbuseWorld & {
    __wsHandle: WsHandle;
    __app: FastifyInstance;
    __port: number;
    __url: string;
  };
}

/** Convenience accessor for the WS URL the abuse world exposes. */
export function abuseUrl(world: AbuseWorld): string {
  return (world as unknown as { __url: string }).__url;
}

/** Convenience accessor for the live WS handle. */
export function abuseHandle(world: AbuseWorld): WsHandle {
  return (world as unknown as { __wsHandle: WsHandle }).__wsHandle;
}

/** Convenience accessor for the Fastify app (so tests can close cleanly). */
export function abuseApp(world: AbuseWorld): FastifyInstance {
  return (world as unknown as { __app: FastifyInstance }).__app;
}

/** Tear down the full abuse world (Fastify + ws + sqlite). */
export async function teardownAbuseWorld(world: AbuseWorld): Promise<void> {
  const handle = abuseHandle(world);
  const app = abuseApp(world);
  await handle.close();
  await app.close();
  world.closeDb();
  // Shut down the live shard (the harness doesn't autoStart, but
  // we call shutdown for symmetry with production teardown).
  world.shard.shutdown();
}

// ---------------------------------------------------------------------------
// Wire-shape helpers
// ---------------------------------------------------------------------------

function entityToWire(e: SimEntity): ProtocolEntityState {
  const target = e.targetId ?? null;
  const wire: ProtocolEntityState = {
    id: e.id,
    kind: e.kind === "player" ? "ship" : (e.kind as ProtocolEntityState["kind"]),
    pos: [e.pos.x, e.pos.y, e.pos.z],
    vel: [e.vel.x, e.vel.y, e.vel.z],
    regime: e.regime,
    hull: e.hull,
    shields: e.shields,
    targetId: target,
    livery: null,
    callsign: e.callsign ?? null,
    classId: e.classId ?? null,
    onPad: e.onPad ?? null,
    ...(e.kind === "deposit"
      ? {
          resourceType: e.resourceType ?? "",
          amount: e.amount,
          initialAmount: e.initialAmount,
          discovered: e.discovered ?? false,
        }
      : {}),
  };
  return wire;
}

function makeContext(): ShardSystemContext {
  return {
    system: {
      systemId: SYSTEM_ID,
      star: {
        id: STAR_ID,
        seed: 1n,
        name: "Abuse Star",
        position: { x: 0, y: 0, z: 0 },
        spectral: "G",
        luminosity: 1,
        habitableZoneAu: 1,
        orbitAu: 0,
      },
      planets: [
        {
          id: PLANET_ID,
          name: "Abuse-Prime",
          orbitIndex: 0,
          radius: 1000,
          hasAtmosphere: true,
          starId: STAR_ID,
        },
      ],
      stations: [],
      resourceNodes: [],
    } as unknown as ShardSystemContext["system"],
    starId: STAR_ID,
    planetById: () => undefined,
    heightAtFor: () => () => 0,
    tileSizeM: 64,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for the cheat tests
// ---------------------------------------------------------------------------

export { PROTOCOL_VERSION, resourceBasePrice };
