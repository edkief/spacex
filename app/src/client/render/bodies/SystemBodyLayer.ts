/**
 * System body layer — TASK-76.
 *
 * Renders the star the player is orbiting plus its planets. The
 * bodies themselves are derived on the client from the galaxy seed
 * (`@client/world/systemBodies`), so a warp only has to rebuild the
 * layer — there is no server traffic and no per-frame allocation.
 *
 * Composition (React-free; the owning loop calls `sync`):
 *   - **star** — an emissive sphere with a `THREE.PointLight` at
 *     its centre so everything nearby is lit by *its* light rather
 *     than the ambient rig TASK-75 installed.
 *   - **planet** — a `MeshStandardMaterial` sphere coloured per
 *     `PlanetClass`, plus a slightly larger transparent shell when
 *     the generated planet has an atmosphere.
 *
 * Placement lives here (in three.js units) so `systemBodies.ts`
 * stays pure: the star sits `STAR_SYSTEM_OFFSET_M` in front of the
 * system origin (the spawn point), each planet rides its own orbit
 * ring around the star.
 *
 * @see ../../world/systemBodies.ts — the pure derivation.
 * @see ../host/GameCanvas.tsx     — mounts the layer.
 */
import {
  BackSide,
  Color,
  Group,
  type Object3D,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointLight,
  SphereGeometry,
  Vector3,
} from "three";

import {
  STAR_SYSTEM_OFFSET_M,
  computeSystemBodies,
  planetOrbitOffset,
  type PlanetBody,
  type SystemBodies,
} from "../../world/systemBodies.js";
import { getGalaxySeed, subscribeGalaxySeed } from "../../world/seedContext.js";

/** Colours per spectral class (hot → cold). */
export const STAR_COLOURS: Readonly<Record<string, number>> = {
  O: 0x9bb0ff,
  B: 0xb4c7ff,
  A: 0xe4ecff,
  F: 0xfff4e8,
  G: 0xffe08a,
  K: 0xffb46b,
  M: 0xff7a52,
};

/** Surface colours per `PlanetClass`. */
export const PLANET_COLOURS: Readonly<Record<PlanetBody["class"], number>> = {
  rocky: 0xa5603c,
  terran: 0x3f7f5c,
  ocean: 0x2f6fb5,
  gas: 0xd8b26a,
  ice: 0xcfe4f2,
};

/** Atmosphere shell tint (shared by every class). */
export const ATMOSPHERE_COLOUR = 0x7fb7ff;

/** Sphere segment counts — cheap, and the bodies are metres-scale
 *  spheres with no surface detail yet (TASK-25/26 own terrain). */
const STAR_SEGMENTS = 32;
const PLANET_SEGMENTS = 24;

/** Atmosphere shell is this much larger than the planet surface. */
export const ATMOSPHERE_SHELL_SCALE = 1.12;

/** Star light intensity. `decay = 0` (no inverse-square falloff) so
 *  a planet on the far side of the system is still lit by its star —
 *  three.js' physically-correct falloff would make everything past
 *  a few hundred metres pure black. */
export const STAR_LIGHT_INTENSITY = 2.6;

/** Options for {@link SystemBodyLayer}. */
export interface SystemBodyLayerOptions {
  /** Seed override (tests). Defaults to the seed context. */
  getSeed?: () => string | null;
}

/** Options for {@link SystemBodyLayer.sync}. */
export interface SystemBodySyncOptions {
  /** Seed override (tests). Defaults to the seed context. */
  seed?: string | null;
}

/**
 * Owns one `THREE.Group` of system bodies. `sync(systemId)` is a
 * cheap no-op when the system (and seed) are unchanged, so the
 * frame loop can call it every frame.
 */
export class SystemBodyLayer {
  /** Mount point — add this to the scene once. */
  readonly root: Group;
  /** Number of rendered bodies (star + planets). */
  #bodyCount = 0;
  /** The system id currently rendered, or `null`. */
  #systemId: string | null = null;
  /** The seed the current bodies were derived from. */
  #seed: string | null = null;
  #disposed = false;
  readonly #getSeed: () => string | null;
  #unsubscribeSeed: (() => void) | null = null;

  constructor(options: SystemBodyLayerOptions = {}) {
    this.#getSeed = options.getSeed ?? ((): string | null => getGalaxySeed());
    this.root = new Group();
    this.root.name = "system-bodies";
    // A late seed arrival must force the next `sync` to rebuild,
    // hence the subscription (the render loop never stops ticking).
    this.#unsubscribeSeed = subscribeGalaxySeed(() => {
      if (this.#seed !== this.#getSeed()) this.#seed = null;
    });
  }

  /** Rendered body count (star + planets). */
  get bodyCount(): number {
    return this.#bodyCount;
  }

  /** The system id currently rendered, or `null` when empty. */
  get systemId(): string | null {
    return this.#systemId;
  }

  /** The seed the current bodies were derived from. */
  get seed(): string | null {
    return this.#seed;
  }

  /**
   * Rebuild the layer for `systemId` when it (or the seed) changed.
   * Returns `true` when a rebuild happened, `false` for the cheap
   * no-op path. Never throws — an unknown system renders nothing.
   */
  sync(systemId: string | null, options: SystemBodySyncOptions = {}): boolean {
    if (this.#disposed) return false;
    const seed = options.seed === undefined ? this.#getSeed() : options.seed;
    const nextId = systemId ?? null;
    if (seed === this.#seed && nextId === this.#systemId) return false;

    this.clear();
    this.#seed = seed;
    this.#systemId = nextId;
    if (seed === null || nextId === null || seed.length === 0) return true;

    const bodies = computeSystemBodies(seed, nextId);
    this.#build(bodies);
    return true;
  }

  /** Remove every child + dispose its GPU resources. Idempotent. */
  clear(): void {
    for (const child of [...this.root.children]) {
      this.root.remove(child);
      disposeObject(child);
    }
    this.#bodyCount = 0;
  }

  /** Release the layer. Safe to call twice (StrictMode races). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeSeed?.();
    this.#unsubscribeSeed = null;
    this.clear();
    this.#systemId = null;
    this.#seed = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Instantiate the meshes for a computed body set. */
  #build(bodies: SystemBodies): void {
    const star = bodies.star;
    if (star !== null) {
      const colour = new Color(STAR_COLOURS[star.class] ?? 0xffe08a);
      const mesh = new Mesh(
        new SphereGeometry(Math.max(1, star.renderRadiusM), STAR_SEGMENTS, STAR_SEGMENTS / 2),
        new MeshStandardMaterial({
          color: 0x000000,
          emissive: colour,
          emissiveIntensity: 2.4,
          roughness: 1,
        }),
      );
      mesh.name = `star:${star.id}`;
      // The star sits `STAR_SYSTEM_OFFSET_M` ahead of the spawn
      // point so the player's "fly toward the star" hint points at
      // something visible.
      mesh.position.set(0, 0, STAR_SYSTEM_OFFSET_M);
      this.root.add(mesh);

      const light = new PointLight(colour.getHex(), STAR_LIGHT_INTENSITY, 0, 0);
      light.name = "star-light";
      light.position.copy(mesh.position);
      this.root.add(light);
      this.#bodyCount += 1;
    }

    const starPos = new Vector3(0, 0, STAR_SYSTEM_OFFSET_M);
    for (const planet of bodies.planets) {
      const offset = planetOrbitOffset(planet.orbitIndex, planet.orbitDistanceM);
      const group = new Group();
      group.name = `planet:${planet.id}`;
      group.position.set(starPos.x + offset.x, starPos.y + offset.y, starPos.z + offset.z);

      const radius = Math.max(1, planet.radiusM);
      const surface = new Mesh(
        new SphereGeometry(radius, PLANET_SEGMENTS, PLANET_SEGMENTS / 2),
        new MeshStandardMaterial({
          color: PLANET_COLOURS[planet.class],
          roughness: 0.85,
          metalness: 0.05,
        }),
      );
      surface.name = "surface";
      group.add(surface);

      if (planet.hasAtmosphere) {
        const shell = new Mesh(
          new SphereGeometry(radius * ATMOSPHERE_SHELL_SCALE, PLANET_SEGMENTS, PLANET_SEGMENTS / 2),
          new MeshBasicMaterial({
            color: ATMOSPHERE_COLOUR,
            transparent: true,
            opacity: 0.18,
            side: BackSide,
            depthWrite: false,
          }),
        );
        shell.name = "atmosphere";
        group.add(shell);
      }

      this.root.add(group);
      this.#bodyCount += 1;
    }
  }
}

/** Dispose every geometry + material under `object`. */
function disposeObject(object: Object3D): void {
  object.traverse((node) => {
    const mesh = node as Mesh;
    const geometry = mesh.geometry as { dispose?: () => void } | undefined;
    if (geometry !== undefined && typeof geometry.dispose === "function") geometry.dispose();
    const material = mesh.material as { dispose?: () => void } | undefined;
    if (material !== undefined && typeof material.dispose === "function") material.dispose();
  });
}
