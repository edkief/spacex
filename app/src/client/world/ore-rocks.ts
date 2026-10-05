import * as THREE from 'three';

import { RESOURCE_CATALOG } from '@shared/resources';
import type { ResourceId } from '@shared/inventory';
import { PERF_PROFILES } from '@shared/perf';
import {
  DEPOSIT_ENTITY_PREFIX,
  DEPOSIT_RENDER_RANGE_M,
  type Deposit,
} from '@shared/world/deposits';

/**
 * Ore-rock rendering (TASK-37 step 3, TASK-58 instanced) — the client's view
 * of the system's seeded deposits.
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
 *
 * TASK-58: the TUNED path (default) renders each resource with one
 * InstancedMesh (batch size from @shared/perf — 30 rocks = ≤ 8 draw calls
 * and 8 materials instead of 30 rocks + 30 materials). The near-depletion
 * pulse is a SECOND bucket per resource sharing one pulsing material. The
 * legacy per-rock path (`instanced: false`) stays for the benchmark's
 * pre-tuning baseline.
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

export interface OreRockLayerOptions {
  /**
   * TASK-58 tuned path (default): per-resource InstancedMesh batches.
   * `false` = the legacy per-rock mesh (the benchmark's pre-tuning baseline).
   */
  instanced?: boolean;
  /** Instances per batch before the layer rolls over to a second mesh. */
  batchSize?: number;
}

interface Bucket {
  /** The InstancedMeshes of this (resource, pulse) bucket, batch-ordered. */
  meshes: THREE.InstancedMesh[];
  /** The rock ids assigned this frame (reused buffer — no per-frame alloc). */
  ids: string[];
  /** The shared material of the bucket (the pulse intensity target). */
  material: THREE.MeshStandardMaterial;
}

/** The layer: instanced per-resource batches (tuned) or one mesh per rock. */
export class OreRockLayer {
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.DodecahedronGeometry(1.15, 0);
  private readonly instanced: boolean;
  private readonly batchSize: number;
  private readonly legacyRocks = new Map<
    string,
    { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial }
  >();
  private readonly legacyMaterials = new Map<string, THREE.MeshStandardMaterial>();
  /** Instanced buckets, keyed `${resourceId}|pulse` (pulse = 0/1). */
  private readonly buckets = new Map<string, Bucket>();
  private deposits: readonly Deposit[] = [];
  private derivedIds = new Set<string>();
  private quantities = new Map<string, number>();
  /** Wire-only (dev-hook) deposits, keyed by WIRE entity id. */
  private externals = new Map<string, ExternalDeposit>();
  /** Every rock id and its current visibility (views() + the instanced fill). */
  private readonly rockState = new Map<
    string,
    { pos: { x: number; y: number; z: number }; resourceId: ResourceId; visible: boolean }
  >();
  private parent: THREE.Object3D | null = null;
  private readonly tempMatrix = new THREE.Matrix4();

  constructor(options: OreRockLayerOptions = {}) {
    this.instanced = options.instanced ?? true;
    this.batchSize = options.batchSize ?? PERF_PROFILES.high.instanceBatches.depositsPerResource;
  }

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
    for (const rock of this.legacyRocks.values()) {
      this.group.remove(rock.mesh);
    }
    this.legacyRocks.clear();
    for (const m of this.legacyMaterials.values()) m.dispose();
    this.legacyMaterials.clear();
    for (const b of this.buckets.values()) {
      for (const mesh of b.meshes) this.group.remove(mesh);
      b.material.dispose();
    }
    this.buckets.clear();
    this.rockState.clear();
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
      const quantity = this.quantities.get(deposit.depositId) ?? deposit.amount;
      this.syncRock(
        deposit.depositId,
        deposit.pos,
        deposit.resourceId,
        quantity,
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
    if (this.instanced) this.fillInstanced(nowMs);
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
    if (this.instanced) {
      // Record the rock state; the buckets are filled in one pass below.
      let state = this.rockState.get(id);
      if (!state) {
        state = { pos: { ...pos }, resourceId, visible: false };
        this.rockState.set(id, state);
      }
      state.visible = visible && quantity > 0;
      return;
    }
    const existing = this.legacyRocks.get(id);
    if (!visible) {
      if (existing) existing.mesh.visible = false;
      return;
    }
    const rock = this.ensureLegacyRock(id, pos, resourceId);
    rock.mesh.visible = true;
    rock.material.emissiveIntensity = oreEmissiveIntensity(quantity, nowMs);
  }

  /**
   * Instanced fill (once per frame, called by syncRock via `update`'s tail):
   * group the visible rocks into (resource, pulse) buckets and write the
   * instance matrices. Called at the end of `update` in instanced mode.
   */
  private fillInstanced(nowMs: number): void {
    for (const b of this.buckets.values()) b.ids.length = 0;
    for (const [id, state] of this.rockState) {
      if (!state.visible) continue;
      const quantity = this.quantities.get(id) ?? this.quantityOf(id);
      const pulsing = quantity < ORE_PULSE_THRESHOLD;
      const key = `${state.resourceId}|${pulsing ? 1 : 0}`;
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = this.createBucket(state.resourceId, pulsing);
        this.buckets.set(key, bucket);
      }
      bucket.ids.push(id);
    }
    for (const bucket of this.buckets.values()) {
      // Grow the batch list when the ring outgrows the capacity (the AC
      // "roll over to a second mesh of the same material" rule).
      while (bucket.ids.length > bucket.meshes.length * this.batchSize) {
        const mesh = new THREE.InstancedMesh(this.geometry, bucket.material, this.batchSize);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        bucket.meshes.push(mesh);
      }
      let i = 0;
      for (const mesh of bucket.meshes) {
        const start = i;
        const end = Math.min(start + this.batchSize, bucket.ids.length);
        for (let k = start; k < end; k++) {
          const state = this.rockState.get(bucket.ids[k])!;
          this.tempMatrix.makeTranslation(state.pos.x, state.pos.y + 0.6, state.pos.z);
          mesh.setMatrixAt(k - start, this.tempMatrix);
        }
        mesh.count = end - start;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = mesh.count > 0;
        i = end;
        if (i >= bucket.ids.length) {
          // Hide the overflow batches (shrinking ring).
          for (const m of bucket.meshes.slice(bucket.meshes.indexOf(mesh) + 1)) {
            m.count = 0;
            m.visible = false;
          }
          break;
        }
      }
      if (bucket.ids.length === 0) {
        for (const m of bucket.meshes) {
          m.count = 0;
          m.visible = false;
        }
      }
    }
    // The near-depletion pulse (all pulsing rocks share the material): drive
    // the shared pulse materials' emissive from the current clock.
    for (const [key, bucket] of this.buckets) {
      if (key.endsWith('|1')) bucket.material.emissiveIntensity = oreEmissiveIntensity(9, nowMs);
    }
  }

  /** The quantity recorded for a rock (derived seed amount when unseen). */
  private quantityOf(id: string): number {
    const derived = this.deposits.find((d) => d.depositId === id);
    if (derived) return this.quantities.get(id) ?? derived.amount;
    return this.externals.get(id)?.quantity ?? 0;
  }

  /** Create (or grow) one (resource, pulse) bucket with shared materials. */
  private createBucket(resourceId: ResourceId, pulsing: boolean): Bucket {
    const color = new THREE.Color(RESOURCE_CATALOG[resourceId].color);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      metalness: 0.15,
      emissive: color,
      emissiveIntensity: pulsing ? ORE_BASE_EMISSIVE : ORE_BASE_EMISSIVE,
    });
    const mesh = new THREE.InstancedMesh(this.geometry, material, this.batchSize);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // the batched bounds cover the whole ring
    this.group.add(mesh);
    return { meshes: [mesh], ids: [], material };
  }

  /** Lazily create the dodecahedron ore rock (radius 1.15, +0.6 to sit on the terrain). */
  private ensureLegacyRock(
    id: string,
    pos: { x: number; y: number; z: number },
    resourceId: ResourceId,
  ): { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial } {
    let rock = this.legacyRocks.get(id);
    if (rock) return rock;
    let material = this.legacyMaterials.get(resourceId);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(RESOURCE_CATALOG[resourceId].color),
        roughness: 0.85,
        metalness: 0.15,
        emissive: new THREE.Color(RESOURCE_CATALOG[resourceId].color),
        emissiveIntensity: ORE_BASE_EMISSIVE,
      });
      this.legacyMaterials.set(resourceId, material);
    }
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.set(pos.x, pos.y + 0.6, pos.z);
    this.group.add(mesh);
    rock = { mesh, material };
    this.legacyRocks.set(id, rock);
    return rock;
  }

  /** Rendered rocks (dev probe + e2e assertions). */
  views(): OreRockView[] {
    const out: OreRockView[] = [];
    for (const [id, state] of this.rockState) {
      out.push({
        depositId: id,
        visible: state.visible,
        quantity: this.quantityOf(id),
        resourceId: state.resourceId,
        pos: { ...state.pos },
      });
    }
    return out;
  }

  /** The number of InstancedMeshes live in the scene (0 in legacy mode). */
  get instancedMeshCount(): number {
    if (!this.instanced) return 0;
    let n = 0;
    for (const b of this.buckets.values()) n += b.meshes.length;
    return n;
  }

  dispose(): void {
    this.parent?.remove(this.group);
    this.parent = null;
    for (const m of this.legacyMaterials.values()) m.dispose();
    this.legacyMaterials.clear();
    for (const b of this.buckets.values()) b.material.dispose();
    this.buckets.clear();
    this.legacyRocks.clear();
    this.rockState.clear();
    this.geometry.dispose();
  }
}
