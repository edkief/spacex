import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { SHIP_CLASSES, type Livery } from '@shared/ships';
import { applyLivery, buildShipMesh, disposeShipMesh } from './ship-mesh';

const IDS = Object.keys(SHIP_CLASSES) as (keyof typeof SHIP_CLASSES)[];

describe('buildShipMesh (TASK-21)', () => {
  it('builds a group with meshes in three paint zones for every class', () => {
    for (const id of IDS) {
      const ship = buildShipMesh(id);
      expect(ship.classId).toBe(id);
      expect(ship.group.children.length).toBeGreaterThan(0);

      const meshes = ship.group.children.filter((c) => c instanceof THREE.Mesh);
      expect(meshes.length).toBe(7);

      // Exactly one material per zone, shared across that zone's meshes.
      const mats = new Set<THREE.Material>();
      for (const m of meshes) mats.add(m.material);
      expect(mats.size).toBe(3);
      for (const key of ['hull', 'accent', 'trim'] as const) {
        expect(ship.zones[key]).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(mats.has(ship.zones[key])).toBe(true);
      }
      // The three zones are distinct materials.
      expect(ship.zones.hull).not.toBe(ship.zones.accent);
      expect(ship.zones.accent).not.toBe(ship.zones.trim);
      disposeShipMesh(ship);
    }
  });

  it('starts at the catalog default livery', () => {
    for (const id of IDS) {
      const ship = buildShipMesh(id);
      const def = SHIP_CLASSES[id].defaultLivery;
      expect(ship.zones.hull.color.getHexString()).toBe(def.hull.slice(1));
      expect(ship.zones.accent.color.getHexString()).toBe(def.accent.slice(1));
      expect(ship.zones.trim.color.getHexString()).toBe(def.trim.slice(1));
      disposeShipMesh(ship);
    }
  });

  it('falls back to the scout silhouette for unknown class ids', () => {
    const ship = buildShipMesh('dreadnought');
    expect(ship.classId).toBe('scout');
    disposeShipMesh(ship);
  });
});

describe('applyLivery (TASK-21)', () => {
  it('sets all three zones from a full livery', () => {
    const ship = buildShipMesh('scout');
    const livery: Livery = { hull: '#ff0000', accent: '#00ff00', trim: '#0000ff' };
    applyLivery(ship, livery);
    expect(ship.zones.hull.color.getHexString()).toBe('ff0000');
    expect(ship.zones.accent.color.getHexString()).toBe('00ff00');
    expect(ship.zones.trim.color.getHexString()).toBe('0000ff');
    disposeShipMesh(ship);
  });

  it('falls back per slot for missing or invalid values (legacy empty livery rows)', () => {
    const ship = buildShipMesh('interceptor');
    const def = SHIP_CLASSES.interceptor.defaultLivery;

    // Legacy persisted rows can hold {} — every slot must resolve to the default.
    applyLivery(ship, {});
    expect(ship.zones.hull.color.getHexString()).toBe(def.hull.slice(1));
    expect(ship.zones.accent.color.getHexString()).toBe(def.accent.slice(1));
    expect(ship.zones.trim.color.getHexString()).toBe(def.trim.slice(1));

    // Partial + invalid mix: valid slot wins, the rest fall back.
    applyLivery(ship, { hull: '#a1b2c3', accent: 'red', trim: '#zzzzzz' });
    expect(ship.zones.hull.color.getHexString()).toBe('a1b2c3');
    expect(ship.zones.accent.color.getHexString()).toBe(def.accent.slice(1));
    expect(ship.zones.trim.color.getHexString()).toBe(def.trim.slice(1));

    // null/undefined is a full default reset.
    applyLivery(ship, null);
    expect(ship.zones.hull.color.getHexString()).toBe(def.hull.slice(1));
    disposeShipMesh(ship);
  });

  it('swaps colors in place without rebuilding meshes or materials', () => {
    const ship = buildShipMesh('freighter');
    const before = ship.group.children.length;
    const hullMat = ship.zones.hull;
    const accentMat = ship.zones.accent;
    const trimMat = ship.zones.trim;
    const hullGeo = (ship.group.children[0] as THREE.Mesh).geometry;

    for (let i = 0; i < 5; i++) {
      applyLivery(ship, {
        hull: `#${String(1000000 + i)
          .slice(1)
          .padStart(6, '0')}`,
        accent: '#123abc',
        trim: '#0f0f0f',
      });
    }

    // Same object graph, same materials, same geometry: pure color sets.
    expect(ship.group.children.length).toBe(before);
    expect(ship.zones.hull).toBe(hullMat);
    expect(ship.zones.accent).toBe(accentMat);
    expect(ship.zones.trim).toBe(trimMat);
    expect((ship.group.children[0] as THREE.Mesh).geometry).toBe(hullGeo);
    disposeShipMesh(ship);
  });

  it('dispose frees every geometry and material exactly', () => {
    const ship = buildShipMesh('scout');
    const hullMat = ship.zones.hull;
    disposeShipMesh(ship);
    expect(ship.group.children.length).toBe(0);
    // Disposing twice must be a safe no-op (shared geometries).
    expect(() => disposeShipMesh(ship)).not.toThrow();
    expect(ship.zones.hull).toBe(hullMat);
  });
});
