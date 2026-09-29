import * as THREE from 'three';
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
export function applyLivery(shipMesh: ShipMesh, livery: Partial<Livery> | null | undefined): void {
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
