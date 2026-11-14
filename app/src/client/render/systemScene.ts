import * as THREE from 'three';
import type { PlanetClass, StarClass, SystemGen } from '@shared/galaxy/types.ts';
import { bodiesOf, type Body, type BodyDock } from '@shared/physics/bodies.ts';
import { dockOrientation } from '@shared/physics/docking.ts';
import type { Vec3 } from '@shared/physics/vec.ts';
import { Rng, seedFromString } from '@shared/random.ts';
import { relativeTo } from './relative.ts';

const STAR_COLORS: Readonly<Record<StarClass, number>> = {
  O: 0x9bb0ff,
  B: 0xaabfff,
  A: 0xcad7ff,
  F: 0xf8f7ff,
  G: 0xfff4ea,
  K: 0xffd2a1,
  M: 0xffb56c,
};

const PLANET_COLORS: Readonly<Record<PlanetClass, number>> = {
  terran: 0x4f8f5b,
  rocky: 0x8a6f5a,
  ocean: 0x2f6fb5,
  ice: 0xcfe6f5,
  gas: 0xc79a5b,
};

const STARFIELD_COUNT = 2500;
const STARFIELD_RADIUS = 5e10;
/** Dock model, in berth-local axes (ship nose along -z): a pad under the ship and a gate ahead. */
const DOCK_PAD_RADIUS_M = 24;
const DOCK_GATE_RADIUS_M = 30;
const DOCK_GATE_AHEAD_M = 70;

interface Placed {
  object: THREE.Object3D;
  world: Vec3;
}

/** A backdrop of seeded points on a huge sphere around the camera (never translated). */
function createStarfield(seed: string): THREE.Points {
  const rng = new Rng(seedFromString(`${seed}:starfield`));
  const positions = new Float32Array(STARFIELD_COUNT * 3);
  for (let i = 0; i < STARFIELD_COUNT; i++) {
    let x: number;
    let y: number;
    let z: number;
    let d: number;
    do {
      x = rng.nextRange(-1, 1);
      y = rng.nextRange(-1, 1);
      z = rng.nextRange(-1, 1);
      d = x * x + y * y + z * z;
    } while (d > 1 || d < 0.01);
    const k = STARFIELD_RADIUS / Math.sqrt(d);
    positions.set([x * k, y * k, z * k], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

/** A dock: a lit pad beneath the berth and a departure gate ahead of it, in berth orientation. */
function createDock(body: Body, dock: BodyDock): THREE.Group {
  const group = new THREE.Group();
  group.name = `dock:${dock.id}`;
  const q = dockOrientation(body, dock);
  group.quaternion.set(q.x, q.y, q.z, q.w);
  const metal = new THREE.MeshStandardMaterial({ color: 0x8792aa, metalness: 0.5, roughness: 0.6 });
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(DOCK_PAD_RADIUS_M, DOCK_PAD_RADIUS_M, 2, 40),
    metal,
  );
  pad.position.y = -6;
  const gate = new THREE.Mesh(
    new THREE.TorusGeometry(DOCK_GATE_RADIUS_M, 2.5, 10, 48),
    new THREE.MeshBasicMaterial({ color: 0x4fd1ff }),
  );
  gate.position.z = -DOCK_GATE_AHEAD_M;
  group.add(pad, gate);
  return group;
}

export interface SystemScene {
  root: THREE.Group;
  /** Number of planet meshes (for tests and the debug hook). */
  readonly planetCount: number;
  /** Re-places every body relative to the camera's world position. Call once per frame. */
  update(cameraWorld: Vec3): void;
  dispose(): void;
}

/**
 * Builds the system-scale scene from generated data: the star (which also lights the scene), a
 * sphere per planet at its layout position and sim radius, a ring per orbital dock and the
 * starfield. Everything is positioned camera-relative in `update`.
 */
export function createSystemScene(seed: string, system: SystemGen): SystemScene {
  const root = new THREE.Group();
  const placed: Placed[] = [];
  const add = (object: THREE.Object3D, world: Vec3): void => {
    root.add(object);
    placed.push({ object, world });
  };

  root.add(createStarfield(seed));
  root.add(new THREE.AmbientLight(0xffffff, 0.12));

  const starColor = STAR_COLORS[system.star.class];
  const star = new THREE.Mesh(
    new THREE.SphereGeometry(system.star.radius, 48, 32),
    new THREE.MeshBasicMaterial({ color: starColor }),
  );
  const light = new THREE.PointLight(starColor, 2.2, 0, 0);
  star.add(light);
  add(star, { x: 0, y: 0, z: 0 });

  const bodies = bodiesOf(system);
  const body = (id: string): Body => bodies.find((candidate) => candidate.id === id) as Body;
  for (const planet of system.planets) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(planet.simRadius, 96, 64),
      new THREE.MeshStandardMaterial({ color: PLANET_COLORS[planet.class], roughness: 0.95 }),
    );
    mesh.name = `planet:${planet.id}`;
    add(mesh, planet.position);
    for (const dock of planet.docks) add(createDock(body(planet.id), dock), dock.position);
  }

  return {
    root,
    planetCount: system.planets.length,
    update(cameraWorld) {
      for (const { object, world } of placed) {
        const p = relativeTo(world, cameraWorld);
        object.position.set(p.x, p.y, p.z);
      }
    },
    dispose() {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          (object.geometry as THREE.BufferGeometry).dispose();
          (object.material as THREE.Material).dispose();
        }
      });
    },
  };
}
