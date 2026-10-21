/**
 * TASK-75 — remote entity layer unit tests.
 *
 * The layer is React-free and clock-free: `sync(buffers, nowMs)`
 * takes a plain map of `RemoteEntityBuffer`s, so every case here
 * drives it with real buffers from `@client/net/prediction` and a
 * synthetic render clock. Cases map 1:1 onto the spec's list:
 *
 *   (b) two pushes then a sample → mesh transform matches
 *   (c) a sample older than REMOTE_STALE_MS hides the mesh
 *   (d) removing an id releases the mesh back to the pool
 *   (e) the own entity id is never rendered
 *   + pooling reuse across add/remove cycles, kind swaps, drone
 *     spin and the throw-guard around a malformed buffer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MeshStandardMaterial } from "three";

import { ShipPaintRegistry } from "@client/ships/ShipMeshBuilder.js";
import { createThreeMaterialAdapter } from "@client/ships/threeAdapter.js";
import { RemoteEntityBuffer, REMOTE_STALE_MS, type SimEntityLite } from "@client/net/prediction.js";

import {
  DEFAULT_REMOTE_KIND,
  REMOTE_RELEASE_STALE_MS,
  RemoteEntityLayer,
  STATIC_REMOTE_KINDS,
} from "./RemoteEntityLayer.js";

import type { ProtocolEntityKind } from "@shared/protocol/index.js";

/** Build a `SimEntityLite` with sensible defaults for the fields
 *  the interpolator copies but the renderer never reads. */
function lite(id: string, x: number, y = 0, z = 0, kind?: ProtocolEntityKind): SimEntityLite {
  return {
    id,
    pos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    hull: 100,
    shields: 50,
    onPad: null,
    ...(kind !== undefined ? { kind } : {}),
  };
}

/** A buffer that has "just been seen" — fresh, not stale. */
function freshBuffer(id: string, kind?: ProtocolEntityKind): RemoteEntityBuffer {
  const buf = new RemoteEntityBuffer();
  const t = 1_000;
  buf.push(t, lite(id, 0, 0, 0, kind));
  buf.push(t + 200, lite(id, 10, 0, 0, kind));
  return buf;
}

function makeLayer(ownEntityIds: string[] = []): RemoteEntityLayer {
  const registry = new ShipPaintRegistry(createThreeMaterialAdapter(MeshStandardMaterial));
  return new RemoteEntityLayer({ context: { paintRegistry: registry }, ownEntityIds });
}

describe("RemoteEntityLayer", () => {
  let layer: RemoteEntityLayer;

  beforeEach(() => {
    layer = makeLayer();
  });

  it("(b) writes the interpolated pose from sample() onto the mesh", () => {
    const buf = new RemoteEntityBuffer();
    buf.push(0, lite("e:1", 0));
    buf.push(200, lite("e:1", 10));
    // Render clock 300 → sample at 300 - INTERP_DELAY_MS(200) =
    // 100 ms, exactly between the two snapshots.
    layer.sync(new Map([["e:1", buf]]), 300);
    const object = layer.objectOf("e:1");
    expect(object).not.toBeNull();
    expect(object!.visible).toBe(true);
    expect(object!.position.x).toBeCloseTo(5, 6);
    expect(layer.remoteMeshCount).toBe(1);
  });

  it("(b) follows a moving remote across frames", () => {
    const buf = new RemoteEntityBuffer();
    buf.push(0, lite("e:1", 0));
    buf.push(200, lite("e:1", 100));
    layer.sync(new Map([["e:1", buf]]), 300);
    expect(layer.objectOf("e:1")!.position.x).toBeCloseTo(50, 6);
    buf.push(400, lite("e:1", 100));
    layer.sync(new Map([["e:1", buf]]), 500);
    expect(layer.objectOf("e:1")!.position.x).toBeCloseTo(100, 6);
  });

  it("(c) hides a mesh whose newest snapshot is older than REMOTE_STALE_MS", () => {
    const buf = freshBuffer("e:1");
    layer.sync(new Map([["e:1", buf]]), 1_400);
    expect(layer.remoteMeshCount).toBe(1);
    // +REMOTE_STALE_MS + 1 → stale → hidden, still pooled.
    layer.sync(new Map([["e:1", buf]]), 1_400 + REMOTE_STALE_MS + 1);
    expect(layer.objectOf("e:1")!.visible).toBe(false);
    expect(layer.remoteMeshCount).toBe(0);
    expect(layer.attachedCount).toBe(1);
    // Much later → released back to the pool entirely.
    layer.sync(new Map([["e:1", buf]]), 1_400 + REMOTE_RELEASE_STALE_MS + 1);
    expect(layer.attachedCount).toBe(0);
    expect(layer.pooledCount("ship")).toBe(1);
  });

  it("(c) hides an entity whose buffer is still empty (no sample yet)", () => {
    layer.sync(new Map([["e:1", new RemoteEntityBuffer()]]), 1_000);
    expect(layer.remoteMeshCount).toBe(0);
  });

  it("(c) keeps static world props on screen when their buffer goes stale", () => {
    // The shard only re-publishes deposits/terminals when they
    // change, so "stale" is the normal state for them.
    const buf = freshBuffer("prop:1", "deposit");
    layer.sync(new Map([["prop:1", buf]]), 1_400);
    layer.sync(new Map([["prop:1", buf]]), 1_400 + REMOTE_STALE_MS * 10);
    expect(STATIC_REMOTE_KINDS.has("deposit")).toBe(true);
    expect(layer.objectOf("prop:1")!.visible).toBe(true);
    expect(layer.remoteMeshCount).toBe(1);
    // A dynamic kind under the same conditions still goes away.
    const ship = freshBuffer("e:1");
    layer.sync(
      new Map([
        ["prop:1", buf],
        ["e:1", ship],
      ]),
      1_400 + REMOTE_STALE_MS * 10,
    );
    expect(layer.remoteMeshCount).toBe(1);
    expect(layer.objectOf("e:1")!.visible).toBe(false);
  });

  it("(d) releases the mesh when an id leaves the buffer map", () => {
    const map = new Map([
      ["e:1", freshBuffer("e:1")],
      ["e:2", freshBuffer("e:2")],
    ]);
    layer.sync(map, 1_400);
    expect(layer.remoteMeshCount).toBe(2);
    const pooled = layer.objectOf("e:1");
    map.delete("e:1");
    layer.sync(map, 1_450);
    expect(layer.attachedCount).toBe(1);
    expect(layer.remoteMeshCount).toBe(1);
    expect(layer.pooledCount("ship")).toBe(1);
    expect(layer.poolLiveCount).toBe(1);
    // The same object comes back out of the pool when the id
    // reappears — that is the reuse the 16-player budget rests on.
    map.set("e:1", freshBuffer("e:1"));
    layer.sync(map, 1_500);
    expect(layer.objectOf("e:1")).toBe(pooled);
    expect(layer.poolLiveCount).toBe(2);
  });

  it("(e) never renders the own entity id", () => {
    const own = makeLayer(["entity:mine"]);
    const map = new Map([
      ["entity:mine", freshBuffer("entity:mine")],
      ["e:2", freshBuffer("e:2")],
    ]);
    own.sync(map, 1_400);
    expect(own.remoteMeshCount).toBe(1);
    expect(own.objectOf("entity:mine")).toBeNull();
    expect(own.objectOf("e:2")).not.toBeNull();
    // Clearing the filter lets it through (the handshake case).
    own.setOwnEntityIds([]);
    own.sync(map, 1_450);
    expect(own.remoteMeshCount).toBe(2);
  });

  it("picks the mesh per wire kind and swaps when the kind changes", () => {
    const buf = freshBuffer("e:1", "drone");
    layer.sync(new Map([["e:1", buf]]), 1_400);
    expect(layer.kindOf("e:1")).toBe("drone");
    // Land on a pad: the shard starts publishing `character`.
    buf.push(1_600, lite("e:1", 10, 0, 0, "character"));
    buf.push(1_800, lite("e:1", 10, 0, 0, "character"));
    layer.sync(new Map([["e:1", buf]]), 1_900);
    expect(layer.kindOf("e:1")).toBe("character");
    expect(layer.pooledCount("drone")).toBe(1);
  });

  it("defaults to the ship mesh when the snapshot carries no kind", () => {
    const buf = freshBuffer("e:1");
    layer.sync(new Map([["e:1", buf]]), 1_400);
    expect(layer.kindOf("e:1")).toBe(DEFAULT_REMOTE_KIND);
  });

  it("spins drones about their own axis without losing the pose", () => {
    const buf = freshBuffer("e:1", "drone");
    layer.sync(new Map([["e:1", buf]]), 1_400);
    const a = layer.objectOf("e:1")!.quaternion.clone();
    buf.push(1_600, lite("e:1", 10, 0, 0, "drone"));
    buf.push(1_800, lite("e:1", 10, 0, 0, "drone"));
    layer.sync(new Map([["e:1", buf]]), 1_900);
    const object = layer.objectOf("e:1")!;
    expect(object.quaternion.equals(a)).toBe(false);
    expect(object.position.x).toBeCloseTo(10, 6);
    // Unit quaternion — a spin must never scale the object.
    expect(object.quaternion.length()).toBeCloseTo(1, 6);
  });

  it("survives a buffer that throws and counts the error", () => {
    const boom = {
      sample(): never {
        throw new Error("malformed snapshot");
      },
    } as unknown as RemoteEntityBuffer;
    const map = new Map<string, RemoteEntityBuffer>([["e:bad", boom]]);
    expect(() => layer.sync(map, 1_400)).not.toThrow();
    expect(layer.errorCount).toBe(1);
    expect(layer.attachedCount).toBe(0);
    // A good entity in the same frame still renders.
    map.set("e:2", freshBuffer("e:2"));
    layer.sync(map, 1_450);
    expect(layer.remoteMeshCount).toBe(1);
  });

  it("counts down to 0 and releases everything on dispose (idempotent)", () => {
    const map = new Map([
      ["e:1", freshBuffer("e:1")],
      ["e:2", freshBuffer("e:2", "wreck")],
    ]);
    layer.sync(map, 1_400);
    expect(layer.remoteMeshCount).toBe(2);
    layer.dispose();
    expect(layer.remoteMeshCount).toBe(0);
    expect(layer.attachedCount).toBe(0);
    expect(layer.poolLiveCount).toBe(0);
    expect(() => layer.dispose()).not.toThrow();
  });

  it("stays bounded when many players join and leave", () => {
    const map = new Map<string, RemoteEntityBuffer>();
    for (let i = 0; i < 16; i++) map.set(`e:${i}`, freshBuffer(`e:${i}`));
    layer.sync(map, 1_400);
    expect(layer.remoteMeshCount).toBe(16);
    expect(layer.poolLiveCount).toBe(16);
    for (const id of [...map.keys()]) map.delete(id);
    layer.sync(map, 1_500);
    expect(layer.remoteMeshCount).toBe(0);
    expect(layer.poolLiveCount).toBe(0);
    expect(layer.pooledCount("ship")).toBe(16);
    // Re-adding everyone reuses the pooled meshes (no new builds).
    for (let i = 0; i < 16; i++) map.set(`e:${i}`, freshBuffer(`e:${i}`));
    layer.sync(map, 1_600);
    expect(layer.poolLiveCount).toBe(16);
    expect(layer.pooledCount("ship")).toBe(0);
  });
});
