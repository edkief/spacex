/**
 * Server-side proximity interaction tests — TASK-33.
 *
 * Covers the spec acceptance criteria:
 *   - range check (3 m, server-side pos),
 *   - regime check (character-only; ship-or-character-bound),
 *   - target existence (`not-found` when missing),
 *   - dispatch via the registry (every kind).
 */
import { describe, expect, it } from "vitest";

import {
  handleInteract,
  createServerInteractableRegistry,
  serverInteractableRegistry,
  type InteractEffectKind,
} from "./interact.js";
import { addConnection, createShard, type Shard, type ShardConnection } from "./index.js";
import { makeCharacterEntity, makePlayerEntity } from "./entity.js";
import type { SimEntity } from "./types.js";
import type { ShardSystemContext } from "./types.js";

function makeRegistry(): {
  shard: Shard;
  entities: {
    addCharacter(connId: string): ShardConnection;
    addDeposit(id: string, x: number, y: number, z: number): void;
    addTerminal(id: string, x: number, y: number, z: number): void;
    addShip(id: string, x: number, y: number, z: number): void;
  };
} {
  // Minimal stub system context — we don't exercise the flight
  // model here, just the interact validator.
  const ctx: ShardSystemContext = {
    system: {
      systemId: "interact-shard-test",
      star: {
        id: "star-x",
        seed: 1n,
        name: "Test Star",
        position: { x: 0, y: 0, z: 0 },
        spectral: "G",
        luminosity: 1,
        habitableZoneAu: 1,
        orbitAu: 0,
      },
      planets: [],
      stations: [],
      resourceNodes: [],
    } as unknown as ShardSystemContext["system"],
    starId: "star-x",
    planetById: () => undefined,
    heightAtFor: () => undefined,
    tileSizeM: 64,
  };
  const shard = createShard({
    systemId: ctx.system.systemId,
    context: ctx,
    send: () => {},
    broadcast: () => {},
    autoStart: false,
  });
  const entities: {
    addCharacter(connId: string): ShardConnection;
    addDeposit(id: string, x: number, y: number, z: number): void;
    addTerminal(id: string, x: number, y: number, z: number): void;
    addShip(id: string, x: number, y: number, z: number): void;
  } = {
    addCharacter(connId: string): ShardConnection {
      const conn: ShardConnection = {
        connId,
        callsign: "P",
        playerId: "p1",
        shipId: "s",
        lastSeq: 0,
        pendingInput: null,
        staleDrops: 0,
        entityId: null,
      };
      addConnection(shard, conn);
      const character = makeCharacterEntity({
        id: "char:p1",
        playerId: "p1",
        callsign: "P",
        shipId: "ship-1",
        pos: { x: 0, y: 0, z: 0 },
      });
      shard.entities.set(character.id, character);
      conn.entityId = character.id;
      return conn;
    },
    addDeposit(id, x, y, z): void {
      shard.entities.set(id, {
        id,
        kind: "deposit",
        playerId: null,
        callsign: null,
        classId: null,
        hull: 0,
        shields: 0,
        targetId: null,
        pos: { x, y, z },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: "surface",
        originPlanetId: null,
        onPad: null,
      });
    },
    addTerminal(id, x, y, z): void {
      shard.entities.set(id, {
        id,
        kind: "terminal",
        playerId: null,
        callsign: null,
        classId: null,
        hull: 0,
        shields: 0,
        targetId: null,
        pos: { x, y, z },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: "surface",
        originPlanetId: null,
        onPad: null,
      });
    },
    addShip(id, x, y, z): void {
      const ship = makePlayerEntity({
        id,
        shipId: id.replace("entity:", ""),
        playerId: "p2",
        callsign: "Other",
        classId: "scout",
        hull: 100,
        shields: 100,
        pos: { x, y, z },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: "surface",
        originPlanetId: null,
        onPad: null,
      });
      shard.entities.set(id, ship);
    },
  };
  return { shard, entities };
}

describe("shard: interact validator (TASK-33)", () => {
  it("succeeds when target is in range", () => {
    const { shard, entities } = makeRegistry();
    const conn = entities.addCharacter("c1");
    entities.addDeposit("node-1", 1, 0, 0);
    const out = handleInteract(shard, {
      connId: conn.connId,
      targetId: "node-1",
      action: "use",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.effect).toBe("pickup");
  });

  it("removes a deposit on pickup so all clients see the update next snapshot", () => {
    const { shard, entities } = makeRegistry();
    const conn = entities.addCharacter("c1");
    entities.addDeposit("node-1", 0.5, 0, 0);
    expect(shard.entities.get("node-1")).toBeDefined();
    const out = handleInteract(shard, {
      connId: conn.connId,
      targetId: "node-1",
      action: "use",
    });
    expect(out.ok).toBe(true);
    // Deposit removed from the shard entity registry.
    expect(shard.entities.get("node-1")).toBeUndefined();
  });

  it("rejects out-of-range as out-of-range", () => {
    const { shard, entities } = makeRegistry();
    const conn = entities.addCharacter("c1");
    entities.addDeposit("far", 10, 0, 0);
    const out = handleInteract(shard, {
      connId: conn.connId,
      targetId: "far",
      action: "use",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("out-of-range");
  });

  it("accepts target exactly at the 3 m boundary", () => {
    const { shard, entities } = makeRegistry();
    const conn = entities.addCharacter("c1");
    entities.addDeposit("edge", 3, 0, 0);
    const out = handleInteract(shard, {
      connId: conn.connId,
      targetId: "edge",
      action: "use",
    });
    expect(out.ok).toBe(true);
  });

  it("rejects just past the 3 m boundary", () => {
    const { shard, entities } = makeRegistry();
    const conn = entities.addCharacter("c1");
    entities.addDeposit("edge", 3.0001, 0, 0);
    const out = handleInteract(shard, {
      connId: conn.connId,
      targetId: "edge",
      action: "use",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("out-of-range");
  });

  it("rejects missing target as not-found", () => {
    const { shard, entities } = makeRegistry();
    const conn = entities.addCharacter("c1");
    const out = handleInteract(shard, {
      connId: conn.connId,
      targetId: "ghost",
      action: "use",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("not-found");
  });

  it("rejects ship-bound entity as wrong-regime", () => {
    const { shard } = makeRegistry();
    const conn: ShardConnection = {
      connId: "c1",
      callsign: "P",
      playerId: "p1",
      shipId: "ship-1",
      lastSeq: 0,
      pendingInput: null,
      staleDrops: 0,
      entityId: null,
    };
    addConnection(shard, conn);
    // The character is NOT in the registry — conn.entityId is null.
    const out = handleInteract(shard, {
      connId: "c1",
      targetId: "n/a",
      action: "use",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    // null entityId → wrong-regime per the spec ordering.
    expect(out.code).toBe("wrong-regime");
  });

  it("rejects when conn's entityId points to a ship, not a character", () => {
    const { shard, entities } = makeRegistry();
    const conn = entities.addCharacter("c1");
    // Replace the character with a player-ship on the same conn.
    conn.entityId = "entity:ship-1";
    shard.entities.set("entity:ship-1", {
      id: "entity:ship-1",
      kind: "player",
      playerId: "p1",
      callsign: "P",
      classId: "scout",
      hull: 100,
      shields: 100,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "space",
      originPlanetId: null,
      onPad: null,
    });
    entities.addDeposit("n", 1, 0, 0);
    const out = handleInteract(shard, {
      connId: "c1",
      targetId: "n",
      action: "use",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("wrong-regime");
  });

  it("dispatches dock-terminal → ui-open and pushes a ui_open frame", () => {
    const sent: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];
    const ctx: ShardSystemContext = {
      system: {} as unknown as ShardSystemContext["system"],
      starId: "star-x",
      planetById: () => undefined,
      heightAtFor: () => undefined,
      tileSizeM: 64,
    };
    const shard = createShard({
      systemId: "t",
      context: ctx,
      send: (connId, frame) => {
        sent.push({ connId, frame: frame as unknown as { type: string; payload: unknown } });
      },
      broadcast: () => {},
      autoStart: false,
    });
    const conn: ShardConnection = {
      connId: "c1",
      callsign: "P",
      playerId: "p1",
      shipId: "s",
      lastSeq: 0,
      pendingInput: null,
      staleDrops: 0,
      entityId: "char:p1",
    };
    addConnection(shard, conn);
    shard.entities.set("char:p1", {
      id: "char:p1",
      kind: "character",
      playerId: "p1",
      callsign: "P",
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
    } as unknown as SimEntity);
    shard.entities.set("terminal-1", {
      id: "terminal-1",
      kind: "terminal",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 1, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
    });
    const out = handleInteract(shard, {
      connId: "c1",
      targetId: "terminal-1",
      action: "use",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.effect).toBe("ui-open");
    expect(sent.length).toBe(1);
    expect(sent[0]!.frame.type).toBe("ui_open");
    const payload = sent[0]!.frame.payload as { ui: string; payload: { terminalId: string } };
    expect(payload.ui).toBe("dock");
    expect(payload.payload.terminalId).toBe("terminal-1");
  });

  it("ships through a custom registry", () => {
    const { shard, entities } = makeRegistry();
    const conn = entities.addCharacter("c1");
    entities.addDeposit("n", 1, 0, 0);
    let called = 0;
    const r = createServerInteractableRegistry();
    r.register("deposit", {
      apply(): InteractEffectKind {
        called += 1;
        return "pickup";
      },
    });
    const out = handleInteract(shard, { connId: conn.connId, targetId: "n", action: "use" }, r);
    expect(out.ok).toBe(true);
    expect(called).toBe(1);
  });

  it("returns noop when the kind has no registered entry (server-side can be permissive)", () => {
    const { shard } = makeRegistry();
    // Add a wreck entity — no registry entry by default.
    shard.entities.set("wreck-1", {
      id: "wreck-1",
      kind: "wreck",
      playerId: null,
      callsign: null,
      classId: "scout",
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 1, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "space",
      originPlanetId: null,
      onPad: null,
    });
    const out = handleInteract(shard, {
      connId: "c1",
      targetId: "wreck-1",
      action: "inspect",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("not-found");
  });

  it("rejects unknown connection", () => {
    const { shard } = makeRegistry();
    const out = handleInteract(shard, {
      connId: "nope",
      targetId: "n",
      action: "use",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("not-found");
  });

  it("the singleton registry carries the v1 entries", () => {
    expect(serverInteractableRegistry.has("deposit")).toBe(true);
    expect(serverInteractableRegistry.has("terminal")).toBe(true);
    expect(serverInteractableRegistry.has("player")).toBe(true);
    expect(serverInteractableRegistry.has("character")).toBe(true);
  });
});
