import * as THREE from 'three';

import { hash2, seedFromString } from '@shared/random';
import type { Livery } from '@shared/protocol/schemas';
import { SPAWN_GATE_POS } from '@shared/galaxy/spawn';
import { planetAnchor } from '@shared/galaxy/planets';
import type { PlanetClass, SpectralClass, SystemGen } from '@shared/galaxy/types';
import { ATMOSPHERE_BOUNDARY_M } from '@shared/physics/atmosphere';
import type { Vec3 } from '@shared/physics/vec';
import type { Regime } from '@shared/regime';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { createBackground } from '@client/render/starfield';
import {
  createAtmosphereDome,
  ATMOSPHERE_HAZE_COLORS,
  type AtmosphereDome,
} from '@client/render/atmosphere-dome';
import { frameMonitor } from '@client/perf/frameMonitor';
import { CameraRig } from '@client/camera/CameraRig';
import { atmosphereViewFor } from './atmosphere-view';

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
/** Pad rings are visible only while the player is within this (m, TASK-29.3). */
export const PAD_RING_VISIBLE_RANGE_M = 500;
/** A ring floats this far above the pad surface (m) so it cannot z-fight it. */
export const PAD_RING_SURFACE_OFFSET_M = 0.25;

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

/** One pad ring marker placement (pure data, mirrors the shared PadInfo). */
export interface PadRingPlacement {
  padId: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

/**
 * Pure: the pad ring placements of a system — one ring per pad from the
 * SHARED deterministic pad list (the same list the server's dock logic uses,
 * cached per (seed, systemId) inside the shared module).
 */
export function padRingsFor(
  seed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): PadRingPlacement[] {
  return padsForSystem(seed, system).map((p) => ({
    padId: p.padId,
    x: p.pos.x,
    y: p.pos.y,
    z: p.pos.z,
    radius: p.radius,
  }));
}

/**
 * Pure: is a pad ring at `padPos` visible to the player at `pos` — within
 * PAD_RING_VISIBLE_RANGE_M (3-D distance, metres = world units). No known
 * player position (before the first entity_update) → hidden.
 */
export function padRingVisible(pos: Vec3 | null, padPos: Vec3): boolean {
  if (!pos) return false;
  return (
    Math.hypot(pos.x - padPos.x, pos.y - padPos.y, pos.z - padPos.z) <= PAD_RING_VISIBLE_RANGE_M
  );
}

/**
 * The glowing pad rings of one system: one additive flat ring per pad, laid
 * on the pad normal (+Y), each initially hidden (the frame loop reveals a
 * ring only while the player is within PAD_RING_VISIBLE_RANGE_M). They live
 * in the per-system world group, so a world swap removes them automatically.
 */
function buildPadRings(
  seed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): THREE.Mesh[] {
  const rings: THREE.Mesh[] = [];
  for (const pad of padRingsFor(seed, system)) {
    const geometry = new THREE.RingGeometry(pad.radius * 0.55, pad.radius, 48);
    const material = new THREE.MeshBasicMaterial({
      color: '#67e8f9',
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(pad.x, pad.y + PAD_RING_SURFACE_OFFSET_M, pad.z);
    mesh.rotation.x = -Math.PI / 2; // flat on the pad normal (+Y up)
    mesh.visible = false;
    rings.push(mesh);
  }
  return rings;
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
 * Parse a #rrggbb hex into RAW 0..1 sRGB floats on a Color (no working-space
 * conversion): the dome's ShaderMaterial writes gl_FragColor with no output
 * transform, so a `new THREE.Color(hex)` (which converts sRGB → linear)
 * would render too dark and break the e2e pixel math (TASK-28 note).
 */
function setFromHex01(color: THREE.Color, hex: string): THREE.Color {
  const n = parseInt(hex.slice(1), 16);
  return color.setRGB(
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
    THREE.NoColorSpace,
  );
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
  /** The galaxy seed this manager's world (and pad list) derives from. */
  private readonly seed: string;
  private readonly background: ReturnType<typeof createBackground>;
  /** The system currently rendered as an OBJECT (null before the first
   * swapWorld): atmosphereViewFor needs the planet list, not just the id. */
  private system: SystemGen | null = null;
  /** The shared atmosphere dome (one dome serves every planet — repositioned). */
  private readonly dome: AtmosphereDome;
  /** Scratch color for dome tints (never escapes the manager). */
  private readonly tempColor = new THREE.Color();
  private worldGroup: THREE.Group | null = null;
  /** The client-side pad list of the current system (empty before the first
   * swapWorld): the shared deterministic list, same data the server docks by. */
  private pads: PadInfo[] = [];
  /** The glowing pad rings of the current system (per-frame culling list). */
  private padRings: THREE.Mesh[] = [];
  /** The player ship's last-known world position (null before the first
   * entity_update): drives pad-ring visibility, nothing else. */
  private selfPos: Vec3 | null = null;
  private readonly clock = new THREE.Clock();
  /**
   * TASK-31: the on-foot camera. The rig owns the SAME PerspectiveCamera but
   * only DRIVES it while active (after the first disembarkTo) — until then
   * the manager's spectator camera stays exactly as before.
   */
  private readonly cameraRig: CameraRig;
  /** True from the first setCharacterPos until clearCharacter (rig runs). */
  private rigActive = false;
  /**
   * TASK-32: the placeholder character model (capsule body + head, lit-free)
   * standing at the character's feet; null = on ship. Driven per frame by
   * the local CharacterPredictor (setCharacterTransform) and re-corrected
   * by the 10 Hz snapshot (setCharacterPos).
   */
  private characterMesh: THREE.Group | null = null;
  /** The model's two materials (livery re-tint targets; null = on ship). */
  private characterMats: { body: THREE.MeshBasicMaterial; head: THREE.MeshBasicMaterial } | null =
    null;
  /** The livery colors last applied (hull body, accent head) — dedup guard. */
  private characterLivery: { body: string; head: string } | null = null;
  /** The pad plane height feeding the handoff nudge (flat disc under the feet). */
  private rigPadHeight = 0;
  private lastFrameMs = performance.now();
  private disposed = false;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement, seed: string) {
    this.seed = seed;
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

    // TASK-31: the continuous camera (TASK-27 rig) wraps the same camera.
    // Inert until the first disembark: handoff('onfoot') animates FROM the
    // current (spectator or cockpit) pose, so whatever the camera shows at
    // disembark time is the handoff's start — no cut.
    this.cameraRig = new CameraRig({
      camera: this.camera,
      // The character stands on the pad disc: a flat plane at the pad height
      // (no client terrain sampling needed for the nudge).
      heightAt: () => this.rigPadHeight,
    });

    this.background = createBackground(seed);
    // TASK-28.1: the skybox fades OUT under the atmosphere dome. The sky
    // starts fully opaque; its opacity (like the dome's haze) is driven by
    // the ONE shared haze number in setAtmosphereView, so the two never
    // desync. The stars material is already transparent @ 0.95 — its BASE
    // opacity stays untouched (setAtmosphereView scales it from there).
    (this.background.sky.material as THREE.MeshBasicMaterial).transparent = true;
    // Every atmospheric planet shares ATMOSPHERE_BOUNDARY_M, so ONE dome
    // serves all — repositioned per planet (at most one is active at a time).
    this.dome = createAtmosphereDome(ATMOSPHERE_BOUNDARY_M);
    this.scene.add(this.background.sky);
    this.scene.add(this.background.stars);
    this.scene.add(this.dome.mesh); // renderOrder 2: composites over sky + stars

    const frame = (): void => {
      if (this.disposed) return;
      frameMonitor.beginFrame();
      // TASK-31: drive the on-foot camera rig (only while the player is
      // disembarked — before that the spectator camera is untouched).
      const nowMs = performance.now();
      if (this.rigActive) {
        this.cameraRig.update(Math.min(0.1, (nowMs - this.lastFrameMs) / 1000));
      }
      this.lastFrameMs = nowMs;
      this.resize();
      // Same slow drift as the boot starfield — the sky stays alive through
      // the warp (never a static / black frame).
      this.background.stars.rotation.y = this.clock.getElapsedTime() * 0.005;
      // TASK-29.3: pad-ring culling (a handful of pads at most — per-frame
      // distance checks against the last-known player position are trivial).
      for (const ring of this.padRings) {
        ring.visible = padRingVisible(this.selfPos, ring.position);
      }
      this.renderer.render(this.scene, this.camera);
      // renderer.info.render resets per frame — capture it right after the
      // render, before the next frame (TASK-57 frame monitor).
      frameMonitor.endFrame({
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      });
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
    // TASK-29.3: the pad list is system-derived world state (the shared
    // deterministic list, cached per system) and the rings live in the
    // per-system group, so both are rebuilt here and die with the old group.
    this.pads = padsForSystem(this.seed, system);
    this.padRings = buildPadRings(this.seed, system);
    for (const ring of this.padRings) next.add(ring);
    if (this.worldGroup) {
      this.scene.remove(this.worldGroup);
      disposeGroup(this.worldGroup);
    }
    this.worldGroup = next;
    this.scene.add(next);
    this.currentSystemId = system.systemId;
    this.system = system;
    this.lastSwapMs = performance.now() - t0;
    return this.lastSwapMs;
  }

  /** The client-side pad list of the current system (empty before the first swap). */
  getPads(): PadInfo[] {
    return this.pads;
  }

  /**
   * TASK-31: the player is on foot — their character entity (from the self
   * entity_update path) first appears. Spawns the placeholder capsule at the
   * character's position and hands the shared camera off to the on-foot mode
   * (the 600 ms TASK-27 handoff animation, terrain-nudged against the pad
   * plane). Later calls (10 Hz) only move the capsule — the rig keeps
   * following. Cheap to call every self update.
   */
  setCharacterPos(pos: Vec3): void {
    // Feed the rig FIRST so the handoff (below) precomputes its path to the
    // character's ACTUAL position, not the rig's stale origin.
    this.cameraRig.setCharacterPosition(pos);
    if (!this.characterMesh) {
      const model = buildCharacterMesh();
      this.characterMesh = model.group;
      this.characterMats = { body: model.body, head: model.head };
      this.scene.add(this.characterMesh);
      // The pad the character stands on = the closest seeded pad (at most a
      // handful per system); its flat height feeds the handoff nudge AND the
      // local CharacterPredictor's terrain (flat on the pad disc — prediction
      // matches the server exactly there and the 10 Hz snapshot corrects
      // any off-pad drift, TASK-32).
      let bestIdx: number | null = null;
      let bestD = Infinity;
      for (let i = 0; i < this.pads.length; i++) {
        const pad = this.pads[i];
        const d = Math.hypot(pad.pos.x - pos.x, pad.pos.z - pos.z);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      const pad = bestIdx !== null ? this.pads[bestIdx] : undefined;
      this.rigPadHeight = pad ? pad.pos.y : pos.y;
      this.rigActive = true;
      this.cameraRig.handoff('onfoot');
    }
    this.applyCharacterTransform(pos);
  }

  /**
   * TASK-32: per-frame drive from the local CharacterPredictor — moves the
   * model to the predicted feet position with the predicted facing (the
   * physics yaw; the camera keeps its own mouse-owned look). `livery` (the
   * player's ship livery) re-tints the model when it changes.
   */
  setCharacterTransform(
    pos: Vec3,
    quat?: { x: number; y: number; z: number; w: number },
    livery?: Livery | null,
  ): void {
    this.applyCharacterTransform(pos);
    if (quat) this.characterMesh?.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    if (livery !== undefined) this.setCharacterLivery(livery);
  }

  /** The pad plane height under the character (the predictor's terrain). */
  get characterPadHeight(): number {
    return this.rigPadHeight;
  }

  /** One character model placement: the group's origin is the FEET. */
  private applyCharacterTransform(pos: Vec3): void {
    if (!this.characterMesh) return;
    // The rig's steady-state on-foot pose tracks THIS position (4 m back,
    // 1.6 m up) — feed it every update so the camera follows the character,
    // not the rig's stale origin.
    this.cameraRig.setCharacterPosition(pos);
    this.characterMesh.position.set(pos.x, pos.y, pos.z);
  }

  /** Livery tint (cosmetic tie-in, TASK-32): body = hull, head = accent. */
  private setCharacterLivery(livery: Livery | null): void {
    if (!this.characterMats) return;
    const body = livery?.hull ?? DEFAULT_CHARACTER_BODY;
    const head = livery?.accent ?? DEFAULT_CHARACTER_HEAD;
    if (
      this.characterLivery &&
      this.characterLivery.body === body &&
      this.characterLivery.head === head
    ) {
      return; // unchanged — no material churn
    }
    this.characterLivery = { body, head };
    this.characterMats.body.color.set(body);
    this.characterMats.head.color.set(head);
  }

  /**
   * TASK-31: the player is back in a ship (warp / re-entry in TASK-35 /
   * snapshot reset). Removes the capsule and hands the camera back to its
   * pre-disembark pose (the manager's spectator vantage) so a system swap
   * never inherits an on-foot camera.
   */
  clearCharacter(): void {
    if (this.characterMesh) {
      this.scene.remove(this.characterMesh);
      disposeGroup(this.characterMesh);
      this.characterMesh = null;
    }
    this.characterMats = null;
    this.characterLivery = null;
    if (this.rigActive) {
      this.rigActive = false;
      this.cameraRig.mode = 'cockpit'; // re-arm: the next handoff re-animates
      this.camera.position.set(150, 40, 150);
      this.camera.lookAt(0, 0, 0);
    }
  }

  /** True while the player is disembarked (character capsule rendered). */
  get isOnFoot(): boolean {
    return this.characterMesh !== null;
  }

  /**
   * Record the player ship's last-known world position (called from the
   * session's self entity_update path). Used ONLY for pad-ring visibility —
   * no physics reads it.
   */
  setShipPos(pos: Vec3): void {
    this.selfPos = pos;
  }

  /**
   * Drive the atmosphere crossfade (TASK-28.1) from ONE shared haze number:
   * the dome's haze IN and the skybox's fade OUT are both `view.haze`, so
   * they can never desync (the spec's no-desync contract). The dome is
   * repositioned over the owning planet's surface anchor and tinted by its
   * class; in space (no planet) it hides (zero cost) and the skybox is full.
   *
   * @param pos     the ship's live world position (u).
   * @param current the LIVE regime to resolve from (hysteresis anchor) — the
   *                caller passes the tracker's regime so the exit band
   *                [enter, exit) agrees with the sim's decision.
   */
  setAtmosphereView(pos: Vec3, current: Regime = 'space'): void {
    const view = atmosphereViewFor(pos, this.system, current);
    if (view.planet) {
      const anchor = planetAnchor(this.system!.planets.indexOf(view.planet));
      this.dome.mesh.position.set(anchor.x, 0, anchor.z);
      this.dome.set(
        view.haze,
        setFromHex01(this.tempColor, ATMOSPHERE_HAZE_COLORS[view.planet.class]),
      );
    } else {
      this.dome.set(0, this.tempColor);
    }
    // The no-desync contract: dome haze IN = 1 - skybox fade OUT, one number.
    const fade = 1 - view.haze;
    (this.background.sky.material as THREE.MeshBasicMaterial).opacity = fade;
    (this.background.stars.material as THREE.PointsMaterial).opacity = 0.95 * fade;
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
    if (this.characterMesh) {
      this.scene.remove(this.characterMesh);
      disposeGroup(this.characterMesh);
      this.characterMesh = null;
    }
    this.characterMats = null;
    this.pads = [];
    this.padRings = [];
    this.dome.dispose();
    this.background.dispose();
    this.renderer.dispose();
  }
}

/** Default model colors (re-tinted by the ship livery — TASK-32). */
const DEFAULT_CHARACTER_BODY = '#7dd3fc';
const DEFAULT_CHARACTER_HEAD = '#e2e8f0';

/**
 * TASK-32: the placeholder character model — a lit-free capsule body +
 * head in a group whose ORIGIN is the character's FEET (the physics pos).
 * Local +Z is forward (the physics facing quat), so the predicted quat
 * orients the model directly. Replaced by the real model in a later pass.
 */
function buildCharacterMesh(): {
  group: THREE.Group;
  body: THREE.MeshBasicMaterial;
  head: THREE.MeshBasicMaterial;
} {
  const group = new THREE.Group();
  const body = new THREE.MeshBasicMaterial({ color: DEFAULT_CHARACTER_BODY });
  const bodyMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.2, 4, 8), body);
  bodyMesh.position.y = 1.05; // capsule center: 2.1 m tall on the feet
  const head = new THREE.MeshBasicMaterial({ color: DEFAULT_CHARACTER_HEAD });
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), head);
  headMesh.position.y = 1.95; // above the capsule
  group.add(bodyMesh, headMesh);
  return { group, body, head };
}
