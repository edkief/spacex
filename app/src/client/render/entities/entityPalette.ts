/**
 * Shared material palette for remote entity meshes — TASK-75.
 *
 * Every primitive kind (wreck / deposit / terminal / ground item /
 * missile / drone) draws from this module so a 16-player system
 * shares one `MeshStandardMaterial` per colour instead of
 * allocating 16 identical materials. Ship kinds are the exception:
 * they pull their three paint zones from the caller's
 * `ShipPaintRegistry` (see `entityMeshFactory.ts`).
 *
 * **DO NOT** add `Math.random` or `Date.now` here — the
 * determinism spec forbids it and the pool relies on identical
 * materials across rebuilds.
 */
import { Color, MeshBasicMaterial, MeshStandardMaterial } from "three";

/** `userData` key stamped on every shared material. */
export const SHARED_MATERIAL_KEY = "driftSharedMaterial";

/**
 * One shared material per palette slot. Built lazily on first
 * access so importing this module in a unit test does not
 * construct GPU-backed objects before the renderer exists.
 */
export type PaletteSlot =
  | "hullDark"
  | "rock"
  | "ore"
  | "terminalShell"
  | "terminalScreen"
  | "item"
  | "missileBody"
  | "missileTip"
  | "drone";

interface MaterialSpec {
  readonly color: number;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
  readonly roughness?: number;
  readonly metalness?: number;
  readonly flatShading?: boolean;
  readonly unlit?: boolean;
}

const SPECS: Readonly<Record<PaletteSlot, MaterialSpec>> = Object.freeze({
  hullDark: { color: 0x2f3640, roughness: 0.95, flatShading: true },
  rock: { color: 0x4a4a52, roughness: 1, flatShading: true },
  ore: { color: 0x8a5a2b, roughness: 0.9, flatShading: true },
  terminalShell: { color: 0x37474f, roughness: 0.6, metalness: 0.35 },
  terminalScreen: { color: 0x102027, emissive: 0x26c6da, emissiveIntensity: 1.4 },
  item: { color: 0xd4a017, emissive: 0x6b4a00, emissiveIntensity: 0.6, roughness: 0.5 },
  missileBody: { color: 0xb0bec5, roughness: 0.4, metalness: 0.6 },
  missileTip: { color: 0xffffff, emissive: 0xff7043, emissiveIntensity: 2.2 },
  drone: { color: 0xd32f2f, emissive: 0x7f0000, emissiveIntensity: 1.1, flatShading: true },
});

const cache = new Map<PaletteSlot, MeshStandardMaterial | MeshBasicMaterial>();

/**
 * Resolve (and memoise) the shared material for a palette slot.
 * Every mesh built from the same slot shares one instance, so
 * `disposeEntityMesh` only has to release geometry.
 */
export function sharedMaterial(slot: PaletteSlot): MeshStandardMaterial | MeshBasicMaterial {
  const hit = cache.get(slot);
  if (hit !== undefined) return hit;
  const spec = SPECS[slot];
  const mat: MeshStandardMaterial | MeshBasicMaterial =
    spec.unlit === true
      ? new MeshBasicMaterial({ color: new Color(spec.color) })
      : new MeshStandardMaterial({
          color: new Color(spec.color),
          roughness: spec.roughness ?? 0.7,
          metalness: spec.metalness ?? 0.1,
          flatShading: spec.flatShading ?? false,
        });
  if (spec.emissive !== undefined && mat instanceof MeshStandardMaterial) {
    mat.emissive = new Color(spec.emissive);
    mat.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }
  mat.userData[SHARED_MATERIAL_KEY] = true;
  cache.set(slot, mat);
  return mat;
}

/** Number of materials currently memoised (unit-test seam). */
export function sharedMaterialCount(): number {
  return cache.size;
}
