import * as THREE from 'three';

import { RESOURCE_CATALOG } from '@shared/resources';
import type { ResourceId } from '@shared/inventory';
import {
  DEPOSIT_ENTITY_PREFIX,
  DEPOSIT_RENDER_RANGE_M,
  type Deposit,
} from '@shared/world/deposits';

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
  /** Derived depositId, or the wire entity id for a dev-hook deposit. */
  depositId: string;
  visible: boolean;
  quantity: number;
  resourceId: ResourceId;
  pos: { x: number; y: number; z: number };
}

/**
 * A deposit the WIRE knows but the seed-derived list does not (a dev-hook
 * placement, TASK-33's /api/dev/deposit). The wire carries everything the
 * layer needs (pos, quantity, resourceId), so it renders like a seeded rock.
 */
interface ExternalDeposit {
  pos: { x: number; y: number; z: number };
  resourceId: ResourceId;
  quantity: number;
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

/**
 * Wire `resourceId` (a plain string on the wire) → catalog id, falling back
 * to iron (grey) for an unknown id.
 */
function wireResourceId(id: string | undefined, fallback: ResourceId = 'iron'): ResourceId {
  return id !== undefined && id in RESOURCE_CATALOG ? (id as ResourceId) : fallback;
}

/** The layer: one lazily-created dodecahedron per deposit in the ring. */
export class OreRockLayer {
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.DodecahedronGeometry(1.15, 0);
  private readonly rocks = new Map<
    string,
    { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial }
  >();
  private deposits: readonly Deposit[] = [];
  private derivedIds = new Set<string>();
  private quantities = new Map<string, number>();
  /** Wire-only (dev-hook) deposits, keyed by WIRE entity id. */
  private externals = new Map<string, ExternalDeposit>();
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
    this.derivedIds = new Set(deposits.map((d) => d.depositId));
    // Rocks of the previous system are gone with its world group.
    for (const rock of this.rocks.values()) {
      this.group.remove(rock.mesh);
      rock.material.dispose();
    }
    this.rocks.clear();
    // Dev-hook deposits are per-system sim state — they do not survive a swap.
    this.externals.clear();
    this.quantities.clear();
  }

  /**
   * One snapshot batch. Derived deposits (the wire id is
   * `deposit:<depositId>` — the prefix is stripped) update their remaining
   * quantity (the server streams only the 500 m ring — everything else keeps
   * its seed-derived initial amount until it enters the ring). A deposit the
   * derived list does NOT know (a dev-hook placement) is remembered with its
   * wire pos/resourceId so the layer renders it like a seeded rock.
   */
  feedQuantities(
    entities: ReadonlyArray<{
      id: string;
      kind: string;
      quantity?: number;
      pos?: { x: number; y: number; z: number };
      resourceId?: string;
    }>,
  ): void {
    for (const e of entities) {
      if (e.kind !== 'deposit' || e.quantity === undefined) continue;
      const derivedId = e.id.startsWith(DEPOSIT_ENTITY_PREFIX)
        ? e.id.slice(DEPOSIT_ENTITY_PREFIX.length)
        : e.id;
      if (this.derivedIds.has(derivedId)) {
        this.quantities.set(derivedId, e.quantity);
        continue;
      }
      const prev = this.externals.get(e.id);
      this.externals.set(e.id, {
        pos: e.pos ?? prev?.pos ?? { x: 0, y: 0, z: 0 },
        resourceId: wireResourceId(e.resourceId, prev?.resourceId),
        quantity: e.quantity,
      });
    }
  }

  /** Per-frame update: stream the 500 m ring + drive the near-depletion pulse. */
  update(playerPos: { x: number; y: number; z: number } | null, nowMs: number): void {
    if (this.deposits.length === 0 && this.externals.size === 0) return;
    const inRing = depositsInRange(this.deposits, playerPos);
    for (const deposit of this.deposits) {
      this.syncRock(
        deposit.depositId,
        deposit.pos,
        deposit.resourceId,
        this.quantities.get(deposit.depositId) ?? deposit.amount,
        inRing.has(deposit.depositId),
        nowMs,
      );
    }
    // Dev-hook deposits: same 500 m ring rule, wire-supplied pos/resource.
    for (const [id, ext] of this.externals) {
      this.syncRock(
        id,
        ext.pos,
        ext.resourceId,
        ext.quantity,
        playerPos !== null &&
          Math.hypot(ext.pos.x - playerPos.x, ext.pos.y - playerPos.y, ext.pos.z - playerPos.z) <=
            DEPOSIT_RENDER_RANGE_M,
        nowMs,
      );
    }
  }

  /** One rock's per-frame state: visibility (the 500 m ring) + the pulse. */
  private syncRock(
    id: string,
    pos: { x: number; y: number; z: number },
    resourceId: ResourceId,
    quantity: number,
    visible: boolean,
    nowMs: number,
  ): void {
    const existing = this.rocks.get(id);
    if (!visible) {
      if (existing) existing.mesh.visible = false;
      return;
    }
    const rock = this.ensureRock(id, pos, resourceId);
    rock.mesh.visible = true;
    rock.material.emissiveIntensity = oreEmissiveIntensity(quantity, nowMs);
  }

  /** Lazily create the dodecahedron ore rock (radius 1.15, +0.6 to sit on the terrain). */
  private ensureRock(
    id: string,
    pos: { x: number; y: number; z: number },
    resourceId: ResourceId,
  ): { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial } {
    let rock = this.rocks.get(id);
    if (rock) return rock;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(RESOURCE_CATALOG[resourceId].color),
      roughness: 0.85,
      metalness: 0.15,
      emissive: new THREE.Color(RESOURCE_CATALOG[resourceId].color),
      emissiveIntensity: ORE_BASE_EMISSIVE,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.set(pos.x, pos.y + 0.6, pos.z);
    this.group.add(mesh);
    rock = { mesh, material };
    this.rocks.set(id, rock);
    return rock;
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
    for (const [id, ext] of this.externals) {
      const rock = this.rocks.get(id);
      out.push({
        depositId: id,
        visible: rock?.mesh.visible ?? false,
        quantity: ext.quantity,
        resourceId: ext.resourceId,
        pos: { ...ext.pos },
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
