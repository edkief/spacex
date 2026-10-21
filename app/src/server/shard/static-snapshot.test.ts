/**
 * Static/dynamic snapshot split — TASK-18.
 *
 * The 16-player load test measured 76 % of the broadcast frame being
 * unchanged static content (120 deposits re-serialized 10x/s = 33 KB
 * of a 43 KB payload). The fix splits the stream:
 *
 *   - `buildSnapshotEntities` (join / warp / event paths) keeps
 *     returning everything,
 *   - `buildDynamicSnapshotEntities` (the 10 Hz tick broadcast)
 *     drops the static kinds,
 *   - `pushDepositUpdate` pushes a one-entity `entity_update` to
 *     nearby connections when a deposit actually changes.
 *
 * These tests pin the split, the radius filter and the wire shape.
 */
import { describe, expect, it } from "vitest";

import { createShard, buildSnapshotEntities, buildDynamicSnapshotEntities } from "./index.js";
import { pushDepositUpdate, DEPOSIT_UPDATE_RADIUS_M } from "./deposit-update.js";
import type { Shard, ShardConnection, ShardSystemContext, SimEntity } from "./types.js";

const PAD = { padId: "pad-a", planetId: "planet-a", x: 0, y: 0, z: 0 };

function makeContext(): ShardSystemContext {
  return {
    starId: "star-test",
    system: {
      systemId: "test-system",
      name: "Test",
      star: { id: "star-test", name: "Test Star", class: "G", x: 0, y: 0, z: 0, systemCount: 1 },
      planets: [],
    },
    planetById: () => undefined,
    heightAtFor: () => undefined,
    tileSizeM: 64,
    padsForSystem: () => [
      {
        padId: PAD.padId,
        planetId: PAD.planetId,
        kind: "station" as const,
        pos: { x: PAD.x, y: PAD.y, z: PAD.z },
        normal: { x: 0, y: 1, z: 0 },
        radius: 20,
        exitRadius: 25,
      },
    ],
  } as unknown as ShardSystemContext;
}

interface Recorder {
  shard: Shard;
  frames: Array<{ connId: string; type: string; payload: unknown }>;
}

function makeShard(): Recorder {
  const frames: Recorder["frames"] = [];
  const shard = createShard({
    systemId: "test-system",
    context: makeContext(),
    send: (connId, frame) =>
      frames.push({
        connId,
        type: String((frame as { type: string }).type),
        payload: (frame as { payload: unknown }).payload,
      }),
    broadcast: () => undefined,
    onTickObserver: null,
    autoStart: false,
  });
  return { shard, frames };
}

function makeConnection(args: {
  connId: string;
  playerId: string;
  entityId: string;
}): ShardConnection {
  return {
    connId: args.connId,
    callsign: `pilot-${args.playerId}`,
    playerId: args.playerId,
    entityId: args.entityId,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  } as unknown as ShardConnection;
}

/** Minimal entity stub covering the fields `entityToWire` reads. */
function makeEntity(args: {
  id: string;
  kind: string;
  pos: { x: number; y: number; z: number };
}): SimEntity {
  return {
    id: args.id,
    kind: args.kind,
    pos: args.pos,
    vel: { x: 0, y: 0, z: 0 },
    regime: "space",
    hull: 100,
    shields: 100,
    onPad: null,
    playerId: null,
    aiId: null,
  } as unknown as SimEntity;
}

/** Register an entity stub in the shard's registry. */
function add(shard: Shard, entity: SimEntity): void {
  shard.entities.set(entity.id, entity);
}

describe("shard snapshot split (TASK-18)", () => {
  it("buildDynamicSnapshotEntities drops deposits and terminals, keeps moving entities", () => {
    const { shard } = makeShard();
    add(shard, makeEntity({ id: "ship-1", kind: "ship", pos: { x: 0, y: 0, z: 0 } }));
    add(shard, makeEntity({ id: "deposit-1", kind: "deposit", pos: { x: 10, y: 0, z: 0 } }));
    add(shard, makeEntity({ id: "term-1", kind: "terminal", pos: { x: 20, y: 0, z: 0 } }));

    const full = buildSnapshotEntities(shard).map((e) => e.id);
    const dynamic = buildDynamicSnapshotEntities(shard).map((e) => e.id);

    expect(full).toContain("deposit-1");
    expect(full).toContain("term-1");
    expect(dynamic).toContain("ship-1");
    expect(dynamic).not.toContain("deposit-1");
    expect(dynamic).not.toContain("term-1");
    shard.shutdown();
  });

  it("pushDepositUpdate reaches nearby connections only", () => {
    const rec = makeShard();
    const deposit = makeEntity({ id: "deposit-1", kind: "deposit", pos: { x: 0, y: 0, z: 0 } });
    const near = makeEntity({ id: "ship-near", kind: "ship", pos: { x: 100, y: 0, z: 0 } });
    const far = makeEntity({
      id: "ship-far",
      kind: "ship",
      pos: { x: DEPOSIT_UPDATE_RADIUS_M + 500, y: 0, z: 0 },
    });
    rec.shard.entities.set(deposit.id, deposit);
    rec.shard.entities.set(near.id, near);
    rec.shard.entities.set(far.id, far);
    rec.shard.connections.set(
      "conn-near",
      makeConnection({ connId: "conn-near", playerId: "p1", entityId: near.id }),
    );
    rec.shard.connections.set(
      "conn-far",
      makeConnection({ connId: "conn-far", playerId: "p2", entityId: far.id }),
    );

    pushDepositUpdate(rec.shard, deposit);

    const sent = rec.frames.filter((f) => f.type === "entity_update");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.connId).toBe("conn-near");
    const payload = sent[0]!.payload as {
      entities: { id: string }[];
      systemId: string;
      tick: number;
    };
    expect(payload.systemId).toBe("test-system");
    expect(payload.entities.map((e) => e.id)).toEqual(["deposit-1"]);
    rec.shard.shutdown();
  });

  it("the static split shrinks the measured frame well under the 16 KB budget", () => {
    const { shard } = makeShard();
    for (let i = 0; i < 120; i++) {
      add(
        shard,
        makeEntity({ id: `deposit-${i}`, kind: "deposit", pos: { x: i * 7, y: 0, z: i * 3 } }),
      );
    }
    for (let i = 0; i < 16; i++) {
      add(shard, makeEntity({ id: `ship-${i}`, kind: "ship", pos: { x: i * 11, y: 0, z: 0 } }));
    }
    const full = Buffer.byteLength(JSON.stringify(buildSnapshotEntities(shard)), "utf8");
    const dynamic = Buffer.byteLength(JSON.stringify(buildDynamicSnapshotEntities(shard)), "utf8");
    // The stub wire shape is smaller than a real deposit's, so the
    // assertion is relative: dropping 120 static entities must cut
    // the frame by at least 4x and land inside the 16 KB budget.
    expect(full).toBeGreaterThan(dynamic * 4);
    expect(dynamic).toBeLessThan(16 * 1024);
    shard.shutdown();
  });
});
