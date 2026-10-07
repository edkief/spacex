import * as THREE from 'three';

import { describe, expect, it } from 'vitest';
import type { Livery } from '@shared/protocol/schemas';
import type { Vec3 } from '@shared/physics/vec';

import { SelfShip, type SelfShipInput } from './self-ship';

/**
 * TASK-72 (unit): the self-ship lifecycle — the mesh is created ONCE, a
 * livery change re-tints in place (no geometry/material churn), a classId
 * change rebuilds, null disposes, and the group is scene-level (a
 * swapWorld-style world-group swap never touches it).
 */

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const DOCKED: SelfShipInput = {
  classId: 'scout',
  pos: { x: 12, y: 0, z: -40 },
  rot: { x: 0, y: 0, z: 0, w: 1 },
  livery: null,
};
const LIVERY: Livery = { hull: '#ff0000', accent: '#00ff00', trim: '#0000ff' };

describe('SelfShip lifecycle (TASK-72)', () => {
  it('first set creates the group once, at the given pose', () => {
    const ship = new SelfShip();
    expect(ship.active).toBe(false);
    const r1 = ship.set(DOCKED);
    expect(r1).toEqual({ created: true, rebuilt: false, retinted: false, disposed: false });
    expect(ship.active).toBe(true);
    expect(ship.builds).toBe(1);
    expect(ship.mesh!.classId).toBe('scout');
    expect(ship.position()).toEqual({ x: 12, y: 0, z: -40 });
    expect(ship.mesh!.group.quaternion.w).toBeCloseTo(1, 10);
    const group1 = ship.mesh!.group;

    // A second update (new pose, same hull): no create, no rebuild, no retint.
    const r2 = ship.set({ ...DOCKED, pos: { x: 13, y: 1, z: -40 } });
    expect(r2).toEqual({ created: false, rebuilt: false, retinted: false, disposed: false });
    expect(ship.builds).toBe(1);
    // The group identity is stable (one mesh, created once).
    expect(ship.mesh!.group).toBe(group1);
    expect(ship.position()).toEqual({ x: 13, y: 1, z: -40 });
  });

  it('a livery change re-tints in place — same group, same geometries', () => {
    const ship = new SelfShip();
    ship.set(DOCKED);
    const groupBefore = ship.mesh!.group;
    const geoBefore = ship.mesh!.group.children[0] as THREE.Mesh;
    const geo0 = geoBefore.geometry;
    const matBefore = {
      hull: ship.mesh!.zones.hull,
      accent: ship.mesh!.zones.accent,
      trim: ship.mesh!.zones.trim,
    };

    const r = ship.set({ ...DOCKED, livery: LIVERY });
    expect(r).toEqual({ created: false, rebuilt: false, retinted: true, disposed: false });
    expect(ship.builds).toBe(1);
    // In-place: the group and materials are the SAME objects, recolored.
    expect(ship.mesh!.group).toBe(groupBefore);
    expect((ship.mesh!.group.children[0] as THREE.Mesh).geometry).toBe(geo0);
    expect(ship.mesh!.zones.hull).toBe(matBefore.hull);
    expect(ship.mesh!.zones.hull.color.getHexString()).toBe('ff0000');
    expect(ship.mesh!.zones.accent.color.getHexString()).toBe('00ff00');
    expect(ship.mesh!.zones.trim.color.getHexString()).toBe('0000ff');

    // A repeat of the SAME livery: the dedup guard skips the re-tint.
    const r2 = ship.set({ ...DOCKED, livery: { ...LIVERY } });
    expect(r2.retinted).toBe(false);

    // null livery: back to the class default (a real change).
    const r3 = ship.set({ ...DOCKED, livery: null });
    expect(r3.retinted).toBe(true);
    expect(ship.mesh!.zones.hull.color.getHexString()).not.toBe('ff0000');
  });

  it('a non-default livery arriving WITH the first update is applied', () => {
    const ship = new SelfShip();
    ship.set({ ...DOCKED, livery: LIVERY });
    expect(ship.mesh!.zones.hull.color.getHexString()).toBe('ff0000');
    expect(ship.mesh!.zones.accent.color.getHexString()).toBe('00ff00');
  });

  it('a classId change (ship purchase) rebuilds: old group disposed, new group kept', () => {
    const ship = new SelfShip();
    ship.set(DOCKED);
    const groupBefore = ship.mesh!.group;

    const r = ship.set({ ...DOCKED, classId: 'interceptor' });
    expect(r).toEqual({ created: false, rebuilt: true, retinted: false, disposed: false });
    expect(ship.builds).toBe(2);
    expect(ship.mesh!.classId).toBe('interceptor');
    expect(ship.mesh!.group).not.toBe(groupBefore);
    // The old group was cleared (disposeShipMesh empties it).
    expect(groupBefore.children.length).toBe(0);

    // The pose carried over to the rebuilt group.
    expect(ship.position()).toEqual({ x: 12, y: 0, z: -40 });
  });

  it('null disposes: no mesh, geometries freed, the scene detaches cleanly', () => {
    const scene = new THREE.Scene();
    const ship = new SelfShip();
    ship.set(DOCKED);
    scene.add(ship.mesh!.group);
    const mesh = ship.mesh!;

    const r = ship.set(null);
    expect(r).toEqual({ created: false, rebuilt: false, retinted: false, disposed: true });
    expect(ship.active).toBe(false);
    expect(ship.position()).toBeNull();
    // The freed group is emptied by disposeShipMesh (materials disposed,
    // children cleared) — nothing is left for the scene to render.
    expect(mesh.group.children.length).toBe(0);

    // A second null is a no-op (idempotent).
    expect(ship.set(null)).toEqual({
      created: false,
      rebuilt: false,
      retinted: false,
      disposed: false,
    });
  });

  it('survives a swapWorld-style swap: the group is scene-level, not world-group-level', () => {
    const scene = new THREE.Scene();
    const worldGroupA = new THREE.Group();
    const worldGroupB = new THREE.Group();
    scene.add(worldGroupA);

    const ship = new SelfShip();
    ship.set(DOCKED);
    scene.add(ship.mesh!.group); // WorldManager parents it to the SCENE
    const group = ship.mesh!.group;
    expect(group.parent).toBe(scene);

    // The warp: the old world group is removed + disposed…
    scene.remove(worldGroupA);
    scene.add(worldGroupB);
    // …and the ship keeps its updates (the next 10 Hz self entity_update).
    const r = ship.set({ ...DOCKED, pos: { x: 200, y: 3, z: 8 } });
    expect(r.created).toBe(false);
    expect(r.rebuilt).toBe(false);
    expect(ship.mesh!.group).toBe(group);
    expect(group.parent).toBe(scene);
    expect(ship.position()).toEqual({ x: 200, y: 3, z: 8 });
  });

  it('TASK-77: { place: false } skips the pose write — create/rebuild/retint still happen', () => {
    const ship = new SelfShip();

    // First spawn with placement disabled: the mesh is created but left at
    // the origin (WorldManager places a created/rebuilt mesh once itself).
    const r1 = ship.set(DOCKED, { place: false });
    expect(r1.created).toBe(true);
    expect(ship.active).toBe(true);
    expect(ship.position()).toEqual({ x: 0, y: 0, z: 0 });

    // A default update places, then a place:false update leaves the pose
    // alone while still re-tinting.
    ship.set(DOCKED);
    expect(ship.position()).toEqual({ x: 12, y: 0, z: -40 });
    const r2 = ship.set({ ...DOCKED, pos: { x: 50, y: 7, z: 9 }, livery: LIVERY }, { place: false });
    expect(r2).toEqual({ created: false, rebuilt: false, retinted: true, disposed: false });
    expect(ship.mesh!.zones.hull.color.getHexString()).toBe('ff0000');
    expect(ship.position()).toEqual({ x: 12, y: 0, z: -40 }); // pose untouched

    // A rebuild (classId change) with place:false still builds the new group
    // (back at the origin — the manager places it once on this path).
    const r3 = ship.set(
      { ...DOCKED, classId: 'interceptor', pos: { x: 99, y: 1, z: 2 } },
      { place: false },
    );
    expect(r3.rebuilt).toBe(true);
    expect(ship.builds).toBe(2);
    expect(ship.position()).toEqual({ x: 0, y: 0, z: 0 });

    // The null dispose path is unaffected by the option.
    expect(ship.set(null, { place: false }).disposed).toBe(true);
  });

  it('transform drives pose only (the per-frame drive TASK-73 will use)', () => {
    const ship = new SelfShip();
    ship.set(DOCKED);
    ship.transform(ORIGIN, { x: 0, y: 0, z: 0, w: 1 });
    expect(ship.position()).toEqual(ORIGIN);
    // No-op before the first spawn: never throws.
    const fresh = new SelfShip();
    fresh.transform(ORIGIN, { x: 0, y: 0, z: 0, w: 1 });
    expect(fresh.active).toBe(false);
  });
});
