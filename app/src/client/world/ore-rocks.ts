import * as THREE from 'three';

import { RESOURCE_CATALOG } from '@shared/resources';
import type { ResourceId } from '@shared/inventory';
import { DEPOSIT_RENDER_RANGE_M, type Deposit } from '@shared/world/deposits';

/**
 * Ore-rock rendering (TASK-37 step 3) — the client's view of the system's
 * seeded deposits.
 *
 * The deposit LIST is derived client-side from the same seed the server
 * uses (depositsFor — identical on both sides), so no wire data is needed
 * for positions; the 10 Hz entity snapshots carry only the QUANTITY DELTAS
 * (mined units) of the deposits inside the player's 500 m streaming ring
 * (the server filters the same way — snapshots stay lean).
 *
 * Rendering rules (AC):
 * - within 500 m of the player: a low-poly dodecahedron ore rock, colored
 *   per resource (iron grey / copper orange / rare-earth blue / crystal
 *   violet — the shared catalog is the one source);
 * - beyond 500 m: NOT rendered (the mesh exists but is invisible — streamed
 *   with the entity system, not terrain chunks);
 * - < 10 units remaining: a subtle emissive pulse (the deposit is nearly
 *   gone — visible to every player in the ring).
 */

/** Remaining units under which the ore rock pulses (AC: < 10). */
export const ORE_PULSE_THRESHOLD = 10;
/** Rest emissive glow (subtle — the rock is a surface object, not a beacon). */
const ORE_BASE_EMISSIVE = 0.12;
/** Pulse amplitude on top of the base glow (sin wave, ~1.1 Hz). */
const ORE_PULSE_AMPLITUDE = 0.35;

/** One rendered ore rock (dev/e2e probe shape — window.__DEPOSITS__). */
export interface OreRockView {
  depositId: string;
  visible: boolean;
  quantity: number;
  resourceId: ResourceId;
  pos: { x: number; y: number; z: number };
}

/**
 * Emissive intensity for a rock: the subtle base glow, plus a sine pulse
 * while the remaining quantity is under ORE_PULSE_THRESHOLD. Pure (no
 * three.js) so the contract is unit-testable without a GL context.
 */
export function oreEmissiveIntensity(quantity: number, nowMs: number): number {
  if (quantity >= ORE_PULSE_THRESHOLD) return ORE_BASE_EMISSIVE;
  return ORE_BASE_EMISSIVE + ORE_PULSE_AMPLITUDE * (1 + Math.sin(nowMs / 1.1)) * 0.5;
}

/**
 * The deposits inside the streaming ring of a player position (3D distance,
 * same number the server's snapshot filter uses). Pure.
 */
export function depositsInRange(
  deposits: readonly Deposit[],
  playerPos: { x: number; y: number; z: number } | null,
  rangeM: number = DEPOSIT_RENDER_RANGE_M,
): ReadonlySet<string> {
  const out = new Set<string>();
  if (!playerPos) return out;
  for (const d of deposits) {
    const dist = Math.hypot(d.pos.x - playerPos.x, d.pos.y - playerPos.y, d.pos.z - playerPos.z);
    if (dist <= rangeM) out.add(d.depositId);
  }
  return out;
}

/** The layer: one lazily-created dodecahedron per deposit in the ring. */
export class OreRockLayer {
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.DodecahedronGeometry(1.15, 0);
  private readonly rocks = new Map<string, { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial }>();
  private deposits: readonly Deposit[] = [];
  private quantities = new Map<string, number>();
  private parent: THREE.Object3D | null = null;

  /** Add the layer to a scene (scene level — it is re-parented per system). */
  attach(parent: THREE.Object3D): void {
    if (this.parent === parent) return;
    this.parent?.remove(this.group);
    parent.add(this.group);
    this.parent = parent;
  }

  /** The current system's derived deposit list (the same seed as the server). */
  setDeposits(deposits: readonly Deposit[]): void {
    this.deposits = deposits;
    // Rocks of the previous system are gone with its world group.
    for (const rock of this.rocks.values()) {
      this.group.remove(rock.mesh);
      rock.material.dispose();
    }
    this.rocks.clear();
  }

  /**
   * One snapshot batch: remember the quantity of every deposit entity it
   * carries (the server streams only the 500 m ring — everything else keeps
   * its seed-derived initial amount until it enters the ring).
   */
  feedQuantities(entities: ReadonlyArray<{ id: string; kind: string; quantity?: number }>): void {
    for (const e of entities) {
      if (e.kind !== 'deposit' || e.quantity === undefined) continue;
      this.quantities.set(e.id, e.quantity);
    }
  }

  /** Per-frame update: stream the 500 m ring + drive the near-depletion pulse. */
  update(playerPos: { x: number; y: number; z: number } | null, nowMs: number): void {
    if (this.deposits.length === 0) return;
    const inRing = depositsInRange(this.deposits, playerPos);
    for (const deposit of this.deposits) {
      const visible = inRing.has(deposit.depositId);
      let rock = this.rocks.get(deposit.depositId);
      if (!visible) {
        if (rock) rock.mesh.visible = false;
        continue;
      }
      if (!rock) {
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(RESOURCE_CATALOG[deposit.resourceId].color),
          roughness: 0.85,
          metalness: 0.15,
          emissive: new THREE.Color(RESOURCE_CATALOG[deposit.resourceId].color),
          emissiveIntensity: ORE_BASE_EMISSIVE,
        });
        const mesh = new THREE.Mesh(this.geometry, material);
        mesh.position.set(deposit.pos.x, deposit.pos.y + 0.6, deposit.pos.z);
        this.group.add(mesh);
        rock = { mesh, material };
        this.rocks.set(deposit.depositId, rock);
      }
      rock.mesh.visible = true;
      const quantity = this.quantities.get(deposit.depositId) ?? deposit.amount;
      rock.material.emissiveIntensity = oreEmissiveIntensity(quantity, nowMs);
    }
  }

  /** Rendered rocks (dev probe + e2e assertions). */
  views(): OreRockView[] {
    const out: OreRockView[] = [];
    for (const deposit of this.deposits) {
      const rock = this.rocks.get(deposit.depositId);
      out.push({
        depositId: deposit.depositId,
        visible: rock?.mesh.visible ?? false,
        quantity: this.quantities.get(deposit.depositId) ?? deposit.amount,
        resourceId: deposit.resourceId,
        pos: { ...deposit.pos },
      });
    }
    return out;
  }

  dispose(): void {
    this.parent?.remove(this.group);
    this.parent = null;
    for (const rock of this.rocks.values()) rock.material.dispose();
    this.rocks.clear();
    this.geometry.dispose();
  }
}
