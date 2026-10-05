import * as THREE from 'three';

import { RemoteEntityTracker, type RemoteRenderState } from '@client/net/interpolation';
import type { EntityState, Livery } from '@shared/protocol/schemas';
import { registerEntity, unregisterEntity } from './entity-registry';
import { buildCharacterMesh } from './character-mesh';
import {
  AI_SHIP_TRIM_COLOR,
  applyShipLivery,
  createShipRender,
  disposeShipRender,
  setShipOpacity,
  SHIP_LABEL_HEIGHT_M,
  type ShipRender,
} from './remote-ships';
import { callsignForPlayer } from '@client/state/kill-feed';

/**
 * TASK-36: the remote-entity render layer — the on-foot multiplayer view.
 *
 * Remote entities ride the SAME 200 ms interpolation buffer as ships
 * (TASK-14's RemoteEntityTracker, kind-agnostic by design): every 10 Hz
 * snapshot batch is fed in (self excluded), and each frame every remote
 * entity's render state is resolved 200 ms in the past — smooth even across
 * slope changes, no extrapolation, no teleports. Rendered kinds:
 *
 * - `character`  — the SAME capsule as the local player (character-mesh.ts),
 *   livery-colored, with a screen-space DOM callsign label (≤ 16, a11y
 *   friendly, 10 m billboard fade) positioned per frame outside React;
 * - `groundItem` — a small glowing ore chunk (shared drops/pickups, TASK-34:
 *   the server already broadcasts these to every peer);
 * - `ship` / `ai-ship` — TASK-74: the TASK-21 ShipMeshBuilder silhouette at
 *   the interpolated pos/quat, livery-tinted (AI ships carry the hostile
 *   trim accent). The ship render path lives in remote-ships.ts (per-kind
 *   module pattern); this layer stays the dispatcher.
 * - `drone` — TASK-48.3: a hostile surface drone as a small rotating
 *   octahedron at the interpolated position (the server patrols/hovers them
 *   — the client never moves them locally); hull 0 (killed) hides it until
 *   its server-side respawn streams again.
 *
 * Meshes live in the per-system world group (a warp disposes them with it);
 * the DOM labels live in a host element the WorldManager appends next to the
 * canvas. Everything per-frame stays OUT of React (direct transforms on
 * divs — same discipline as the local predictor in main.tsx).
 */

/** Hard cap on live callsign labels (spec: cheap at ≤ 16). */
export const MAX_CALLSIGN_LABELS = 16;
/**
 * TASK-58: the LIVE label cap (tuned data in @shared/perf — the profile
 * bridge re-points it on a preset switch, no re-init). Defaults to
 * MAX_CALLSIGN_LABELS so standalone layers (and the unit tests) keep the
 * pre-tuning behavior.
 */
let liveLabelCap = MAX_CALLSIGN_LABELS;
/** Re-point the live label cap (SettingsBridge). */
export function setLabelCap(n: number): void {
  if (Number.isFinite(n) && n >= 0) liveLabelCap = Math.floor(n);
}
/** The live label cap (tests / dev probe). */
export function getLabelCap(): number {
  return liveLabelCap;
}
/** Full opacity up to this range (m from the camera). */
export const CALLSIGN_LABEL_FULL_M = 4;
/** Faded to zero at this range (m from the camera). */
export const CALLSIGN_LABEL_FADE_M = 10;
/** Label anchor above the feet (m — just over the 2.1 m capsule head). */
export const CALLSIGN_LABEL_HEIGHT_M = 2.4;
/** Remote meshes dim while their buffer is starving (no protocol change). */
export const STALE_OPACITY = 0.55;
export const DIMMED_OPACITY = 0.25;

/** Ore-chunk color per resource (default = iron grey). */
export const GROUND_ITEM_COLORS: Record<string, string> = {
  iron: '#9aa4b2',
  copper: '#e0906a',
  'rare-earth': '#6ee7b7',
  crystal: '#c084fc',
};
const GROUND_ITEM_DEFAULT_COLOR = '#9aa4b2';

const RENDERABLE_KINDS = new Set(['character', 'groundItem', 'ship', 'ai-ship', 'drone', 'wreck']);

/** TASK-49: the wreck's killer marker is visible within this range (m). */
export const WRECK_KILLER_MARK_M = 200;
/** TASK-49: the wreck's fire-glow flicker (0.25 ± 0.15, sin at 0.01 rad/ms). */
const WRECK_FIRE_BASE = 0.25;
const WRECK_FIRE_WIGGLE = 0.15;

export interface Projected {
  x: number;
  y: number;
  /** Camera-to-target distance (m = world units). */
  dist: number;
}

export interface LabelState {
  id: string;
  callsign: string;
  /**
   * TASK-49: the exact label text when it differs from the plain callsign
   * (wreck killer markers render '▸ <killer>' — `callsign` stays the bare
   * name for the data-attribute / dedup logic).
   */
  text?: string;
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
  dist: number;
}

/**
 * Pure: callsign-label opacity by camera distance (m) — full within
 * CALLSIGN_LABEL_FULL_M, linear fade to zero at CALLSIGN_LABEL_FADE_M.
 */
export function labelOpacity(distM: number): number {
  if (distM <= CALLSIGN_LABEL_FULL_M) return 1;
  if (distM >= CALLSIGN_LABEL_FADE_M) return 0;
  return (CALLSIGN_LABEL_FADE_M - distM) / (CALLSIGN_LABEL_FADE_M - CALLSIGN_LABEL_FULL_M);
}

/**
 * Pure: the small glowing ground-item mesh — an icosahedron ore chunk with
 * an additive halo, lit-free like the rest of the placeholder world.
 */
export function buildGroundItemMesh(resourceId?: string): {
  group: THREE.Group;
  mats: THREE.MeshBasicMaterial[];
} {
  const color = GROUND_ITEM_COLORS[resourceId ?? ''] ?? GROUND_ITEM_DEFAULT_COLOR;
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
  const chunk = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 0), mat);
  chunk.position.y = 0.3;
  const glowMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), glowMat);
  glow.position.y = 0.3;
  group.add(chunk, glow);
  return { group, mats: [mat, glowMat] };
}

interface RemoteInfo {
  kind: string;
  callsign?: string;
  livery?: Livery;
  resourceId?: string;
  /** TASK-74: the hull class — carried on every wire EntityState. */
  classId?: string;
  /** TASK-48.3: normalized hull (0..1) — a destroyed drone (hull 0) hides. */
  hull?: number;
  /** TASK-49: the killing source's id (kind 'wreck' only — the marker). */
  killerId?: string;
}

interface CharacterRender {
  group: THREE.Group;
  body: THREE.MeshBasicMaterial;
  head: THREE.MeshBasicMaterial;
  /** Last applied tint (dedup guard — no per-frame material churn). */
  tint: { body: string; head: string } | null;
}

interface GroundItemRender {
  group: THREE.Group;
  mats: THREE.MeshBasicMaterial[];
}

/** TASK-48.3: a hostile surface drone — small rotating octahedron + halo. */
interface DroneRender {
  group: THREE.Group;
  /** The octahedron body material (the spin + staleness opacity targets). */
  body: THREE.MeshBasicMaterial;
  /** The additive halo material. */
  glow: THREE.MeshBasicMaterial;
}

/** Drone body spin (rad/ms) — a slow, visible rotation, driven per frame. */
export const DRONE_SPIN_RAD_PER_MS = 0.002;

/**
 * TASK-49: a wreck impostor — the frozen ship mesh (the destroyed class
 * silhouette, no physics, never re-tinted) plus an additive fire-glow
 * sphere whose opacity flickers per frame.
 */
interface WreckRender {
  group: THREE.Group;
  ship: ShipRender;
  /** The fire-glow mesh (its material is the flicker opacity target). */
  glow: THREE.Mesh;
  /** The fire-glow material. */
  fire: THREE.MeshBasicMaterial;
}

/**
 * Pure (given nothing): the small hostile-drone mesh — a red octahedron with
 * an additive halo, lit-free like the rest of the placeholder world. Reuses
 * the AI-ship hostile trim so drones read as "hostile" at a glance.
 */
export function buildDroneMesh(): {
  group: THREE.Group;
  body: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
} {
  const group = new THREE.Group();
  const body = new THREE.MeshBasicMaterial({ color: AI_SHIP_TRIM_COLOR, transparent: true });
  const octa = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), body);
  octa.position.y = 0.4; // hover slightly above the entity origin
  const glow = new THREE.MeshBasicMaterial({
    color: AI_SHIP_TRIM_COLOR,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), glow);
  halo.position.y = 0.4;
  group.add(octa, halo);
  return { group, body, glow };
}

/** TASK-49: the wreck's killer marker text (a small '▸ A' above the wreck). */
export function wreckLabelText(killer: string): string {
  return `▸ ${killer}`;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const material = obj.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
}

/**
 * One render layer per WorldManager. Feed `addSnapshot` on every 10 Hz
 * entity batch (receive clock), `renderFrame` every rAF tick.
 */
export class RemoteEntityLayer {
  private readonly tracker = new RemoteEntityTracker();
  /** Wire facts for the RENDERABLE ids (kind / callsign / livery / class / resource). */
  private readonly infos = new Map<string, RemoteInfo>();
  private readonly characters = new Map<string, CharacterRender>();
  private readonly groundItems = new Map<string, GroundItemRender>();
  /** TASK-74: remote ships (kind 'ship' / 'ai-ship'), one ShipMesh per id. */
  private readonly ships = new Map<string, ShipRender>();
  /** TASK-48.3: hostile surface drones (kind 'drone'), one octahedron per id. */
  private readonly drones = new Map<string, DroneRender>();
  /** TASK-49: wreck impostors (kind 'wreck'), frozen ship mesh + fire glow. */
  private readonly wrecks = new Map<string, WreckRender>();
  /** The per-system world group the meshes attach to (null before the first swap). */
  private parent: THREE.Group | null = null;
  private projector: ((pos: { x: number; y: number; z: number }) => Projected | null) | null = null;
  private labelHost: HTMLElement | null = null;
  private readonly labels = new Map<string, HTMLDivElement>();

  /** Attach meshes to the current system's world group. */
  setParent(group: THREE.Group): void {
    this.parent = group;
  }

  /** World→screen projection for the labels (camera + viewport owned upstream). */
  setProjector(fn: (pos: { x: number; y: number; z: number }) => Projected | null): void {
    this.projector = fn;
  }

  /** The DOM host for the callsign labels (a canvas-sibling overlay element). */
  attach(host: HTMLElement): void {
    this.labelHost = host;
  }

  /**
   * Ingest one snapshot batch (10 Hz). Self is excluded by CALLSIGN (after
   * disembark both the frozen ship and the character carry it — the local
   * predictor owns that entity). Kinds we don't render (wrecks, drones, …)
   * are buffered by the tracker but carry no mesh.
   */
  addSnapshot(now: number, entities: EntityState[], selfCallsign: string): void {
    const remotes = entities.filter((e) => e.callsign !== selfCallsign);
    this.tracker.addSnapshot(now, remotes);
    const seen = new Set<string>();
    for (const e of remotes) {
      if (!RENDERABLE_KINDS.has(e.kind)) continue;
      seen.add(e.id);
      this.infos.set(e.id, {
        kind: e.kind,
        callsign: e.callsign,
        livery: e.livery,
        resourceId: e.resourceId,
        classId: e.classId,
        hull: e.hull,
        killerId: e.killerId,
      });
    }
    for (const id of [...this.infos.keys()]) {
      if (!seen.has(id)) this.drop(id);
    }
  }

  /**
   * Per-frame drive: resolve every remote entity's interpolated render state
   * (200 ms in the past) and move its mesh; then position the callsign
   * labels. Called from the WorldManager rAF, before the render.
   */
  renderFrame(now: number): void {
    const states = this.tracker.renderAll(now);
    for (const [id, state] of states) {
      const info = this.infos.get(id);
      if (!info) continue;
      if (info.kind === 'character') this.renderCharacter(id, info, state);
      else if (info.kind === 'groundItem') this.renderGroundItem(id, info, state);
      else if (info.kind === 'ship' || info.kind === 'ai-ship') this.renderShip(id, info, state);
      else if (info.kind === 'drone') this.renderDrone(id, info, state, now);
      else if (info.kind === 'wreck') this.renderWreck(id, info, state, now);
    }
    this.applyLabels(this.labelStates(now));
  }

  /**
   * Pure (given the projector): the label positions/opacities for the
   * current frame — nearest first, capped at MAX_CALLSIGN_LABELS. Exposed
   * for tests; renderFrame applies it to the DOM.
   *
   * TASK-74: ships carry their callsign (AI ships the AI name) through the
   * SAME overlay. A player on foot has BOTH a character and a docked ship —
   * label the ACTIVE entity: the character when one exists for the callsign,
   * else the ship. One callsign, one label, never two.
   */
  labelStates(now: number): LabelState[] {
    const states = this.tracker.renderAll(now);
    const candidates: Array<{
      id: string;
      callsign: string;
      anchor: { x: number; y: number; z: number };
      character: boolean;
      /** TASK-49: a wreck killer marker ('▸ <killer>', no callsign dedup). */
      wreck?: boolean;
    }> = [];
    for (const [id, state] of states) {
      const info = this.infos.get(id);
      if (!info) continue;
      if (info.kind === 'wreck') {
        // Wrecks carry no callsign — the marker is the killer's name
        // (presence roster; AI / drone / unknown ids fall back to raw).
        const killer = info.killerId
          ? (callsignForPlayer(info.killerId) ?? info.killerId)
          : 'wreck';
        candidates.push({
          id,
          callsign: killer,
          anchor: { x: state.pos.x, y: state.pos.y + SHIP_LABEL_HEIGHT_M, z: state.pos.z },
          character: false,
          wreck: true,
        });
        continue;
      }
      if (!info.callsign) continue;
      if (info.kind === 'character') {
        candidates.push({
          id,
          callsign: info.callsign,
          anchor: { x: state.pos.x, y: state.pos.y + CALLSIGN_LABEL_HEIGHT_M, z: state.pos.z },
          character: true,
        });
      } else if (info.kind === 'ship' || info.kind === 'ai-ship') {
        candidates.push({
          id,
          callsign: info.callsign,
          anchor: { x: state.pos.x, y: state.pos.y + SHIP_LABEL_HEIGHT_M, z: state.pos.z },
          character: false,
        });
      }
    }
    // Character wins per callsign (an on-foot player's docked ship stays unlabeled).
    // Wrecks are exempt — their 'callsign' is the KILLER's, never the victim's.
    const withCharacter = new Set(candidates.filter((c) => c.character).map((c) => c.callsign));
    const out: LabelState[] = [];
    for (const c of candidates) {
      if (!c.character && !c.wreck && withCharacter.has(c.callsign)) continue;
      const p = this.projector ? this.projector(c.anchor) : null;
      if (!p) {
        out.push({
          id: c.id,
          callsign: c.callsign,
          text: c.wreck ? wreckLabelText(c.callsign) : undefined,
          x: 0,
          y: 0,
          opacity: 0,
          visible: false,
          dist: Infinity,
        });
        continue;
      }
      // Wrecks: full opacity inside the 200 m marker range, hard off beyond
      // (and hidden entirely — a 0-opacity wreck marker is pointless).
      const opacity = c.wreck ? (p.dist <= WRECK_KILLER_MARK_M ? 1 : 0) : labelOpacity(p.dist);
      out.push({
        id: c.id,
        callsign: c.callsign,
        text: c.wreck ? wreckLabelText(c.callsign) : undefined,
        x: p.x,
        y: p.y,
        opacity,
        visible: c.wreck ? opacity > 0 : true,
        dist: p.dist,
      });
    }
    out.sort((a, b) => a.dist - b.dist);
    for (let i = liveLabelCap; i < out.length; i++) out[i].visible = false;
    return out;
  }

  /** All rendered remote entity ids (tests / debugging). */
  renderedIds(): string[] {
    return [
      ...this.characters.keys(),
      ...this.groundItems.keys(),
      ...this.ships.keys(),
      ...this.drones.keys(),
      ...this.wrecks.keys(),
    ];
  }

  /**
   * TASK-49: the rendered wreck impostors with world position (dev probe /
   * e2e — same pattern as shipProbes/droneProbes).
   */
  wreckProbes(): Array<{ id: string; pos: { x: number; y: number; z: number } }> {
    const out: Array<{ id: string; pos: { x: number; y: number; z: number } }> = [];
    for (const [id, r] of this.wrecks) {
      out.push({
        id,
        pos: { x: r.group.position.x, y: r.group.position.y, z: r.group.position.z },
      });
    }
    return out;
  }

  /**
   * TASK-48.3: the rendered drones with world position + visibility (dev
   * probe / e2e — the e2e projects `pos` against the live camera).
   */
  droneProbes(): Array<{
    id: string;
    pos: { x: number; y: number; z: number };
    visible: boolean;
  }> {
    const out: Array<{ id: string; pos: { x: number; y: number; z: number }; visible: boolean }> =
      [];
    for (const [id, r] of this.drones) {
      out.push({
        id,
        pos: { x: r.group.position.x, y: r.group.position.y, z: r.group.position.z },
        visible: r.group.visible,
      });
    }
    return out;
  }

  /**
   * TASK-74: the rendered remote ships with wire facts + world position
   * (dev probe / e2e — the e2e projects `pos` against the live camera).
   */
  shipProbes(): Array<{
    id: string;
    kind: string;
    classId: string | null;
    callsign: string | null;
    pos: { x: number; y: number; z: number };
  }> {
    const out: Array<{
      id: string;
      kind: string;
      classId: string | null;
      callsign: string | null;
      pos: { x: number; y: number; z: number };
    }> = [];
    for (const [id, r] of this.ships) {
      const info = this.infos.get(id);
      out.push({
        id,
        kind: info?.kind ?? 'ship',
        classId: r.classId,
        callsign: info?.callsign ?? null,
        pos: { x: r.group.position.x, y: r.group.position.y, z: r.group.position.z },
      });
    }
    return out;
  }

  /**
   * System boundary (warp / boot / dispose): every remote belongs to the
   * system just left — meshes, buffers and labels go. The next snapshot
   * batch rebuilds everything.
   */
  clear(): void {
    for (const id of [...this.infos.keys()]) this.drop(id);
    this.tracker.reset();
  }

  /** Tear everything down (WorldManager.dispose — the overlay element too). */
  dispose(): void {
    this.clear();
    this.parent = null;
    this.projector = null;
    this.labelHost?.remove();
    this.labelHost = null;
  }

  private renderCharacter(id: string, info: RemoteInfo, state: RemoteRenderState): void {
    let r = this.characters.get(id);
    if (!r) {
      const model = buildCharacterMesh();
      model.body.transparent = true;
      model.head.transparent = true;
      this.parent?.add(model.group);
      r = { group: model.group, body: model.body, head: model.head, tint: null };
      this.characters.set(id, r);
      registerEntity(id, 'character');
    }
    r.group.position.set(state.pos.x, state.pos.y, state.pos.z);
    r.group.quaternion.set(state.quat.x, state.quat.y, state.quat.z, state.quat.w);
    // Livery tint (dedup: the wire livery is stable, this is a no-op most frames).
    const body = info.livery?.hull ?? '';
    const head = info.livery?.accent ?? '';
    if (body && head && (!r.tint || r.tint.body !== body || r.tint.head !== head)) {
      r.body.color.set(body);
      r.head.color.set(head);
      r.tint = { body, head };
    }
    const opacity = state.dimmed ? DIMMED_OPACITY : state.stale ? STALE_OPACITY : 1;
    r.body.opacity = opacity;
    r.head.opacity = opacity;
  }

  /**
   * TASK-74: the remote ship path (ship + ai-ship). The mesh is created ONCE
   * per entity id (TASK-21 builder + livery), re-tinted in place only when
   * the wire livery changes, rebuilt only when the classId changes (a ship
   * swap), and disposed when the entity leaves — no per-frame material
   * churn. Transform + the stale/dimmed opacity rule run per frame.
   */
  private renderShip(id: string, info: RemoteInfo, state: RemoteRenderState): void {
    const classId = info.classId ?? 'scout';
    const ai = info.kind === 'ai-ship';
    let r = this.ships.get(id);
    if (!r) {
      r = createShipRender(classId, ai, info.livery);
      this.parent?.add(r.group);
      this.ships.set(id, r);
      registerEntity(id, 'ship');
    } else if (r.classId !== classId) {
      // classId changed (a ship swap): rebuild the silhouette, keep the id.
      this.parent?.remove(r.group);
      disposeShipRender(r);
      r = createShipRender(classId, ai, info.livery);
      this.parent?.add(r.group);
      this.ships.set(id, r);
    }
    r.group.position.set(state.pos.x, state.pos.y, state.pos.z);
    r.group.quaternion.set(state.quat.x, state.quat.y, state.quat.z, state.quat.w);
    applyShipLivery(r, info.livery);
    const opacity = state.dimmed ? DIMMED_OPACITY : state.stale ? STALE_OPACITY : 1;
    setShipOpacity(r, opacity);
  }

  /**
   * TASK-48.3: the hostile surface drone. The server patrols/hovers the
   * drones — the client NEVER moves them locally, it renders the streamed
   * (200 ms interpolated) position as a small rotating octahedron. A killed
   * drone streams hull 0 until its 180 s respawn — the mesh HIDES in that
   * window (no client-side timer). The spin + the stale/dimmed opacity rule
   * run per frame; the mesh is built once and disposed on leave.
   */
  private renderDrone(id: string, info: RemoteInfo, state: RemoteRenderState, now: number): void {
    let r = this.drones.get(id);
    if (!r) {
      const built = buildDroneMesh();
      this.parent?.add(built.group);
      r = built;
      this.drones.set(id, r);
      registerEntity(id, 'drone');
    }
    r.group.position.set(state.pos.x, state.pos.y, state.pos.z);
    r.group.rotation.y = now * DRONE_SPIN_RAD_PER_MS;
    // Destroyed (hull 0 on the wire) until the server-side respawn: hidden.
    r.group.visible = (info.hull ?? 1) > 0;
    const opacity = state.dimmed ? DIMMED_OPACITY : state.stale ? STALE_OPACITY : 1;
    r.body.opacity = opacity;
    r.glow.opacity = 0.3 * opacity;
  }

  /**
   * TASK-49: the wreck impostor. The server streams the wreck as an
   * ordinary (static) entity — this client renders a FROZEN copy of the
   * destroyed ship's silhouette (created once from the wire classId, never
   * re-tinted or moved beyond the interpolated transform) plus an additive
   * fire-glow sphere with a slow opacity flicker. The killer marker label
   * ('▸ <killer>', ≤ 200 m) rides the callsign overlay. No collision, no
   * loot (v1).
   */
  private renderWreck(id: string, info: RemoteInfo, state: RemoteRenderState, now: number): void {
    const classId = info.classId ?? 'scout';
    let r = this.wrecks.get(id);
    if (!r) {
      const outer = new THREE.Group();
      const ship = createShipRender(classId, false, info.livery);
      outer.add(ship.group);
      const fire = new THREE.MeshBasicMaterial({
        color: '#ff7a3c',
        transparent: true,
        opacity: WRECK_FIRE_BASE,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), fire);
      outer.add(glow);
      this.parent?.add(outer);
      r = { group: outer, ship, glow, fire };
      this.wrecks.set(id, r);
      registerEntity(id, 'wreck');
    }
    r.group.position.set(state.pos.x, state.pos.y, state.pos.z);
    r.group.quaternion.set(state.quat.x, state.quat.y, state.quat.z, state.quat.w);
    // The fire flicker is cosmetic (never gates gameplay); the stale/dimmed
    // rule scales both the frozen mesh and the glow.
    const opacity = state.dimmed ? DIMMED_OPACITY : state.stale ? STALE_OPACITY : 1;
    setShipOpacity(r.ship, opacity);
    r.fire.opacity = (WRECK_FIRE_BASE + WRECK_FIRE_WIGGLE * Math.sin(now * 0.01)) * opacity;
  }

  private renderGroundItem(id: string, info: RemoteInfo, state: RemoteRenderState): void {
    let r = this.groundItems.get(id);
    if (!r) {
      r = buildGroundItemMesh(info.resourceId);
      this.parent?.add(r.group);
      this.groundItems.set(id, r);
    }
    r.group.position.set(state.pos.x, state.pos.y, state.pos.z);
    const opacity = state.dimmed ? DIMMED_OPACITY : state.stale ? STALE_OPACITY : 1;
    for (const m of r.mats)
      m.opacity = m.blending === THREE.AdditiveBlending ? 0.35 * opacity : opacity;
  }

  private applyLabels(states: LabelState[]): void {
    if (!this.labelHost) return;
    const seen = new Set<string>();
    for (const s of states) {
      let el = this.labels.get(s.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'remote-callsign';
        el.setAttribute('data-callsign', s.callsign);
        el.textContent = s.text ?? s.callsign;
        el.style.cssText =
          'position:absolute;left:0;top:0;transform:translate(-50%,-100%);' +
          'font:0.7rem ui-monospace, SFMono-Regular, Menlo, monospace;letter-spacing:0.06em;' +
          'color:#d6deeb;text-shadow:0 1px 2px #000;white-space:nowrap;pointer-events:none;';
        this.labelHost.appendChild(el);
        this.labels.set(s.id, el);
      }
      seen.add(s.id);
      el.style.display = s.visible ? 'block' : 'none';
      if (s.visible) {
        el.style.transform = `translate(-50%, -100%) translate(${s.x}px, ${s.y}px)`;
        el.style.opacity = s.opacity.toFixed(2);
      }
    }
    for (const id of [...this.labels.keys()]) {
      if (!seen.has(id)) this.disposeLabel(id);
    }
  }

  /** Mesh + label + registry entry for one id (the single removal site). */
  private drop(id: string): void {
    this.infos.delete(id);
    const c = this.characters.get(id);
    if (c) {
      this.parent?.remove(c.group);
      disposeObject(c.group);
      this.characters.delete(id);
    }
    const g = this.groundItems.get(id);
    if (g) {
      this.parent?.remove(g.group);
      disposeObject(g.group);
      this.groundItems.delete(id);
    }
    const s = this.ships.get(id);
    if (s) {
      this.parent?.remove(s.group);
      disposeShipRender(s);
      this.ships.delete(id);
    }
    const d = this.drones.get(id);
    if (d) {
      this.parent?.remove(d.group);
      disposeObject(d.group);
      this.drones.delete(id);
    }
    const w = this.wrecks.get(id);
    if (w) {
      this.parent?.remove(w.group);
      disposeShipRender(w.ship);
      w.glow.geometry.dispose();
      w.fire.dispose();
      this.wrecks.delete(id);
    }
    this.disposeLabel(id);
    unregisterEntity(id);
  }

  private disposeLabel(id: string): void {
    const el = this.labels.get(id);
    if (el) {
      el.remove();
      this.labels.delete(id);
    }
  }
}
