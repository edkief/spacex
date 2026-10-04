import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { hazardsFor, HAZARD_RENDER_RANGE_M, type HazardKind } from '@shared/world/hazards';
import type { SystemGen } from '@shared/galaxy/types';
import {
  buildHazardDiscs,
  HAZARD_DISC_SURFACE_OFFSET_M,
  hazardDiscsFor,
  hazardDiscVisible,
  STORM_QUAD_COUNT,
} from './hazard-discs';
import type { Vec3 } from '@shared/physics/vec';

/**
 * TASK-48.3: the 3D hazard markers. The pure half — placement derived from
 * the SHARED hazardsFor (identical to the server's list, drone cells
 * excluded), the 500 m culling predicate, and the build shape (storm = 8
 * quad spin group, rad zone = one flat disc, everything built once and
 * initially hidden). The WorldManager wiring (swapWorld + frame loop) needs
 * a GL context and is covered by the type-check + the TASK-48.4 e2e.
 */

const SEED = 'hazard-discs-test-seed';

interface Scanned {
  system: SystemGen;
  hazards: ReturnType<typeof hazardsFor>;
}

/**
 * Deterministically scan seeded systems and return the FIRST one per hazard
 * kind that actually carries a cell of that kind (hazardsFor is a pure
 * function of the seed, so the results are stable run-to-run).
 */
function systemsWithKinds(): { all: Scanned[]; storm: Scanned; radzone: Scanned; drones: Scanned } {
  const stars = generateStars(SEED, 24);
  const all: Scanned[] = [];
  for (const star of stars) {
    const system = generateSystem(SEED, star.id);
    const hazards = hazardsFor(SEED, system);
    if (hazards.length > 0) all.push({ system, hazards });
  }
  const pick = (kind: HazardKind): Scanned => {
    const found = all.find((s) => s.hazards.some((h) => h.kind === kind));
    expect(found, `expected a seeded system with a ${kind} cell`).toBeDefined();
    return found!;
  };
  return { all, storm: pick('storm'), radzone: pick('radzone'), drones: pick('drones') };
}

describe('hazardDiscsFor (TASK-48.3)', () => {
  it('derives EXACTLY hazardsFor minus the drone cells (server-identical positions)', () => {
    const { storm, radzone } = systemsWithKinds();
    for (const { system, hazards } of [storm, radzone]) {
      const discs = hazardDiscsFor(SEED, system);
      const expected = hazards.filter((h) => h.kind !== 'drones');
      expect(discs).toHaveLength(expected.length);
      discs.forEach((d, i) => {
        expect(d.hazardId).toBe(expected[i].hazardId);
        expect(d.kind).toBe(expected[i].kind);
        expect(d.x).toBe(expected[i].pos.x);
        expect(d.y).toBe(expected[i].pos.y);
        expect(d.z).toBe(expected[i].pos.z);
        expect(d.radius).toBe(expected[i].radius);
        expect(d.intensity).toBe(expected[i].intensity);
      });
    }
  });

  it('never turns a drone cell into a ground disc (the drones are the marker)', () => {
    const { drones } = systemsWithKinds();
    const discs = hazardDiscsFor(SEED, drones.system);
    const expected = drones.hazards.filter((h) => h.kind !== 'drones');
    // (string-cast: the type already excludes 'drones'; this pins the runtime.)
    expect((discs as Array<{ kind: string }>).every((d) => d.kind !== 'drones')).toBe(true);
    expect(discs).toHaveLength(expected.length);
    // The system carries at least one drone cell that was dropped.
    expect(drones.hazards.some((h) => h.kind === 'drones')).toBe(true);
  });

  it('is deterministic: the same (seed, system) always yields the same discs', () => {
    const { storm } = systemsWithKinds();
    expect(hazardDiscsFor(SEED, storm.system)).toEqual(hazardDiscsFor(SEED, storm.system));
  });
});

describe('hazardDiscVisible (TASK-48.3)', () => {
  it('is a pure 500 m range check (3-D, inclusive) — same rule as pad rings', () => {
    const center: Vec3 = { x: 120, y: 5, z: -240 };
    expect(HAZARD_RENDER_RANGE_M).toBe(500);
    expect(hazardDiscVisible(null, center)).toBe(false); // no position yet
    expect(hazardDiscVisible({ ...center }, center)).toBe(true);
    expect(
      hazardDiscVisible({ x: center.x + HAZARD_RENDER_RANGE_M, y: center.y, z: center.z }, center),
    ).toBe(true); // exactly 500 m: visible
    expect(
      hazardDiscVisible(
        { x: center.x + HAZARD_RENDER_RANGE_M + 1, y: center.y, z: center.z },
        center,
      ),
    ).toBe(false); // 501 m: hidden
    // Vertical distance counts too.
    expect(hazardDiscVisible({ x: center.x + 300, y: center.y - 400, z: center.z }, center)).toBe(
      true,
    );
    expect(hazardDiscVisible({ x: center.x + 300, y: center.y - 401, z: center.z }, center)).toBe(
      false,
    );
  });
});

/** The direct mesh children of a group (skips sub-groups). */
function meshesOf(group: THREE.Group): THREE.Mesh[] {
  return group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
}

describe('buildHazardDiscs (TASK-48.3)', () => {
  it('builds one group per non-drone cell, initially hidden, at cell pos + surface offset', () => {
    const { storm } = systemsWithKinds();
    const discs = buildHazardDiscs(SEED, storm.system);
    const expected = storm.hazards.filter((h) => h.kind !== 'drones');
    expect(discs).toHaveLength(expected.length);
    discs.forEach((d, i) => {
      expect(d.group.visible).toBe(false); // the frame loop reveals it
      expect(d.group.position.x).toBe(expected[i].pos.x);
      expect(d.group.position.y).toBe(expected[i].pos.y + HAZARD_DISC_SURFACE_OFFSET_M);
      expect(d.group.position.z).toBe(expected[i].pos.z);
      expect(d.center).toEqual(d.group.position);
      expect(d.placement.hazardId).toBe(expected[i].hazardId);
    });
  });

  it('a storm cell is 8 flat quads in ONE spin group sharing one geometry + material', () => {
    const { storm } = systemsWithKinds();
    const discs = buildHazardDiscs(SEED, storm.system);
    const disc = discs.find((d) => d.placement.kind === 'storm')!;
    expect(disc.spin).not.toBeNull();
    expect(disc.spinSpeed).toBeGreaterThan(0);
    const spin = disc.spin!;
    expect(spin.children).toHaveLength(STORM_QUAD_COUNT); // 8 radial holders
    const quads = spin.children.flatMap((h) => meshesOf(h as THREE.Group));
    expect(quads).toHaveLength(STORM_QUAD_COUNT);
    const geometries = new Set(quads.map((q) => q.geometry));
    const materials = new Set(quads.map((q) => q.material));
    expect(geometries.size).toBe(1); // shared geometry — built once
    expect(materials.size).toBe(1); // shared material — no per-quad churn
    const mat = [...materials][0] as THREE.MeshBasicMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.depthWrite).toBe(false);
    // Every quad is flat on the ground plane.
    expect(quads.every((q) => Math.abs(q.rotation.x + Math.PI / 2) < 1e-6)).toBe(true);
  });

  it('a rad zone is a SINGLE flat green additive ground disc (no spin group)', () => {
    const { radzone } = systemsWithKinds();
    const discs = buildHazardDiscs(SEED, radzone.system);
    const disc = discs.find((d) => d.placement.kind === 'radzone')!;
    expect(disc.spin).toBeNull();
    expect(disc.spinSpeed).toBe(0);
    const meshes = meshesOf(disc.group);
    expect(meshes).toHaveLength(1);
    const mesh = meshes[0];
    expect(mesh.geometry).toBeInstanceOf(THREE.CircleGeometry);
    // The disc radius IS the hazard cell radius.
    const cellRadius = radzone.hazards.find((h) => h.hazardId === disc.placement.hazardId)!.radius;
    expect((mesh.geometry as THREE.CircleGeometry).parameters.radius).toBe(cellRadius);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.color.getHexString()).toBe('4ade80'); // green glow
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.transparent).toBe(true);
    expect(Math.abs(mesh.rotation.x + Math.PI / 2)).toBeLessThan(1e-6); // flat on ground
  });
});
