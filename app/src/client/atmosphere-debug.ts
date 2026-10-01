/**
 * TASK-28.3: dev-only atmosphere dome pixel probe (the __ATMO__ hook).
 *
 * The shared math already proves the density acceptance criterion in pure
 * form (planets.test.ts: two seeded planets differ by > 20% mid-boundary
 * haze). This hook is its RENDER counterpart: it renders the real
 * atmosphere dome (createAtmosphereDome) at mid-boundary for a
 * minimum-haze and a maximum-haze atmospheric planet through a REAL WebGL
 * renderer (three.js needs a GL context — the vitest env has none) and
 * samples the center pixel, so the e2e can assert the density scaling is
 * visible in rendered pixels AND that the rendered color is exactly the
 * shared-math mix lerp(sky, atmo, hazeMid).
 *
 * Pixel math — two probe-local overrides make the expected pixel EXACT
 * (the dome module itself is untouched):
 *  1. THREE.ColorManagement converts `new THREE.Color('#hex')` sRGB →
 *     linear working space, but the dome's raw ShaderMaterial writes
 *     gl_FragColor with NO output transform. So the clear color is set
 *     with renderer.setClearColor using RAW sRGB floats (the numeric
 *     Color ctor performs no conversion) instead of scene.background,
 *     and the dome's uAtmoColor/uSkyColor uniforms are overridden with
 *     raw r/255, g/255, b/255 parsed from the committed haze colors.
 *  2. The shader's alpha is uHaze; the default normal blend would apply
 *     the haze TWICE (rendered = clear·(1-h²) + atmo·h² ≠ lerp). The
 *     probe writes the dome's color directly (THREE.NoBlending), so the
 *     sampled pixel is exactly mix(uSkyColor, uAtmoColor, uHaze) with
 *     uSkyColor == the clear color: lerp(clear, atmo, hazeMid).
 *
 * Like __DRIFT__ / __STREAM__ / __CAMERA__, installed only when
 * import.meta.env.DEV — production builds never ship it. Every
 * WebGLRenderer / dome / geometry is disposed after each sample.
 */

import * as THREE from 'three';

import { ATMOSPHERE_HAZE_COLORS, createAtmosphereDome } from '@client/render/atmosphere-dome';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import {
  planetAnchor,
  planetAtmosphereDensity,
  planetAtmosphereRadius,
} from '@shared/galaxy/planets';
import type { Planet } from '@shared/galaxy/types';
import { ATMOSPHERE_BOUNDARY_M, hazeFactor } from '@shared/physics/atmosphere';

/** Probe canvas size (small on purpose — headless SwiftShader). */
const CANVAS_W = 128;
const CANVAS_H = 72;
/** Cap the system scan for pair discovery (speed). */
const MAX_SYSTEMS = 40;
/** Clear color the expected pixel lerps from (sRGB). */
const CLEAR_HEX = '#0d1626';
/** Density AC threshold (relative mid-boundary haze difference). */
const HAZE_DIFF_MIN = 0.2;

/** One sampled planet: identity, the shared numbers, and the pixel math. */
export interface AtmoPlanetSample {
  systemId: string;
  planetId: string;
  planetClass: Planet['class'];
  /** planetAtmosphereDensity — the per-planet density that drives the haze. */
  density: number;
  /** hazeFactor at mid-boundary (the shared number the dome is set to). */
  hazeMid: number;
  /** Sampled center pixel [r,g,b] from the real WebGL drawing buffer. */
  pixel: [number, number, number];
  /** Expected mix lerp(clear, atmo, hazeMid) in 0..255 (floats). */
  expected: [number, number, number];
  /** Worst per-channel |pixel - expected| for this planet. */
  pixelError: number;
}

/** The comparison the e2e asserts on. */
export interface AtmoComparisonResult {
  seed: string;
  /** How many systems were scanned for the min/max pair. */
  systemsScanned: number;
  /** The minimum-haze (thin-atmosphere) planet. */
  a: AtmoPlanetSample;
  /** The maximum-haze (thick-atmosphere) planet. */
  b: AtmoPlanetSample;
  /** Relative haze difference (max-min)/max — AC: > 0.2. */
  hazeDiff: number;
  /** Worst per-channel |pixel - expected| over BOTH planets — AC: <= 3. */
  pixelError: number;
}

/** Shape of the debug surface the e2e test reads. */
export interface AtmosphereDebug {
  /** Render min- and max-haze domes at mid-boundary; compare pixels. */
  midBoundaryComparison(): AtmoComparisonResult;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __ATMO__?: AtmosphereDebug;
  }
}

/** Install the hook on window. No-op in production builds. */
export function installAtmosphereDebug(): void {
  if (!import.meta.env.DEV) return;
  window.__ATMO__ = { midBoundaryComparison: () => midBoundaryComparison() };
}

/** '#rrggbb' → [r, g, b] in 0..255 (raw, no color-space math). */
function parseHex255(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** An atmospheric planet found while scanning, with its shared numbers. */
interface Candidate {
  systemId: string;
  planet: Planet;
  /** Orbital-slot index within ITS system (positions the anchor). */
  index: number;
  density: number;
  hazeMid: number;
}

/**
 * Scan the first MAX_SYSTEMS systems of the seeded galaxy and return the
 * min- and max-hazeMid atmospheric planets. Fails loudly when the seed
 * yields no pair differing by > 20% (the density AC).
 */
function findHazePair(seed: string): { a: Candidate; b: Candidate; scanned: number } {
  const stars = generateStars(seed);
  const scanned = Math.min(stars.length, MAX_SYSTEMS);
  const candidates: Candidate[] = [];
  for (let i = 0; i < scanned; i++) {
    const system = generateSystem(seed, stars[i].id);
    system.planets.forEach((planet, index) => {
      if (!planet.hasAtmosphere) return;
      const density = planetAtmosphereDensity(planet);
      const hazeMid = hazeFactor(ATMOSPHERE_BOUNDARY_M / 2, {
        atmosphereRadius: planetAtmosphereRadius(planet),
        atmosphereDensity: density,
      });
      candidates.push({ systemId: system.systemId, planet, index, density, hazeMid });
    });
  }
  if (candidates.length < 2) {
    throw new Error(
      `__ATMO__: seed ${seed} yielded fewer than 2 atmospheric planets in the first ${scanned} systems`,
    );
  }
  let min = candidates[0];
  let max = candidates[0];
  for (const cand of candidates) {
    if (cand.hazeMid < min.hazeMid) min = cand;
    if (cand.hazeMid > max.hazeMid) max = cand;
  }
  const hazeDiff = (max.hazeMid - min.hazeMid) / Math.max(min.hazeMid, max.hazeMid);
  if (hazeDiff <= HAZE_DIFF_MIN) {
    throw new Error(
      `__ATMO__: seed ${seed} min/max mid-boundary haze pair differs by only ${hazeDiff.toFixed(
        3,
      )} (the density AC needs > ${HAZE_DIFF_MIN})`,
    );
  }
  return { a: min, b: max, scanned };
}

/**
 * Render ONE planet's dome at mid-boundary in isolation (offscreen canvas,
 * real WebGL renderer) and return its sample. The camera sits 500 u above
 * the surface anchor (inside the 1010 u dome) looking horizontal, so the
 * center pixel always sees the dome band — the shader is uniform, so the
 * exact hit point does not matter.
 */
function probePlanet(cand: Candidate): AtmoPlanetSample {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(CANVAS_W, CANVAS_H, false);
  const dome = createAtmosphereDome(planetAtmosphereRadius(cand.planet));
  try {
    const scene = new THREE.Scene();
    const clear = parseHex255(CLEAR_HEX);
    renderer.setClearColor(new THREE.Color(clear[0] / 255, clear[1] / 255, clear[2] / 255), 1);

    const anchor = planetAnchor(cand.index);
    dome.mesh.position.set(anchor.x, 0, anchor.z);
    scene.add(dome.mesh);
    dome.set(cand.hazeMid, new THREE.Color()); // drives haze + visibility
    // Raw sRGB uniform overrides (see the ColorManagement note in the
    // module header): shader output becomes mix(clear, atmo, haze) verbatim.
    const atmo = parseHex255(ATMOSPHERE_HAZE_COLORS[cand.planet.class]);
    (dome.material.uniforms.uAtmoColor.value as THREE.Vector3).set(
      atmo[0] / 255,
      atmo[1] / 255,
      atmo[2] / 255,
    );
    (dome.material.uniforms.uSkyColor.value as THREE.Vector3).set(
      clear[0] / 255,
      clear[1] / 255,
      clear[2] / 255,
    );
    // NoBlending: write the dome color directly (avoids the double-haze
    // alpha blend — see the module header).
    dome.material.blending = THREE.NoBlending;
    dome.material.transparent = false;

    const camera = new THREE.PerspectiveCamera(60, CANVAS_W / CANVAS_H, 0.1, 5000);
    camera.position.set(anchor.x, 500, anchor.z);
    camera.lookAt(anchor.x, 500, anchor.z + 100);

    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const buf = new Uint8Array(4);
    gl.readPixels(CANVAS_W >> 1, CANVAS_H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const pixel: [number, number, number] = [buf[0], buf[1], buf[2]];

    const h = cand.hazeMid;
    const expected: [number, number, number] = [
      clear[0] + (atmo[0] - clear[0]) * h,
      clear[1] + (atmo[1] - clear[1]) * h,
      clear[2] + (atmo[2] - clear[2]) * h,
    ];
    let pixelError = 0;
    for (let c = 0; c < 3; c++) {
      pixelError = Math.max(pixelError, Math.abs(pixel[c] - expected[c]));
    }

    return {
      systemId: cand.systemId,
      planetId: cand.planet.id,
      planetClass: cand.planet.class,
      density: cand.density,
      hazeMid: cand.hazeMid,
      pixel,
      expected,
      pixelError,
    };
  } finally {
    // No WebGL context leak: geometry, material and renderer all disposed.
    dome.dispose();
    renderer.dispose();
  }
}

function midBoundaryComparison(): AtmoComparisonResult {
  const drift = window.__DRIFT__;
  if (!drift?.seed) {
    throw new Error('__ATMO__: server seed not ready (__DRIFT__.seed is null)');
  }
  const seed = drift.seed;
  const { a, b, scanned } = findHazePair(seed);
  const sa = probePlanet(a);
  const sb = probePlanet(b);
  return {
    seed,
    systemsScanned: scanned,
    a: sa,
    b: sb,
    hazeDiff: (sb.hazeMid - sa.hazeMid) / Math.max(sa.hazeMid, sb.hazeMid),
    pixelError: Math.max(sa.pixelError, sb.pixelError),
  };
}
