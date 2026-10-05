import * as THREE from 'three';

import { hash2, seedFromString } from '@shared/random';
import type { Livery } from '@shared/protocol/schemas';
import { SPAWN_GATE_POS } from '@shared/galaxy/spawn';
import { planetAnchor } from '@shared/galaxy/planets';
import type { PlanetClass, SpectralClass, SystemGen } from '@shared/galaxy/types';
import { ATMOSPHERE_BOUNDARY_M } from '@shared/physics/atmosphere';
import type { Quat, Vec3 } from '@shared/physics/vec';
import type { Regime } from '@shared/regime';
import type { EntityState } from '@shared/protocol/schemas';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { createBackground } from '@client/render/starfield';
import { PRESETS } from '@shared/settings';
import { settingsState } from '@client/a11y/reduced-motion';
import { CombatFx } from '@client/world/combat-fx';
import { depositsFor } from '@shared/world/deposits';
import { OreRockLayer, type OreRockView } from './ore-rocks';
import { RemoteEntityLayer } from './remote-entities';
import {
  buildCharacterMesh,
  DEFAULT_CHARACTER_BODY,
  DEFAULT_CHARACTER_HEAD,
} from './character-mesh';

// TASK-36: the character model lives in character-mesh.ts — imported by BOTH
// the local path (re-exported here for the transition-hitch benchmark) and
// the remote-entity layer, so local + remote players render with the SAME
// capsule (and there is no WorldManager ↔ remote-entities import cycle).
export {
  buildCharacterMesh,
  DEFAULT_CHARACTER_BODY,
  DEFAULT_CHARACTER_HEAD,
} from './character-mesh';
import {
  createAtmosphereDome,
  ATMOSPHERE_HAZE_COLORS,
  type AtmosphereDome,
} from '@client/render/atmosphere-dome';
import { frameMonitor } from '@client/perf/frameMonitor';
import { CameraRig } from '@client/camera/CameraRig';
import { atmosphereViewFor } from './atmosphere-view';
import { SelfShip, type SelfShipInput } from './self-ship';
import { buildHazardDiscs, hazardDiscVisible, type HazardDiscRender } from './hazard-discs';

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
  /**
   * TASK-48.3: the hazard discs of the current system (storm quad-spins +
   * rad-zone ground discs, derived from the SAME shared hazardsFor the
   * server uses). Per-frame: 500 m cull + spin-group rotation only.
   */
  private hazardDiscs: HazardDiscRender[] = [];
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
  /**
   * True from the first self SHIP update (TASK-72: the chase camera arms on
   * boot, not on the first disembark) until clearCharacter. While true the
   * frame loop drives the rig.
   */
  private rigActive = false;
  /**
   * TASK-72: the player's own ship (scene-level — the remote layer drops the
   * self callsign, so this is where the player's ship renders). Created on
   * the first self ship update, kept while the player is on foot (the ship
   * sits docked), disposed only on a null update / dispose().
   */
  private readonly selfShip = new SelfShip();
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
  /**
   * TASK-36 (+ TASK-74 ships): the remote-entity render layer
   * (interpolated remote characters + ships + shared ground items, the 200
   * ms TASK-14 buffer). Meshes attach to the per-system world group; the
   * callsign labels ride a DOM host attached via attachRemoteLabels.
   */
  private readonly remoteLayer = new RemoteEntityLayer();
  /**
   * TASK-37: ore rocks for the system's seeded deposits. The LIST is
   * client-derived (same seed as the server); quantities come from the
   * 10 Hz snapshot (the server streams the 500 m ring only).
   */
  private readonly oreLayer = new OreRockLayer();
  /** Scratch vector for projectToScreen (never escapes the manager). */
  private readonly projectVec = new THREE.Vector3();
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

    // TASK-55: the star count is the ACTIVE quality preset's starCount —
    // read live off the settings store (a world is (re)built per system,
    // so a preset change takes effect on the next world build — the
    // SettingsBridge's "new ones use the new params" contract).
    this.background = createBackground(
      seed,
      PRESETS[settingsState().quality].starCount,
    );
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
    this.oreLayer.attach(this.scene); // TASK-37: ore rocks live scene-level
    // TASK-72: scene lighting for the self-ship's MeshStandardMaterial paint
    // zones. Everything else in this scene (star, planets, gate, dome,
    // character capsule) is Basic/Shader-lit and ignores lights, so this
    // only ever affects the ship.
    this.scene.add(new THREE.AmbientLight('#9fb2d0', 1.4));
    const keyLight = new THREE.DirectionalLight('#ffffff', 2.4);
    keyLight.position.set(0.35, 1, 0.25); // fixed key direction (ship-facing)
    this.scene.add(keyLight);

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
      // TASK-48.3: hazard-disc culling (same 500 m rule as the pad rings)
      // + the storm quad-spin (one rotation set per visible storm cell —
      // no allocation, the quads share one geometry + material).
      for (const disc of this.hazardDiscs) {
        disc.group.visible = hazardDiscVisible(this.selfPos, disc.center);
        if (disc.spin) disc.spin.rotation.y = this.clock.getElapsedTime() * disc.spinSpeed;
      }
      // TASK-36: drive the remotes 200 ms in the past (interpolated) before
      // the render — cheap (a handful of entities, direct transforms).
      this.remoteLayer.renderFrame(nowMs);
      // TASK-37: stream the ore-rock 500 m ring + drive the near-depletion
      // pulse (same player position as the pad-ring culling above).
      this.oreLayer.update(this.selfPos, nowMs);
      // TASK-43: age the combat FX (flashes self-cull) and apply the
      // decaying 2 px screen shake as a camera nudge around the render.
      const shake = this.combatFx.frame(nowMs);
      if (shake.lengthSq() > 0) {
        this.camera.position.add(shake);
      }
      this.renderer.render(this.scene, this.camera);
      if (shake.lengthSq() > 0) {
        this.camera.position.sub(shake);
      }
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
    // TASK-48.3: hazard discs from the SAME shared hazardsFor the server's
    // exposure math uses (deterministic per system seed) — the groups live
    // in the per-system group, so they are disposed with it on the next swap.
    this.hazardDiscs = buildHazardDiscs(this.seed, system);
    for (const disc of this.hazardDiscs) next.add(disc.group);
    // TASK-37: the deposit list is derived from the SAME seed the server
    // uses (cached per system — a warm cache makes this a no-op; the first
    // cold derivation per system is the one-time ~100 ms placement pass).
    this.oreLayer.setDeposits(depositsFor(this.seed, system));
    if (this.worldGroup) {
      this.scene.remove(this.worldGroup);
      disposeGroup(this.worldGroup);
    }
    // TASK-36: remotes belong to the system just left — clear the layer and
    // re-parent its meshes into the new group (the next snapshot rebuilds).
    this.remoteLayer.clear();
    this.remoteLayer.setParent(next);
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
   * TASK-48.3: the rendered hazard discs (dev probe / e2e assertions) — wire
   * facts from the shared hazardsFor + the live world position + visibility.
   */
  hazardDiscsView(): Array<{
    hazardId: string;
    kind: 'storm' | 'radzone';
    pos: { x: number; y: number; z: number };
    radius: number;
    visible: boolean;
  }> {
    return this.hazardDiscs.map((d) => ({
      hazardId: d.placement.hazardId,
      kind: d.placement.kind,
      pos: { x: d.center.x, y: d.center.y, z: d.center.z },
      radius: d.placement.radius,
      visible: d.group.visible,
    }));
  }

  /**
   * TASK-36: feed one snapshot batch to the remote-entity layer (self
   * excluded by callsign — the local predictor owns it). Called from the
   * entity_update + snapshot paths in main.tsx.
   */
  feedRemoteEntities(entities: EntityState[], selfCallsign: string): void {
    this.remoteLayer.addSnapshot(performance.now(), entities, selfCallsign);
    // TASK-37: the same batch carries the 500 m ring's deposit quantities —
    // the client-derived rocks apply the mined-unit deltas from it.
    this.oreLayer.feedQuantities(entities);
    // TASK-43: missile tracers ride the 10 Hz snapshots (visible to every
    // client) — the FX layer creates/updates/removes them from the batch.
    this.combatFx.updateProjectiles(entities);
  }

  /**
   * TASK-43: combat FX (scene-level, survives world swaps):
   * - `addLaserFlash`: a 60 ms additive line nose→hit + a muzzle spark;
   * - `addImpactFlash`: a small expanding flash quad at the impact point;
   * - `screenShake`: a 2 px camera nudge decaying over 100 ms (cosmetic);
   * - `updateProjectiles`: the missile tracer pool (≤ 16, recycled).
   * Dev-only: `__FX__.slow = true` stretches the flash lifetimes so the e2e
   * can screenshot a flash deterministically (never ships).
   */
  get fx(): CombatFx {
    return this.combatFx;
  }

  private readonly combatFx: CombatFx = new CombatFx((scene) => {
    this.scene.add(scene);
    return this.camera;
  });

  /**
   * TASK-50: a PLAIN snapshot of the camera for the combat HUD's target
   * projection (world→NDC→screen). No THREE types leak to the UI layer;
   * the caller merges in the viewport size.
   */
  cameraSample(): {
    pos: { x: number; y: number; z: number };
    quat: { x: number; y: number; z: number; w: number };
    fovDeg: number;
  } {
    return {
      pos: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      quat: {
        x: this.camera.quaternion.x,
        y: this.camera.quaternion.y,
        z: this.camera.quaternion.z,
        w: this.camera.quaternion.w,
      },
      fovDeg: this.camera.fov,
    };
  }

  /** TASK-37: the ore rocks currently known (dev probe / e2e assertions). */
  oreRocks(): OreRockView[] {
    return this.oreLayer.views();
  }

  /**
   * TASK-74: the rendered remote ships (dev probe / e2e assertions) — wire
   * facts + world position. The e2e projects `pos` via projectToScreen.
   */
  remoteShips(): Array<{
    id: string;
    kind: string;
    classId: string | null;
    callsign: string | null;
    pos: { x: number; y: number; z: number };
  }> {
    return this.remoteLayer.shipProbes();
  }

  /**
   * TASK-48.3: the rendered hostile drones (dev probe / e2e assertions) —
   * wire id + world position + live visibility (hull 0 = hidden).
   */
  drones(): Array<{
    id: string;
    pos: { x: number; y: number; z: number };
    visible: boolean;
  }> {
    return this.remoteLayer.droneProbes();
  }

  /**
   * TASK-36: attach the callsign-label DOM overlay (a canvas-sibling element
   * sized like the viewport) + wire the world→screen projector.
   */
  attachRemoteLabels(host: HTMLElement): void {
    this.remoteLayer.attach(host);
    this.remoteLayer.setProjector((pos) => this.projectToScreen(pos));
  }

  /**
   * TASK-36: world→screen projection for a world point (CSS pixels, origin
   * top-left). Null when the point is behind the camera — the caller hides
   * the label rather than mirroring it.
   */
  projectToScreen(pos: Vec3): { x: number; y: number; dist: number } | null {
    const v = this.projectVec.set(pos.x, pos.y, pos.z);
    const dist = this.camera.position.distanceTo(v);
    v.project(this.camera);
    if (v.z > 1) return null; // behind the camera (NDC z past the far clip)
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, dist };
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
      this.scene.add(model.group);
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
   * TASK-35: the player is back in a ship — RE-ENTRY. The first call of the
   * transition (the capsule still exists) disposes the capsule and runs the
   * REVERSE handoff (onfoot → cockpit, the same 600 ms TASK-27 animation the
   * disembark played forward). The rig STAYS active in cockpit mode and
   * tracks the ship pose fed here on every 10 Hz self update — the view is
   * continuous, no cut to the spectator vantage. Later calls (ship updates)
   * only feed the pose; while the rig is inactive (never disembarked) this
   * is a no-op and the spectator camera is untouched.
   */
  reEnterShip(pos: Vec3, quat: { x: number; y: number; z: number; w: number }): void {
    if (!this.rigActive) return;
    this.cameraRig.setShip(pos, quat);
    if (this.characterMesh) {
      this.disposeCharacterMesh();
      // TASK-72: re-entry animates onfoot → CHASE (the default in-ship view),
      // not cockpit — the same 600 ms TASK-27 handoff, same rig.
      this.cameraRig.handoff('chase');
    }
  }

  /**
   * TASK-72: the player's own ship, from the self entity_update bridge.
   * First call spawns the scene-level mesh (it survives swapWorld), arms
   * the rig in 'chase' mode and primes the rig's first-frame snap (NO
   * handoff animation from the manager's boot spectator vantage). A
   * classId change (ship purchase) rebuilds the mesh; a livery change
   * re-tints it in place; position/quaternion track the 10 Hz snapshot.
   * The mesh STAYS while the player is on foot (the ship sits docked — the
   * object the character walks back to); only a `null` update or dispose()
   * removes it.
   */
  setSelfShip(state: SelfShipInput | null): void {
    const currentGroup = this.selfShip.mesh?.group ?? null;
    const result = this.selfShip.set(state);
    if (result.created || result.rebuilt) {
      this.scene.add(this.selfShip.mesh!.group); // scene-level: survives swapWorld
    } else if (result.disposed) {
      // disposeShipMesh clears the group but it stays attached — detach it.
      if (currentGroup) this.scene.remove(currentGroup);
    }
    if (!this.selfShip.mesh || !state) return;
    // The rig: the FIRST self ship update arms the chase camera; later
    // updates just feed the pose (while on foot the mode is 'onfoot' and
    // the ship pose is only used as the re-entry handoff's destination).
    this.cameraRig.setShip(state.pos, state.rot);
    if (!this.rigActive) {
      this.rigActive = true;
      this.cameraRig.mode = 'chase';
      this.cameraRig.resetPrime(); // snap on the next frame — no boot animation
    }
  }

  /**
   * TASK-73 hook: per-frame drive of the self ship mesh + chase pose
   * (client prediction will call this at 60 fps; until then the 10 Hz
   * setSelfShip updates are the only feed).
   */
  setSelfShipTransform(pos: Vec3, quat: { x: number; y: number; z: number; w: number }): void {
    this.selfShip.transform(pos, quat);
    this.cameraRig.setShip(pos, quat);
  }

  /**
   * The rendered self ship (dev probe / e2e assertions). Null until the
   * first setSelfShip.
   */
  selfShipView(): { classId: string; pos: Vec3; rot: Quat } | null {
    if (!this.selfShip.mesh) return null;
    return {
      classId: this.selfShip.mesh.classId,
      pos: this.selfShip.position()!,
      rot: this.selfShip.orientation()!,
    };
  }

  /**
   * TASK-31: full on-foot teardown (warp / boot / snapshot reset — NOT the
   * seamless re-entry, which is reEnterShip). Removes the capsule.
   * TASK-72: the chase camera is RE-ARMED for the next self ship update
   * (snap, no animation) — a warp / boot reset never snaps the camera
   * back to the (150, 40, 150) spectator vantage; the ship is where the
   * player is, so the camera stays with it.
   */
  clearCharacter(): void {
    if (this.characterMesh) {
      this.disposeCharacterMesh();
    }
    if (this.rigActive) {
      this.cameraRig.mode = 'chase';
      this.cameraRig.resetPrime(); // the next self ship update snaps onto it
    }
  }

  /** Removes + disposes the capsule model and its materials (one site). */
  private disposeCharacterMesh(): void {
    if (this.characterMesh) {
      this.scene.remove(this.characterMesh);
      disposeGroup(this.characterMesh);
      this.characterMesh = null;
    }
    this.characterMats = null;
    this.characterLivery = null;
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
    if (this.selfShip.mesh) this.scene.remove(this.selfShip.mesh.group);
    this.selfShip.dispose();
    this.disposeCharacterMesh();
    this.remoteLayer.dispose();
    this.pads = [];
    this.padRings = [];
    this.hazardDiscs = [];
    this.dome.dispose();
    this.background.dispose();
    this.renderer.dispose();
  }
}
