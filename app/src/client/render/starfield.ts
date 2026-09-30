import * as THREE from 'three';
import { hash2, Rng, seedFromString } from '@shared/random';
import { frameMonitor } from '@client/perf/frameMonitor';

/**
 * TASK-70: minimal deterministic starfield renderer.
 *
 * Placeholder for the real view: it gives the e2e harness a WebGL canvas to
 * sample (headless render smoke) and stands in until the streaming pipeline
 * (TASK-26) takes over per-system rendering. Everything visual is generated
 * from the shared deterministic PRNG, so two clients with the same seed see
 * the identical sky (a property TASK-71's determinism suite builds on).
 *
 * - Sky: one inverted sphere with a vertical gradient (deep blue → black).
 *   The gradient (not the point sprites) is what guarantees a 32x32 pixel
 *   sample is never uniform, no matter where it lands.
 * - Stars: points on a spherical shell, bluish-white with a few warm ones,
 *   slowly drifting (0.3°/s) so the scene is visibly alive.
 */

export const STARFIELD_RADIUS_MIN = 150;
export const STARFIELD_RADIUS_MAX = 200;
export const DEFAULT_STAR_COUNT = 2500;

/** Sub-seed tag so the starfield never consumes another entity's PRNG stream. */
const STAR_SUBSEED = 0x5a7f2e9c1n;

export interface StarfieldData {
  count: number;
  /** xyz per star, on a shell between RADIUS_MIN and RADIUS_MAX. */
  positions: Float32Array;
  /** rgb per star, components in [0, 1]. */
  colors: Float32Array;
}

/**
 * Pure, deterministic star generation: uniform directions on the unit
 * sphere, random radius in [RADIUS_MIN, RADIUS_MAX), and a bluish-white
 * palette with ~15 % warm stars and 0.45–1.0 brightness. Same seed →
 * bit-identical arrays (Node and browser).
 */
export function generateStarfield(seed: string, count = DEFAULT_STAR_COUNT): StarfieldData {
  const rng = new Rng(hash2(seedFromString(seed), STAR_SUBSEED));
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = 1 - 2 * rng.nextF64();
    const phi = 2 * Math.PI * rng.nextF64();
    const ring = Math.sqrt(1 - z * z);
    const radius =
      STARFIELD_RADIUS_MIN + rng.nextF64() * (STARFIELD_RADIUS_MAX - STARFIELD_RADIUS_MIN);
    positions[i * 3] = ring * Math.cos(phi) * radius;
    positions[i * 3 + 1] = z * radius;
    positions[i * 3 + 2] = ring * Math.sin(phi) * radius;

    const warm = rng.nextF64() < 0.15;
    const brightness = 0.45 + 0.55 * rng.nextF64();
    colors[i * 3] = brightness * (warm ? 1.0 : 0.86);
    colors[i * 3 + 1] = brightness * (warm ? 0.92 : 0.9);
    colors[i * 3 + 2] = brightness * (warm ? 0.82 : 1.0);
  }
  return { count, positions, colors };
}

/**
 * The shared deep-space background (sky sphere + point-sprite stars),
 * built once per seed. Used both by the boot starfield (createStarfield)
 * and by the per-system WorldManager (TASK-8), so every view — claim
 * screen, system view, warp transitions — sits on the same deterministic
 * sky.
 */
export interface BackgroundHandle {
  /** Inverted gradient sphere (add to a scene). */
  sky: THREE.Mesh;
  /** Pixel-constant star sprites on a 150–200 u shell (add to a scene). */
  stars: THREE.Points;
  dispose(): void;
}

export function createBackground(seed: string, count = DEFAULT_STAR_COUNT): BackgroundHandle {
  const skyGeometry = buildSkyGeometry(420);
  const skyMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);

  const data = generateStarfield(seed, count);
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  const starMaterial = new THREE.PointsMaterial({
    size: 1.8,
    // Pixel-constant sprites: with sizeAttenuation on, stars 150–200 u away
    // would collapse to sub-pixel at this viewport.
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);

  return {
    sky,
    stars,
    dispose(): void {
      skyGeometry.dispose();
      skyMaterial.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
    },
  };
}

/** Inverted-sphere geometry with a vertical vertex-color gradient (dark → blue). */
function buildSkyGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 48, 24);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(positions.count * 3);
  const bottom = new THREE.Color('#04060b');
  const top = new THREE.Color('#131f33');
  const c = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    const t = THREE.MathUtils.clamp((positions.getY(i) / radius + 1) / 2, 0, 1);
    c.copy(bottom).lerp(top, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export interface StarfieldHandle {
  dispose(): void;
}

/**
 * Owns the three.js scene on `canvas` and renders one frame per
 * requestAnimationFrame. `preserveDrawingBuffer` is on deliberately: the
 * TASK-70 e2e samples readPixels OUTSIDE the rAF loop (headless SwiftShader),
 * where the back buffer is otherwise cleared after compositing.
 */
export function createStarfield(
  canvas: HTMLCanvasElement,
  seed: string,
  count = DEFAULT_STAR_COUNT,
): StarfieldHandle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);

  const background = createBackground(seed, count);
  scene.add(background.sky);
  scene.add(background.stars);
  const stars = background.stars;

  const clock = new THREE.Clock();
  let disposed = false;
  let raf = 0;

  const resize = (): void => {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const frame = (): void => {
    if (disposed) return;
    frameMonitor.beginFrame();
    resize();
    stars.rotation.y = clock.getElapsedTime() * 0.005; // slow drift (~0.3°/s)
    renderer.render(scene, camera);
    // renderer.info.render resets per frame — capture it right after the
    // render, before the next frame (TASK-57 frame monitor).
    frameMonitor.endFrame({
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    });
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    dispose(): void {
      disposed = true;
      cancelAnimationFrame(raf);
      background.dispose();
      renderer.dispose();
    },
  };
}
