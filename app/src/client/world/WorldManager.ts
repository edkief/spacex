import * as THREE from 'three';

import { hash2, seedFromString } from '@shared/random';
import { SPAWN_GATE_POS } from '@shared/galaxy/spawn';
import type { PlanetClass, SpectralClass, SystemGen } from '@shared/galaxy/types';
import { createBackground } from '@client/render/starfield';

/**
 * The in-system world (TASK-8). Owns the three.js scene on the game canvas
 * once the player has a system: the shared deterministic deep-space
 * background plus the CURRENT SYSTEM — star at the origin, low-detail
 * placeholder planets, and the spawn gate the warp arrives at (100 u +X of
 * the star, facing it).
 *
 * `swapWorld` is the atomic warp transition: build the new system group
 * first (budget < 300 ms — measured, see WORLD_BUILD_BUDGET_MS), THEN
 * dispose + replace the old one, so the canvas never draws a blank frame.
 * Only the near-field is generated here (star + 1–2 planet spheres);
 * detailed streaming is TASK-26.
 */

/** World-swap build budget (spec step 2): a swap must build faster than this. */
export const WORLD_BUILD_BUDGET_MS = 300;
/** Rendered planets: the near-field only (streaming arrives in TASK-26). */
export const WORLD_PLANET_COUNT = 2;
/** In-system star radius (world units; the gate sits 100 u out). */
export const WORLD_STAR_RADIUS = 14;
/** Placeholder planet sphere radius (visual only — LODs are TASK-26). */
export const WORLD_PLANET_RADIUS = 4;
/** Innermost planet orbit radius (world units). */
export const WORLD_FIRST_ORBIT = 30;
/** Orbit spacing between rendered planets. */
export const WORLD_ORBIT_STEP = 18;

/** Standard spectral-class palette (hot O → cool M). */
export const STAR_COLORS: Record<SpectralClass, string> = {
  O: '#9bb0ff',
  B: '#aabfff',
  A: '#cad7ff',
  F: '#f8f7ff',
  G: '#fff4e8',
  K: '#ffd2a1',
  M: '#ffcc6f',
};

/** Planet-class placeholder palette (visual only). */
export const PLANET_COLORS: Record<PlanetClass, string> = {
  rocky: '#b08a5a',
  terran: '#5da463',
  ocean: '#4f83cc',
  gas: '#c9a36b',
  ice: '#a8cfe0',
};

/** One rendered planet of the near-field. */
export interface WorldPlanetLayout {
  planetId: string;
  color: string;
  radius: number;
  orbitRadius: number;
  /** Initial orbital angle, radians (deterministic from the system id). */
  angle: number;
}

/**
 * Pure, deterministic near-field layout for a system (tested without
 * three.js): star at the origin, the first WORLD_PLANET_COUNT planets on
 * seeded orbit angles, and the spawn gate 100 u along +X facing the star.
 */
export function buildSystemLayout(system: SystemGen): {
  systemId: string;
  starClass: SpectralClass;
  starColor: string;
  planets: WorldPlanetLayout[];
  gate: { x: number; y: number; z: number };
} {
  const count = Math.min(WORLD_PLANET_COUNT, system.planets.length);
  const subSeed = seedFromString(system.systemId);
  const planets: WorldPlanetLayout[] = [];
  for (let i = 0; i < count; i++) {
    const planet = system.planets[i];
    const angleHash = Number(hash2(subSeed, BigInt(0x7717) + BigInt(i)) % 1_000_000n);
    const angle = (angleHash / 1_000_000) * Math.PI * 2;
    planets.push({
      planetId: planet.id,
      color: PLANET_COLORS[planet.class],
      radius: WORLD_PLANET_RADIUS,
      orbitRadius: WORLD_FIRST_ORBIT + i * WORLD_ORBIT_STEP,
      angle,
    });
  }
  return {
    systemId: system.systemId,
    starClass: system.star.class,
    starColor: STAR_COLORS[system.star.class],
    planets,
    gate: { ...SPAWN_GATE_POS },
  };
}

/** Build the three.js group for one system (all geometry low-detail). */
function buildWorldGroup(system: SystemGen): THREE.Group {
  const layout = buildSystemLayout(system);
  const group = new THREE.Group();

  const starGeometry = new THREE.SphereGeometry(WORLD_STAR_RADIUS, 24, 16);
  const starMaterial = new THREE.MeshBasicMaterial({ color: layout.starColor });
  group.add(new THREE.Mesh(starGeometry, starMaterial));

  for (const planet of layout.planets) {
    const geometry = new THREE.SphereGeometry(planet.radius, 16, 10);
    const material = new THREE.MeshBasicMaterial({ color: planet.color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      Math.cos(planet.angle) * planet.orbitRadius,
      0,
      Math.sin(planet.angle) * planet.orbitRadius,
    );
    group.add(mesh);
  }

  // Spawn gate: a ring at the gate position, plane facing the star (i.e.
  // perpendicular to the +X axis) — the visual marker of the warp arrival.
  const gateGeometry = new THREE.TorusGeometry(6, 0.5, 8, 32);
  const gateMaterial = new THREE.MeshBasicMaterial({ color: '#67e8f9' });
  const gate = new THREE.Mesh(gateGeometry, gateMaterial);
  gate.position.set(layout.gate.x, layout.gate.y, layout.gate.z);
  gate.rotation.y = Math.PI / 2;
  group.add(gate);

  return group;
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const material = obj.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
}

/**
 * Owns the renderer + scene on the game canvas for the in-system view.
 * `swapWorld` performs the atomic warp transition and returns the measured
 * build time in ms (asserted against WORLD_BUILD_BUDGET_MS by the e2e).
 */
export class WorldManager {
  /** The system currently rendered (null before the first swapWorld). */
  currentSystemId: string | null = null;
  /** ms the last swapWorld build took (-1 before the first swap). */
  lastSwapMs = -1;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly background: ReturnType<typeof createBackground>;
  private worldGroup: THREE.Group | null = null;
  private readonly clock = new THREE.Clock();
  private disposed = false;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement, seed: string) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      // Preserve the drawing buffer: e2e samples readPixels OUTSIDE the rAF
      // loop (headless SwiftShader) — same reason as the boot starfield.
      preserveDrawingBuffer: true,
    });
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
    // A vantage point beyond the spawn gate: the star sits at the center of
    // the view and the gate (100 u +X) is between camera and star.
    this.camera.position.set(150, 40, 150);
    this.camera.lookAt(0, 0, 0);

    this.background = createBackground(seed);
    this.scene.add(this.background.sky);
    this.scene.add(this.background.stars);

    const frame = (): void => {
      if (this.disposed) return;
      this.resize();
      // Same slow drift as the boot starfield — the sky stays alive through
      // the warp (never a static / black frame).
      this.background.stars.rotation.y = this.clock.getElapsedTime() * 0.005;
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /**
   * Atomic world swap (warp arrival): build the new system group FIRST
   * (the old one still renders underneath), then replace + dispose the old
   * group. Returns the measured build time in ms.
   */
  swapWorld(system: SystemGen): number {
    const t0 = performance.now();
    const next = buildWorldGroup(system);
    if (this.worldGroup) {
      this.scene.remove(this.worldGroup);
      disposeGroup(this.worldGroup);
    }
    this.worldGroup = next;
    this.scene.add(next);
    this.currentSystemId = system.systemId;
    this.lastSwapMs = performance.now() - t0;
    return this.lastSwapMs;
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.worldGroup) {
      this.scene.remove(this.worldGroup);
      disposeGroup(this.worldGroup);
      this.worldGroup = null;
    }
    this.background.dispose();
    this.renderer.dispose();
  }
}
