import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntityState } from '@shared/protocol/schemas';
import { entityCounts, resetEntityRegistry } from './entity-registry';
import {
  buildGroundItemMesh,
  GROUND_ITEM_COLORS,
  labelOpacity,
  MAX_CALLSIGN_LABELS,
  RemoteEntityLayer,
  WRECK_KILLER_MARK_M,
  wreckLabelText,
} from './remote-entities';
import { AI_SHIP_TRIM_COLOR } from './remote-ships';
import { __resetKillFeed, indexKillFeedPlayers } from '@client/state/kill-feed';

/**
 * TASK-36 step 4 (+ TASK-74): RemoteEntityLayer unit tests — label fade
 * math, ground-item colors, callsign-based self exclusion, the 200 ms
 * interpolated placement, livery tint, removal, the label cap /
 * behind-camera handling, and the remote-ship render path (create-once /
 * re-tint / rebuild-on-class-change / dispose / self exclusion / AI trim /
 * label dedup).
 * Node environment (no DOM): the label pipeline is asserted through the
 * pure `labelStates`; the mesh layer through three.js objects.
 */

const V3 = { x: 0, y: 0, z: 0 };

function entity(id: string, kind: string, pos: { x: number; y: number; z: number }): EntityState {
  return {
    id,
    kind: kind as EntityState['kind'],
    pos,
    vel: { ...V3 },
    regime: 'sublight',
    hull: 1,
    shields: 1,
    targetId: null,
    classId: 'test',
  };
}

function character(
  id: string,
  callsign: string,
  pos: { x: number; y: number; z: number },
  extra: Partial<EntityState> = {},
): EntityState {
  return { ...entity(id, 'character', pos), callsign, onFoot: true, ...extra };
}

function ship(
  id: string,
  callsign: string,
  pos: { x: number; y: number; z: number },
  extra: Partial<EntityState> = {},
): EntityState {
  return { ...entity(id, 'ship', pos), callsign, classId: 'scout', ...extra };
}

/** The character layer's parented mesh group (the first child, when one exists). */
function meshOf(parent: THREE.Group): THREE.Group | undefined {
  return parent.children[0] as THREE.Group | undefined;
}

describe('labelOpacity (callsign billboard fade)', () => {
  it('full within 4 m, linear to zero at 10 m', () => {
    expect(labelOpacity(0)).toBe(1);
    expect(labelOpacity(4)).toBe(1);
    expect(labelOpacity(7)).toBeCloseTo(0.5, 5);
    expect(labelOpacity(10)).toBe(0);
    expect(labelOpacity(100)).toBe(0);
  });
});

describe('buildGroundItemMesh', () => {
  it('tints the chunk + halo per resource', () => {
    // three's getHexString() has no '#' prefix
    expect(buildGroundItemMesh('iron').mats[0].color.getHexString()).toBe(
      GROUND_ITEM_COLORS.iron.slice(1),
    );
    expect(buildGroundItemMesh('copper').mats[0].color.getHexString()).toBe(
      GROUND_ITEM_COLORS.copper.slice(1),
    );
  });
  it('falls back to the iron grey for unknown / missing resources', () => {
    // three's getHexString() has no '#' prefix
    expect(buildGroundItemMesh().mats[0].color.getHexString()).toBe('9aa4b2');
    expect(buildGroundItemMesh('mystery-ore').mats[0].color.getHexString()).toBe('9aa4b2');
  });
});

describe('RemoteEntityLayer', () => {
  beforeEach(() => {
    resetEntityRegistry();
  });

  it('excludes self from the render by CALLSIGN (frozen ship + character)', () => {
    const layer = new RemoteEntityLayer();
    layer.addSnapshot(
      100,
      [
        { ...entity('ship-me', 'ship', V3), callsign: 'me' },
        character('char-me', 'me', V3),
        character('char-bob', 'bob', { x: 1, y: 0, z: 0 }),
      ],
      'me',
    );
    layer.renderFrame(110);
    // Neither of self's entities is rendered — only bob's character.
    expect(layer.renderedIds()).toEqual(['char-bob']);
    expect(layer.labelStates(110).map((s) => s.callsign)).toEqual(['bob']);
  });

  it('renders a remote character 200 ms in the past (interpolated)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [character('char-bob', 'bob', { x: 0, y: 0, z: 0 })], 'me');
    layer.addSnapshot(300, [character('char-bob', 'bob', { x: 2, y: 0, z: 0 })], 'me');
    // now=490 → target 290 → f=(290-100)/200=0.95 → x = 2*0.95 = 1.9
    layer.renderFrame(490);
    expect(meshOf(parent)?.position.x).toBeCloseTo(1.9, 5);
    expect(entityCounts().character).toBe(1);
    expect(entityCounts().total).toBe(1);
  });

  it('tints the remote character from its livery (hull → body, accent → head)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(
      100,
      [
        character('char-bob', 'bob', V3, {
          livery: { hull: '#123456', accent: '#654321' },
        }),
      ],
      'me',
    );
    layer.renderFrame(110);
    const group = meshOf(parent)!;
    const body = (group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const head = (group.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(body.color.getHexString()).toBe('123456');
    expect(head.color.getHexString()).toBe('654321');
  });

  it('removes a character when it leaves the snapshot (mesh + registry)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [character('char-bob', 'bob', V3)], 'me');
    layer.renderFrame(110);
    const bobGroup = meshOf(parent)!;
    expect(parent.children).toHaveLength(1);
    expect(entityCounts().character).toBe(1);

    // The next batch no longer carries bob → his mesh + registry entry go.
    layer.addSnapshot(200, [character('char-alice', 'alice', V3)], 'me');
    layer.renderFrame(210);
    expect(layer.renderedIds()).toEqual(['char-alice']);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).not.toBe(bobGroup);
    expect(entityCounts().character).toBe(1);
  });

  it('renders a ground item with its resource color (no callsign label)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    const item = { ...entity('groundItem:1', 'groundItem', V3), resourceId: 'copper', quantity: 2 };
    layer.addSnapshot(100, [item], 'me');
    layer.renderFrame(110);
    expect(layer.renderedIds()).toEqual(['groundItem:1']);
    const group = meshOf(parent)!;
    const chunk = (group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(chunk.color.getHexString()).toBe(GROUND_ITEM_COLORS.copper.slice(1));
    // Ground items never get callsign labels…
    expect(layer.labelStates(110)).toEqual([]);
    // …and are not part of the frame-monitor entity registry (characters only).
    expect(entityCounts().total).toBe(0);
  });

  it('caps callsign labels at MAX_CALLSIGN_LABELS (nearest first)', () => {
    const layer = new RemoteEntityLayer();
    layer.setProjector(() => ({ x: 0, y: 0, dist: 3 }));
    const ents = Array.from({ length: 20 }, (_, i) =>
      character(`char-${i}`, `bob${i}`, { x: i, y: 0, z: 0 }),
    );
    layer.addSnapshot(100, ents, 'me');
    layer.renderFrame(110);
    const states = layer.labelStates(110);
    expect(states).toHaveLength(20);
    const visible = states.filter((s) => s.visible);
    expect(visible).toHaveLength(MAX_CALLSIGN_LABELS);
    // All projected at the same (near) distance → every label is fully opaque.
    expect(visible.every((s) => s.opacity === 1)).toBe(true);
  });

  it('hides labels behind the camera (null projection)', () => {
    const layer = new RemoteEntityLayer();
    layer.setProjector(() => null);
    layer.addSnapshot(100, [character('char-bob', 'bob', V3)], 'me');
    layer.renderFrame(110);
    const [state] = layer.labelStates(110);
    expect(state).toMatchObject({ visible: false, opacity: 0, callsign: 'bob' });
  });

  it('clear() drops everything for a system swap', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [character('char-bob', 'bob', V3)], 'me');
    layer.renderFrame(110);
    layer.clear();
    expect(layer.renderedIds()).toEqual([]);
    expect(parent.children).toHaveLength(0);
    expect(entityCounts().total).toBe(0);
  });
});

/** The unique zone materials of one ship group (hull / accent / trim). */
function shipMats(group: THREE.Group): THREE.MeshStandardMaterial[] {
  const mats = new Set<THREE.Material>();
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => mats.add(x));
      else mats.add(m);
    }
  });
  return [...mats] as THREE.MeshStandardMaterial[];
}

describe('RemoteEntityLayer — ships (TASK-74)', () => {
  beforeEach(() => {
    resetEntityRegistry();
  });

  it('a ship + an ai-ship snapshot create one mesh each, interpolated 200 ms in the past', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(
      100,
      [
        ship('s-bob', 'bob', { x: 0, y: 0, z: 0 }),
        ship('ai-1', 'ROGUE-1', V3, { kind: 'ai-ship' }),
      ],
      'me',
    );
    layer.addSnapshot(
      300,
      [
        ship('s-bob', 'bob', { x: 2, y: 0, z: 0 }),
        ship('ai-1', 'ROGUE-1', V3, { kind: 'ai-ship' }),
      ],
      'me',
    );
    // now=490 → target 290 → f=(290-100)/200=0.95 → bob's ship x = 2*0.95 = 1.9
    layer.renderFrame(490);
    expect(parent.children).toHaveLength(2);
    expect(layer.renderedIds().sort()).toEqual(['ai-1', 's-bob']);
    expect(entityCounts().ship).toBe(2);
    expect(entityCounts().total).toBe(2);
    const bobGroup = layer.shipProbes().find((p) => p.id === 's-bob')!.pos;
    expect(bobGroup.x).toBeCloseTo(1.9, 5);
    expect(parent.children[0].position.x).toBeCloseTo(1.9, 5);
  });

  it('re-tints in place on livery change without rebuilding the mesh', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [ship('s-bob', 'bob', V3, { livery: { hull: '#112233' } })], 'me');
    layer.renderFrame(110);
    const firstGroup = parent.children[0] as THREE.Group;
    expect(shipMats(firstGroup).some((m) => m.color.getHexString() === '112233')).toBe(true);

    // New livery, same classId: SAME group instance, recolor only.
    layer.addSnapshot(200, [ship('s-bob', 'bob', V3, { livery: { hull: '#445566' } })], 'me');
    layer.renderFrame(210);
    expect(parent.children[0]).toBe(firstGroup);
    expect(shipMats(firstGroup).some((m) => m.color.getHexString() === '445566')).toBe(true);
  });

  it('rebuilds the mesh when the classId changes (a ship swap)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [ship('s-bob', 'bob', V3, { classId: 'scout' })], 'me');
    layer.renderFrame(110);
    const before = parent.children[0] as THREE.Group;
    expect(layer.shipProbes()[0].classId).toBe('scout');

    layer.addSnapshot(200, [ship('s-bob', 'bob', V3, { classId: 'freighter' })], 'me');
    layer.renderFrame(210);
    expect(layer.shipProbes()[0].classId).toBe('freighter');
    // Same id, NEW silhouette — the old group was disposed and replaced.
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).not.toBe(before);
    expect(entityCounts().ship).toBe(1);
  });

  it('disposes the mesh when the ship leaves the snapshot', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [ship('s-bob', 'bob', V3), character('char-alice', 'alice', V3)], 'me');
    layer.renderFrame(110);
    expect(parent.children).toHaveLength(2);
    expect(entityCounts().ship).toBe(1);

    layer.addSnapshot(200, [character('char-alice', 'alice', V3)], 'me');
    layer.renderFrame(210);
    expect(layer.renderedIds()).toEqual(['char-alice']);
    expect(parent.children).toHaveLength(1);
    expect(entityCounts().ship).toBe(0);
    expect(layer.shipProbes()).toEqual([]);
  });

  it('excludes self SHIPS by callsign (the frozen docked self ship never renders)', () => {
    const layer = new RemoteEntityLayer();
    layer.addSnapshot(
      100,
      [
        { ...entity('ship-me', 'ship', V3), callsign: 'me' },
        ship('s-bob', 'bob', { x: 1, y: 0, z: 0 }),
      ],
      'me',
    );
    layer.renderFrame(110);
    expect(layer.renderedIds()).toEqual(['s-bob']);
    expect(layer.shipProbes().map((p) => p.callsign)).toEqual(['bob']);
  });

  it('gives AI ships the hostile trim accent and keeps player ships on the class default', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(
      100,
      [
        ship('s-bob', 'bob', V3, { classId: 'scout' }),
        ship('ai-1', 'ROGUE-1', V3, { classId: 'scout', kind: 'ai-ship' }),
      ],
      'me',
    );
    layer.renderFrame(110);
    const aiRed = AI_SHIP_TRIM_COLOR.slice(1);
    // The ai-ship carries exactly ONE material in the hostile trim color…
    const aiMats = shipMats(parent.children[1] as THREE.Group);
    expect(aiMats.filter((m) => m.color.getHexString() === aiRed)).toHaveLength(1);
    // …and the player ship has none of them (class-default trim instead).
    const playerMats = shipMats(parent.children[0] as THREE.Group);
    expect(playerMats.filter((m) => m.color.getHexString() === aiRed)).toHaveLength(0);
    // Zone materials are transparent — the stale/dimmed opacity rule works.
    expect(aiMats.every((m) => m.transparent)).toBe(true);
  });

  it('applies the stale/dimmed opacity rule to ship materials (dimmed when the buffer starves)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [ship('s-bob', 'bob', V3)], 'me');
    // 4.9 s since the last sample → newest sample is older than STALE_MS → dimmed.
    layer.renderFrame(5_000);
    expect(shipMats(parent.children[0] as THREE.Group).every((m) => m.opacity === 0.25)).toBe(true);
  });

  it('labels ships by callsign (AI ships by their AI name) through the same overlay + cap', () => {
    const layer = new RemoteEntityLayer();
    layer.setProjector(() => ({ x: 0, y: 0, dist: 3 }));
    layer.addSnapshot(
      100,
      [
        ship('s-bob', 'bob', V3),
        ship('ai-1', 'ROGUE-1', V3, { kind: 'ai-ship' }),
        ...Array.from({ length: MAX_CALLSIGN_LABELS }, (_, i) =>
          character(`char-${i}`, `ped${i}`, { x: i, y: 0, z: 0 }),
        ),
      ],
      'me',
    );
    layer.renderFrame(110);
    const states = layer.labelStates(110);
    // 2 ships + 16 characters = 18 candidates; the cap keeps 16.
    expect(states).toHaveLength(18);
    expect(new Set(states.map((s) => s.callsign)).size).toBe(18);
    expect(states.filter((s) => s.visible)).toHaveLength(MAX_CALLSIGN_LABELS);
    const byId = new Map(states.map((s) => [s.id, s]));
    expect(byId.get('s-bob')?.callsign).toBe('bob');
    expect(byId.get('ai-1')?.callsign).toBe('ROGUE-1');
  });

  it('never double-labels an on-foot player: the character beats the docked ship', () => {
    const layer = new RemoteEntityLayer();
    layer.setProjector(() => ({ x: 0, y: 0, dist: 3 }));
    layer.addSnapshot(
      100,
      [
        character('char-bob', 'bob', V3),
        // Bob's DOCKED scout, still carrying his callsign on the wire.
        ship('s-bob', 'bob', V3),
        ship('s-carol', 'carol', { x: 5, y: 0, z: 0 }),
      ],
      'me',
    );
    layer.renderFrame(110);
    const states = layer.labelStates(110);
    // bob appears exactly ONCE — via the CHARACTER (the active entity);
    // carol's label rides her ship.
    expect(states.filter((s) => s.callsign === 'bob')).toHaveLength(1);
    expect(states.find((s) => s.callsign === 'bob')?.id).toBe('char-bob');
    expect(states.find((s) => s.callsign === 'carol')?.id).toBe('s-carol');
    // Both ships still render even though only one is labeled.
    expect(layer.renderedIds().sort()).toEqual(['s-bob', 's-carol', 'char-bob'].sort());
  });

  it('clear() disposes remote ships too (world swap)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(
      100,
      [ship('s-bob', 'bob', V3), ship('ai-1', 'ROGUE-1', V3, { kind: 'ai-ship' })],
      'me',
    );
    layer.renderFrame(110);
    layer.clear();
    expect(layer.shipProbes()).toEqual([]);
    expect(parent.children).toHaveLength(0);
    expect(entityCounts().ship).toBe(0);
  });
});

/**
 * TASK-48.3: hostile surface drones (kind 'drone') — a small rotating
 * octahedron at the interpolated (server-patrolled) position, hidden while
 * the wire hull is 0 (killed, awaiting the server-side 180 s respawn), no
 * callsign label (they are not a presence entry), and the same stale/dimmed
 * opacity rule as the other remote meshes.
 */
describe('RemoteEntityLayer — drones (TASK-48.3)', () => {
  beforeEach(() => {
    resetEntityRegistry();
  });

  function drone(
    id: string,
    pos: { x: number; y: number; z: number },
    extra: Partial<EntityState> = {},
  ): EntityState {
    return { ...entity(id, 'drone', pos), classId: 'drone', ...extra };
  }

  it('renders a drone as a small octahedron at the 200 ms interpolated position (no label)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [drone('drone:1', { x: 0, y: 5, z: 0 })], 'me');
    layer.addSnapshot(300, [drone('drone:1', { x: 2, y: 5, z: 0 })], 'me');
    // now=490 → target 290 → f=(290-100)/200=0.95 → x = 2*0.95 = 1.9
    layer.renderFrame(490);
    const group = meshOf(parent)!;
    expect(layer.renderedIds()).toEqual(['drone:1']);
    expect(group.position.x).toBeCloseTo(1.9, 5);
    expect(group.position.y).toBe(5);
    // One octahedron body + one additive halo.
    const body = group.children[0] as THREE.Mesh;
    expect(body.geometry).toBeInstanceOf(THREE.OctahedronGeometry);
    expect((body.material as THREE.MeshBasicMaterial).color.getHexString()).toBe(
      AI_SHIP_TRIM_COLOR.slice(1),
    );
    // Drones carry no callsign label (they are not a presence entry).
    expect(layer.labelStates(490)).toEqual([]);
    expect(entityCounts().drone).toBe(1);
    expect(entityCounts().total).toBe(1);
  });

  it('spins per frame (the octahedron rotates; the server owns the position)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [drone('drone:1', { x: 0, y: 5, z: 0 })], 'me');
    layer.renderFrame(110);
    const group = meshOf(parent)!;
    const first = group.rotation.y;
    layer.renderFrame(1610); // 5 s later
    expect(group.rotation.y).not.toBe(first);
    // …but the position stayed at the (single) sampled position.
    expect(group.position.x).toBe(0);
  });

  it('hides a killed drone (hull 0 on the wire) until its respawn streams again', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [drone('drone:1', { x: 0, y: 5, z: 0 }, { hull: 0 })], 'me');
    layer.renderFrame(110);
    expect(meshOf(parent)!.visible).toBe(false); // killed: hidden
    layer.addSnapshot(200, [drone('drone:1', { x: 0, y: 5, z: 0 }, { hull: 1 })], 'me');
    layer.renderFrame(210);
    expect(meshOf(parent)!.visible).toBe(true); // respawned: visible again
    expect(layer.droneProbes()[0]).toMatchObject({ id: 'drone:1', visible: true });
  });

  it('removes the drone when it leaves the snapshot (mesh + registry + probe)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [drone('drone:1', V3)], 'me');
    layer.renderFrame(110);
    expect(parent.children).toHaveLength(1);
    expect(entityCounts().drone).toBe(1);

    layer.addSnapshot(200, [character('char-bob', 'bob', V3)], 'me');
    layer.renderFrame(210);
    expect(layer.renderedIds()).toEqual(['char-bob']);
    expect(parent.children).toHaveLength(1);
    expect(entityCounts().drone).toBe(0);
    expect(layer.droneProbes()).toEqual([]);
  });

  it('applies the stale/dimmed opacity rule to the drone (dimmed when the buffer starves)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [drone('drone:1', V3)], 'me');
    // 4.9 s since the last sample → dimmed.
    layer.renderFrame(5_000);
    const group = meshOf(parent)!;
    const body = (group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const glow = (group.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(body.opacity).toBe(0.25);
    expect(glow.opacity).toBeCloseTo(0.3 * 0.25, 5);
  });
});

/**
 * TASK-49: wreck impostors (kind 'wreck') — the frozen ship silhouette +
 * a fire-glow flicker, with the killer's callsign as a small '▸ <killer>'
 * marker label visible within WRECK_KILLER_MARK_M (200 m). Wrecks carry
 * NO callsign on the wire — the killerId does.
 */
describe('RemoteEntityLayer — wrecks (TASK-49)', () => {
  beforeEach(() => {
    resetEntityRegistry();
    __resetKillFeed();
  });

  function wreck(
    id: string,
    pos: { x: number; y: number; z: number },
    extra: Partial<EntityState> = {},
  ): EntityState {
    return {
      ...entity(id, 'wreck', pos),
      classId: 'freighter',
      livery: { hull: '#123456' },
      ...extra,
    };
  }

  it('renders a wreck as a frozen ship mesh + fire glow at the interpolated position', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(
      100,
      [wreck('wreck:ship-b', { x: 0, y: 10, z: 0 }, { killerId: 'pl-a' })],
      'me',
    );
    layer.addSnapshot(
      300,
      [wreck('wreck:ship-b', { x: 2, y: 10, z: 0 }, { killerId: 'pl-a' })],
      'me',
    );
    // now=490 → target 290 → f=(290-100)/200=0.95 → x = 2*0.95 = 1.9
    layer.renderFrame(490);
    const outer = meshOf(parent)!;
    expect(layer.renderedIds()).toEqual(['wreck:ship-b']);
    expect(outer.position.x).toBeCloseTo(1.9, 5);
    expect(outer.position.y).toBe(10);
    // One frozen ship group + one additive fire-glow sphere.
    expect(outer.children).toHaveLength(2);
    expect(outer.children[1]).toBeInstanceOf(THREE.Mesh);
    const fire = (outer.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(fire.blending).toBe(THREE.AdditiveBlending);
    expect(entityCounts().wreck).toBe(1);
    expect(entityCounts().total).toBe(1);
  });

  it('the fire glow flickers per frame (opacity oscillates, position frozen)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [wreck('wreck:1', { x: 5, y: 10, z: 0 })], 'me');
    layer.renderFrame(110);
    const outer = meshOf(parent)!;
    const fire = (outer.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const first = fire.opacity;
    layer.renderFrame(110 + Math.PI / 0.01 / 2); // a quarter flicker period later
    // sin has moved: the opacity changed, within the 0.25 ± 0.15 band.
    expect(fire.opacity).not.toBe(first);
    expect(fire.opacity).toBeGreaterThanOrEqual(0.1);
    expect(fire.opacity).toBeLessThanOrEqual(0.4);
    // The wreck itself is static (single sampled position, no drift).
    expect(outer.position.x).toBe(5);
  });

  it('labels a wreck with the killer marker (callsign resolved, ▸ prefix)', () => {
    const layer = new RemoteEntityLayer();
    layer.setProjector(() => ({ x: 0, y: 0, dist: 60 }));
    indexKillFeedPlayers([{ playerId: 'pl-a', callsign: 'Alpha' }]);
    layer.addSnapshot(100, [wreck('wreck:1', V3, { killerId: 'pl-a' })], 'me');
    layer.renderFrame(110);
    const [state] = layer.labelStates(110);
    expect(state).toMatchObject({
      id: 'wreck:1',
      callsign: 'Alpha',
      text: wreckLabelText('Alpha'),
      opacity: 1,
      visible: true,
    });
  });

  it('falls back to the raw killer id (AI / drones are not in the roster)', () => {
    const layer = new RemoteEntityLayer();
    layer.setProjector(() => ({ x: 0, y: 0, dist: 10 }));
    layer.addSnapshot(
      100,
      [
        wreck('wreck:1', V3, { killerId: 'ai-ship-7' }),
        wreck('wreck:2', { x: 1, y: 0, z: 0 }), // no killerId
      ],
      'me',
    );
    layer.renderFrame(110);
    const byId = new Map(layer.labelStates(111).map((s) => [s.id, s]));
    expect(byId.get('wreck:1')?.text).toBe(wreckLabelText('ai-ship-7'));
    expect(byId.get('wreck:2')?.text).toBe(wreckLabelText('wreck'));
  });

  it('shows the marker within 200 m and hides it beyond (hard off)', () => {
    const layer = new RemoteEntityLayer();
    const setDist = (d: number): void => layer.setProjector(() => ({ x: 0, y: 0, dist: d }));
    layer.addSnapshot(100, [wreck('wreck:1', V3, { killerId: 'pl-a' })], 'me');
    setDist(WRECK_KILLER_MARK_M);
    layer.renderFrame(110);
    expect(layer.labelStates(110)[0]).toMatchObject({ visible: true, opacity: 1 });
    setDist(WRECK_KILLER_MARK_M + 1);
    layer.renderFrame(120);
    expect(layer.labelStates(120)[0]).toMatchObject({ visible: false, opacity: 0 });
  });

  it('wreck labels survive the character-preference dedup (the killer may be on foot)', () => {
    const layer = new RemoteEntityLayer();
    layer.setProjector(() => ({ x: 0, y: 0, dist: 5 }));
    // Alpha killed the wreck, and Alpha is ALSO on foot nearby (his
    // character carries his callsign) — the wreck marker must not be
    // suppressed by the character-preference rule (that dedups a player's
    // OWN ship label, not someone else's killer marker).
    layer.addSnapshot(
      100,
      [
        wreck('wreck:1', V3, { killerId: 'pl-a' }),
        character('char-a', 'Alpha', { x: 1, y: 0, z: 0 }),
      ],
      'me',
    );
    layer.renderFrame(110);
    const states = layer.labelStates(110);
    expect(states.map((s) => s.id).sort()).toEqual(['char-a', 'wreck:1']);
  });

  it('removes a wreck when it leaves the snapshot (mesh + glow + registry + label)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [wreck('wreck:1', V3, { killerId: 'pl-a' })], 'me');
    layer.renderFrame(110);
    expect(parent.children).toHaveLength(1);
    expect(entityCounts().wreck).toBe(1);

    // The 600 s ttl expiry: the next batch no longer carries the wreck.
    layer.addSnapshot(200, [character('char-bob', 'bob', V3)], 'me');
    layer.renderFrame(210);
    expect(layer.renderedIds()).toEqual(['char-bob']);
    expect(parent.children).toHaveLength(1);
    expect(entityCounts().wreck).toBe(0);
    expect(layer.wreckProbes()).toEqual([]);
  });

  it('applies the stale/dimmed opacity rule to the wreck (dimmed when the buffer starves)', () => {
    const layer = new RemoteEntityLayer();
    const parent = new THREE.Group();
    layer.setParent(parent);
    layer.addSnapshot(100, [wreck('wreck:1', V3)], 'me');
    // 4.9 s since the last sample → dimmed (ship mesh + fire glow scale).
    layer.renderFrame(5_000);
    const outer = meshOf(parent)!;
    const fire = (outer.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(fire.opacity).toBeLessThan(0.15);
    const shipMats: THREE.Material[] = [];
    outer.children[0].traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material;
        if (Array.isArray(m)) shipMats.push(...m);
        else shipMats.push(m);
      }
    });
    expect(shipMats.every((m) => m.opacity === 0.25)).toBe(true);
  });
});
