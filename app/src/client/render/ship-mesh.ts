import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HEX_COLOR, shipStats, type Livery, type LiverySlot } from '@shared/ships';

/**
 * ShipMeshBuilder (TASK-21). Builds a low-poly ship whose 3 paint zones —
 * hull body, accent panels, trim lines — are each driven by one shared
 * MeshStandardMaterial. `applyLivery` recolors materials in place, so a
 * livery change (local REST response or a remote entity_update) is a pure
 * color set with no geometry or material churn and no frame hitch.
 *
 * Unknown class ids fall back to the scout silhouette; unknown or partial
 * livery values fall back to the class default per slot.
 */

export interface ShipPaintZones {
  hull: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
}

export interface ShipMesh {
  classId: string;
  group: THREE.Group;
  zones: ShipPaintZones;
}

const ZONE_KEYS: LiverySlot[] = ['hull', 'accent', 'trim'];

/** One standard material per paint zone (flat-ish, slightly metallic). */
function zoneMaterial(color: string): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: 0.35,
    roughness: 0.55,
  });
  mat.name = 'ship-livery';
  return mat;
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = false;
  return m;
}

/**
 * Build the ship group for a class: hull body (fuselage + nose + cockpit),
 * accent panels (side wings), trim lines (spine strip + dorsal fin).
 */
export function buildShipMesh(classId: string): ShipMesh {
  const cls = (() => {
    try {
      return shipStats(classId);
    } catch {
      return shipStats('scout');
    }
  })();
  const defaultLivery = cls.defaultLivery;

  const zones: ShipPaintZones = {
    hull: zoneMaterial(defaultLivery.hull),
    accent: zoneMaterial(defaultLivery.accent),
    trim: zoneMaterial(defaultLivery.trim),
  };

  const group = new THREE.Group();
  group.name = `ship-${cls.id}`;

  // Hull body: fuselage, nose cone, cockpit hump.
  const hullParts = [
    mesh(new THREE.BoxGeometry(1.6, 0.8, 4.2), zones.hull),
    (() => {
      const nose = mesh(new THREE.ConeGeometry(0.8, 1.6, 4), zones.hull);
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 2.9;
      return nose;
    })(),
    (() => {
      const cockpit = mesh(new THREE.BoxGeometry(0.9, 0.5, 1.2), zones.hull);
      cockpit.position.set(0, 0.55, 0.4);
      return cockpit;
    })(),
  ];

  // Accent panels: swept side wings.
  const wingGeo = new THREE.BoxGeometry(3.2, 0.12, 1.4);
  const wingL = mesh(wingGeo, zones.accent);
  wingL.position.set(-2.3, -0.05, 0.3);
  wingL.rotation.z = 0.12;
  const wingR = mesh(wingGeo.clone(), zones.accent);
  wingR.position.set(2.3, -0.05, 0.3);
  wingR.rotation.z = -0.12;

  // Trim lines: spine strip and dorsal fin.
  const spine = mesh(new THREE.BoxGeometry(0.18, 0.1, 4.0), zones.trim);
  spine.position.y = 0.45;
  const fin = mesh(new THREE.BoxGeometry(0.1, 0.9, 0.9), zones.trim);
  fin.position.set(0, 0.7, -1.6);

  group.add(...hullParts, wingL, wingR, spine, fin);

  return { classId: cls.id, group, zones };
}

/**
 * Apply a (possibly partial) livery to a built ship: each slot uses the
 * given hex when valid, otherwise the class default. Materials and
 * geometries are never recreated.
 */
export function applyLivery(
  shipMesh: ShipMesh,
  livery: Partial<Livery> | Record<string, string> | null | undefined,
): void {
  const defaults = (() => {
    try {
      return shipStats(shipMesh.classId).defaultLivery;
    } catch {
      return shipStats('scout').defaultLivery;
    }
  })();
  for (const slot of ZONE_KEYS) {
    const value = livery?.[slot];
    const color = typeof value === 'string' && HEX_COLOR.test(value) ? value : defaults[slot];
    shipMesh.zones[slot].color.set(color);
  }
}

/** Free all geometries and materials (call when a ship entity leaves). */
export function disposeShipMesh(shipMesh: ShipMesh): void {
  shipMesh.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
    }
  });
  for (const key of ZONE_KEYS) {
    shipMesh.zones[key].dispose();
  }
  shipMesh.group.clear();
}

// ---------------------------------------------------------------------------
// TASK-58: the merged (single-draw-call) ship — 16 remote ships used to be
// 16 × 7 meshes + 16 × 3 materials (112 draw calls, 48 materials). The
// merged form bakes the class silhouette into ONE geometry whose paint
// zones live in a per-ship vertex-color buffer, lit by ONE of three shared
// state materials (normal / dimmed / stale — the stale-opacity rule moves
// from per-material opacity to material SELECTION). A livery change
// rewrites the color buffer in place; a ship swap swaps the geometry.
// ---------------------------------------------------------------------------

/** The stale/dimmed opacity states (the remote-entity layer's rules). */
export type ShipStateKey = 'normal' | 'dimmed' | 'stale';

let stateMaterials: Record<ShipStateKey, THREE.MeshStandardMaterial> | null = null;

/**
 * The shared state materials (lazily created, NEVER disposed — they outlive
 * every world swap: module-level like the FX pools). vertexColors on: the
 * livery rides the per-ship color buffer, the material stays shared.
 */
export function shipStateMaterial(key: ShipStateKey): THREE.MeshStandardMaterial {
  if (!stateMaterials) {
    const make = (opacity: number) =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.35,
        roughness: 0.55,
        transparent: true,
        opacity,
      });
    stateMaterials = { normal: make(1), dimmed: make(0.25), stale: make(0.55) };
  }
  return stateMaterials[key];
}

/** One painted part of the class silhouette (baked transform + zone). */
interface PartDef {
  geometry: THREE.BufferGeometry;
  zone: LiverySlot;
  /** Baked world transform (position + rotation of the part). */
  matrix: THREE.Matrix4;
}

/** The class silhouette as baked parts — the SAME layout buildShipMesh builds. */
function silhouetteParts(): PartDef[] {
  const part = (
    src: THREE.BufferGeometry,
    zone: LiverySlot,
    x = 0,
    y = 0,
    z = 0,
    rotX = 0,
    rotZ = 0,
  ): PartDef => {
    const m = new THREE.Matrix4()
      .makeTranslation(x, y, z)
      .multiply(
        new THREE.Matrix4().makeRotationX(rotX).multiply(new THREE.Matrix4().makeRotationZ(rotZ)),
      );
    const geometry = src.clone().applyMatrix4(m);
    src.dispose(); // the clone owns its data now
    return { geometry, zone, matrix: m };
  };

  const parts: PartDef[] = [
    // Hull body: fuselage, nose cone, cockpit hump.
    part(new THREE.BoxGeometry(1.6, 0.8, 4.2), 'hull'),
    part(new THREE.ConeGeometry(0.8, 1.6, 4), 'hull', 0, 0, 2.9, Math.PI / 2),
    part(new THREE.BoxGeometry(0.9, 0.5, 1.2), 'hull', 0, 0.55, 0.4),
    // Accent panels: swept side wings.
    part(new THREE.BoxGeometry(3.2, 0.12, 1.4), 'accent', -2.3, -0.05, 0.3, 0, 0.12),
    part(new THREE.BoxGeometry(3.2, 0.12, 1.4), 'accent', 2.3, -0.05, 0.3, 0, -0.12),
    // Trim lines: spine strip and dorsal fin.
    part(new THREE.BoxGeometry(0.18, 0.1, 4.0), 'trim', 0, 0.45, 0),
    part(new THREE.BoxGeometry(0.1, 0.9, 0.9), 'trim', 0, 0.7, -1.6),
  ];
  return parts;
}

interface MergedLayout {
  /** The merged geometry of the class silhouette (no color attribute). */
  base: THREE.BufferGeometry;
  /** Per-part vertex ranges (color buffer offsets) in the merged layout. */
  parts: Array<{ start: number; count: number; zone: LiverySlot }>;
}

const mergedLayouts = new Map<string, MergedLayout>();

/** The merged per-class layout (cached — built once per class id). */
export function mergedLayout(classId: string): MergedLayout {
  let layout = mergedLayouts.get(classId);
  if (layout) return layout;
  const parts = silhouetteParts();
  const colored = parts.map((p) => {
    const g = p.geometry.clone();
    const count = g.getAttribute('position')!.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    return g;
  });
  const base = mergeGeometries(colored, false)!;
  for (const g of colored) g.dispose();
  for (const p of parts) p.geometry.dispose();
  let start = 0;
  const ranges = parts.map((p) => {
    const count = p.geometry.getAttribute('position')!.count;
    const range = { start, count, zone: p.zone };
    start += count;
    return range;
  });
  layout = { base, parts: ranges };
  mergedLayouts.set(classId, layout);
  return layout;
}

export interface MergedShipMesh {
  classId: string;
  group: THREE.Group;
  /** The single merged mesh (the class silhouette, ONE draw call). */
  mesh: THREE.Mesh;
  /** The per-ship geometry (own vertex-color buffer — never shared). */
  geometry: THREE.BufferGeometry;
}

/**
 * Build the merged ship for a class: a full clone of the class layout
 * (position/normal/uv are data — the clone owns them, so disposing the
 * ship's geometry never touches the shared class layout) + a fresh
 * vertex-color buffer. The mesh uses the 'normal' state material.
 */
export function buildMergedShip(classId: string): MergedShipMesh {
  const layout = mergedLayout(classId);
  const geometry = layout.base.clone();
  const mesh = new THREE.Mesh(geometry, shipStateMaterial('normal'));
  const group = new THREE.Group();
  group.name = `ship-${classId}`;
  group.add(mesh);
  return { classId, group, mesh, geometry };
}

/**
 * Rewrite the livery into the merged ship's color buffer in place (no
 * geometry or material churn — the AC-3 "shared material + per-ship color"
 * path). `ai` forces the hostile trim (TASK-74 rule).
 */
export function recolorMerged(
  ship: MergedShipMesh,
  livery: Partial<Livery> | Record<string, string> | null | undefined,
  ai = false,
): void {
  const layout = mergedLayout(ship.classId);
  const defaults = (() => {
    try {
      return shipStats(ship.classId).defaultLivery;
    } catch {
      return shipStats('scout').defaultLivery;
    }
  })();
  const colors: Record<LiverySlot, THREE.Color> = {
    hull: new THREE.Color(liveryLiveryColor(livery, 'hull', defaults.hull)),
    accent: new THREE.Color(liveryLiveryColor(livery, 'accent', defaults.accent)),
    trim: new THREE.Color(ai ? AI_TRIM_FALLBACK : liveryLiveryColor(livery, 'trim', defaults.trim)),
  };
  const attr = ship.geometry.getAttribute('color') as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  for (const range of layout.parts) {
    const c = colors[range.zone];
    for (let i = 0; i < range.count; i++) {
      const o = (range.start + i) * 3;
      arr[o] = c.r;
      arr[o + 1] = c.g;
      arr[o + 2] = c.b;
    }
  }
  attr.needsUpdate = true;
}

/** The AI hostile trim (mirrors remote-ships' AI_SHIP_TRIM_COLOR). */
const AI_TRIM_FALLBACK = '#e5484d';

/** One livery slot: the wire hex when valid, else the class default. */
function liveryLiveryColor(
  livery: Partial<Livery> | Record<string, string> | null | undefined,
  slot: LiverySlot,
  fallback: string,
): string {
  const value = livery?.[slot];
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

/** Pick the shared state material for a ship's staleness opacity. */
export function stateKeyForOpacity(opacity: number): ShipStateKey {
  if (opacity <= 0.3) return 'dimmed';
  if (opacity < 1) return 'stale';
  return 'normal';
}
