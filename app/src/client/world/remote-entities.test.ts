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
} from './remote-entities';

/**
 * TASK-36 step 4: RemoteEntityLayer unit tests — label fade math, ground-item
 * colors, callsign-based self exclusion, the 200 ms interpolated placement,
 * livery tint, removal, and the label cap / behind-camera handling.
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
