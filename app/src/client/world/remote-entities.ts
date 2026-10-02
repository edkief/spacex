import * as THREE from 'three';

import { RemoteEntityTracker, type RemoteRenderState } from '@client/net/interpolation';
import type { EntityState, Livery } from '@shared/protocol/schemas';
import { registerEntity, unregisterEntity } from './entity-registry';
import { buildCharacterMesh } from './character-mesh';

/**
 * TASK-36: the remote-entity render layer — the on-foot multiplayer view.
 *
 * Remote characters ride the SAME 200 ms interpolation buffer as ships
 * (TASK-14's RemoteEntityTracker, kind-agnostic by design): every 10 Hz
 * snapshot batch is fed in (self excluded), and each frame every remote
 * entity's render state is resolved 200 ms in the past — smooth even across
 * slope changes, no extrapolation, no teleports. Rendered kinds:
 *
 * - `character`  — the SAME capsule as the local player (character-mesh.ts),
 *   livery-colored, with a screen-space DOM callsign label (≤ 16, a11y
 *   friendly, 10 m billboard fade) positioned per frame outside React;
 * - `groundItem` — a small glowing ore chunk (shared drops/pickups, TASK-34:
 *   the server already broadcasts these to every peer).
 *
 * Meshes live in the per-system world group (a warp disposes them with it);
 * the DOM labels live in a host element the WorldManager appends next to the
 * canvas. Everything per-frame stays OUT of React (direct transforms on
 * divs — same discipline as the local predictor in main.tsx).
 */

/** Hard cap on live callsign labels (spec: cheap at ≤ 16). */
export const MAX_CALLSIGN_LABELS = 16;
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

const RENDERABLE_KINDS = new Set(['character', 'groundItem']);

export interface Projected {
  x: number;
  y: number;
  /** Camera-to-target distance (m = world units). */
  dist: number;
}

export interface LabelState {
  id: string;
  callsign: string;
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
  /** Wire facts for the RENDERABLE ids (kind / callsign / livery / resource). */
  private readonly infos = new Map<string, RemoteInfo>();
  private readonly characters = new Map<string, CharacterRender>();
  private readonly groundItems = new Map<string, GroundItemRender>();
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
   * predictor owns that entity). Kinds we don't render are buffered by the
   * tracker but carry no mesh (ships render in their own later task).
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
    }
    this.applyLabels(this.labelStates(now));
  }

  /**
   * Pure (given the projector): the label positions/opacities for the
   * current frame — nearest first, capped at MAX_CALLSIGN_LABELS. Exposed
   * for tests; renderFrame applies it to the DOM.
   */
  labelStates(now: number): LabelState[] {
    const states = this.tracker.renderAll(now);
    const out: LabelState[] = [];
    for (const [id, state] of states) {
      const info = this.infos.get(id);
      if (!info || info.kind !== 'character' || !info.callsign) continue;
      const headPos = {
        x: state.pos.x,
        y: state.pos.y + CALLSIGN_LABEL_HEIGHT_M,
        z: state.pos.z,
      };
      const p = this.projector ? this.projector(headPos) : null;
      if (!p) {
        out.push({ id, callsign: info.callsign, x: 0, y: 0, opacity: 0, visible: false, dist: Infinity });
        continue;
      }
      out.push({
        id,
        callsign: info.callsign,
        x: p.x,
        y: p.y,
        opacity: labelOpacity(p.dist),
        visible: true,
        dist: p.dist,
      });
    }
    out.sort((a, b) => a.dist - b.dist);
    for (let i = MAX_CALLSIGN_LABELS; i < out.length; i++) out[i].visible = false;
    return out;
  }

  /** All rendered remote entity ids (tests / debugging). */
  renderedIds(): string[] {
    return [...this.characters.keys(), ...this.groundItems.keys()];
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

  private renderGroundItem(id: string, info: RemoteInfo, state: RemoteRenderState): void {
    let r = this.groundItems.get(id);
    if (!r) {
      r = buildGroundItemMesh(info.resourceId);
      this.parent?.add(r.group);
      this.groundItems.set(id, r);
    }
    r.group.position.set(state.pos.x, state.pos.y, state.pos.z);
    const opacity = state.dimmed ? DIMMED_OPACITY : state.stale ? STALE_OPACITY : 1;
    for (const m of r.mats) m.opacity = m.blending === THREE.AdditiveBlending ? 0.35 * opacity : opacity;
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
        el.textContent = s.callsign;
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
