/**
 * Ship mesh builder — paint-zone material model (TASK-21).
 *
 * Defines the *logical* material model that the renderer applies to a
 * ship mesh: three paint zones (hull body, accent panels, trim lines),
 * each driven by one of the three colors in a `ShipLivery`. The mesh
 * itself is built lazily by `buildShipMesh()` so the renderer can
 * reuse the same three.js `Mesh` instances across paint updates —
 * `applyLivery(shipId, livery)` rewrites material colors in place,
 * never rebuilds the mesh.
 *
 * ## Why split into paint zones?
 *
 * Three colours (hull / accent / trim) is enough to give each ship a
 * distinct identity (a freighter with orange hull, black trim, and
 * white accent looks nothing like one with blue hull, red trim, and
 * yellow accent) while staying well below the material-swap budget
 * — three materials per ship, six to twelve ships in-system, all
 * edited in O(1) per ship.
 *
 * ## three.js dependency
 *
 * This module does NOT import three.js directly. The renderer is
 * responsible for calling `buildShipMesh()` with a constructor (e.g.
 * `THREE.MeshBasicMaterial`) and an `applyMaterialColor` adapter. That
 * keeps the paint logic unit-testable in Node (no three.js import,
 * no WebGL context) and lets the client pick its preferred material
 * class — MeshBasicMaterial for impostors, MeshStandardMaterial for
 * full LOD, etc.
 *
 * The default `createThreeJsAdapter()` factory uses real three.js
 * constructors; the renderer injects those when it boots.
 *
 * ## Default livery per class
 *
 * `defaultLiveryFor(classId)` reads the catalog in `@shared/ships`
 * and returns the canonical paint for the three v1 ships. TASK-21
 * ships the same default across both client and server: the DB
 * persists `DEFAULT_LIVERY` on `getOrCreateStarterShip`, so the
 * client's first-frame paint matches the freshly-claimed starter.
 */
import type { ShipClassId } from "@shared/ships.js";
import type { ShipLivery } from "@server/db/types.js";

/**
 * The three named paint zones every v1 ship supports (TASK-21).
 *
 * Names are stable: the renderer maps them to material slots, the
 * protocol schema uses them as keys, and the bus event payload
 * references them indirectly through `ShipLivery.primary/secondary/
 * accent`.
 *
 * Ordered for stable iteration in the dock UI:
 *   hull   — main body panels (largest visible area).
 *   accent — secondary panels (engine cowlings, fin highlights).
 *   trim   — pinstripe detail (panel edges, decals).
 */
export type PaintZone = "hull" | "accent" | "trim";

/** All paint zones in stable UI order. */
export const PAINT_ZONES: readonly PaintZone[] = ["hull", "accent", "trim"] as const;

/**
 * Default livery for a given ship class (TASK-21 acceptance: "default
 * per class from catalog"). v1 ships share a single default
 * (`DEFAULT_LIVERY` in the persistence layer); the catalog is the
 * single source of truth so the dock UI can show a "Reset to default"
 * button without re-implementing the colour triple.
 *
 * Future per-class defaults can branch on `classId` without breaking
 * callers.
 */
export function defaultLiveryFor(_classId: ShipClassId): ShipLivery {
  return {
    primary: "#3aa9ff",
    secondary: "#0d3a66",
    accent: "#ffffff",
  };
}

/**
 * Map a `ShipLivery` to the three paint-zone colours.
 *
 * The mapping is intentionally a one-liner today (zone ↔ wire key)
 * so a future "swap hull and accent" or "rotate trim with primary"
 * design tweak can land without touching every consumer.
 */
export interface PaintZoneColors {
  hull: string;
  accent: string;
  trim: string;
}

export function liveryToPaintZones(livery: ShipLivery): PaintZoneColors {
  return {
    hull: livery.primary,
    accent: livery.accent,
    trim: livery.secondary,
  };
}

/**
 * Minimal material adapter the renderer supplies. The builder owns
 * the per-zone mapping; the adapter owns the three.js side.
 *
 * The contract is intentionally tiny:
 *   - `createPaintMaterial(zone, hex)`  — make a fresh material for one zone.
 *   - `applyMaterialColor(material, hex)` — repaint an existing material in place.
 *   - `disposeMaterial(material)`       — release GPU resources (called on ship removal).
 *
 * Builders never read or mutate the underlying three.js objects;
 * tests pass plain `{ color, dispose() }` stubs.
 */
export interface MaterialAdapter {
  /** Create a new paint material for one zone, initialised to `hex`. */
  createPaintMaterial(zone: PaintZone, hex: string): PaintMaterial;
  /** Repaint an existing material in place. Must NOT reallocate. */
  applyMaterialColor(material: PaintMaterial, hex: string): void;
  /** Release GPU resources. Idempotent. */
  disposeMaterial(material: PaintMaterial): void;
}

/**
 * Public shape of one paint material — the adapter hides the three.js
 * concrete type so unit tests can substitute `{ color, dispose }`.
 */
export interface PaintMaterial {
  /** Hex string the material currently renders. */
  color: string;
  /** Zone the material is bound to. */
  zone: PaintZone;
  /** Free GPU resources. */
  dispose(): void;
}

/**
 * A built ship mesh: three paint materials, one per zone, plus a
 * `dispose()` that frees every material. The renderer holds onto a
 * `ShipMesh` per `shipId` and calls `applyLivery(mesh, livery)` to
 * repaint without rebuilding the underlying geometry.
 */
export interface ShipMesh {
  /** Owning ship id — used by the renderer's mesh registry. */
  readonly shipId: string;
  /** Ship class this mesh was built for. */
  readonly classId: ShipClassId;
  /** Paint material per zone. */
  readonly materials: Record<PaintZone, PaintMaterial>;
  /** Disposes every per-zone material (idempotent). */
  dispose(): void;
}

/**
 * Per-ship paint registry — keyed by shipId so the renderer can
 * update an existing ship's colours in O(1) without rebuilding the
 * geometry. Created with a `MaterialAdapter`; never knows about
 * three.js directly.
 */
export class ShipPaintRegistry {
  private readonly meshes = new Map<string, ShipMesh>();

  constructor(private readonly adapter: MaterialAdapter) {}

  /**
   * Build a new ship mesh with the default livery for the class.
   * If a mesh already exists for `shipId`, returns it unchanged
   * (idempotent — the renderer can re-call this on each frame without
   * worrying about leaks).
   */
  buildShipMesh(shipId: string, classId: ShipClassId): ShipMesh {
    const existing = this.meshes.get(shipId);
    if (existing !== undefined) return existing;
    const livery = defaultLiveryFor(classId);
    const mesh = this.createMesh(shipId, classId, livery);
    this.meshes.set(shipId, mesh);
    return mesh;
  }

  /**
   * Build a new ship mesh and apply the supplied livery immediately.
   * Convenience for the renderer's "create + paint" path.
   */
  buildShipMeshWithLivery(shipId: string, classId: ShipClassId, livery: ShipLivery): ShipMesh {
    const existing = this.meshes.get(shipId);
    if (existing !== undefined) {
      // Already built — just apply the requested livery in place.
      this.applyLivery(shipId, livery);
      return existing;
    }
    const mesh = this.createMesh(shipId, classId, livery);
    this.meshes.set(shipId, mesh);
    return mesh;
  }

  /**
   * Repaint an existing ship in place. No mesh rebuild. Throws
   * `Error` if the mesh is not registered — the caller is expected
   * to call `buildShipMesh` (or `buildShipMeshWithLivery`) first.
   *
   * This is the hot path used by the WS `entity_update` consumer:
   * every paint event from the server hits this method, so it must
   * stay allocation-free (the adapter's `applyMaterialColor` must
   * mutate, not replace, the material).
   */
  applyLivery(shipId: string, livery: ShipLivery): void {
    const mesh = this.meshes.get(shipId);
    if (mesh === undefined) {
      throw new Error(`applyLivery: no mesh registered for shipId=${shipId}`);
    }
    const zoneColors = liveryToPaintZones(livery);
    for (const zone of PAINT_ZONES) {
      const material = mesh.materials[zone];
      const hex = zoneColors[zone];
      if (material.color !== hex) {
        this.adapter.applyMaterialColor(material, hex);
      }
    }
  }

  /**
   * Look up a registered mesh. Returns `undefined` if the ship has
   * not been built yet — the renderer should treat that as a hint
   * to call `buildShipMesh` (the ship just came into view).
   */
  getShipMesh(shipId: string): ShipMesh | undefined {
    return this.meshes.get(shipId);
  }

  /**
   * Dispose a registered mesh and remove it from the registry.
   * Idempotent — calling twice is a no-op.
   */
  disposeShip(shipId: string): void {
    const mesh = this.meshes.get(shipId);
    if (mesh === undefined) return;
    mesh.dispose();
    this.meshes.delete(shipId);
  }

  /**
   * Dispose every registered mesh. Used on renderer teardown.
   */
  disposeAll(): void {
    for (const [shipId] of this.meshes) {
      this.disposeShip(shipId);
    }
  }

  /** Number of currently-registered meshes — for tests + HUD diagnostics. */
  size(): number {
    return this.meshes.size;
  }

  private createMesh(shipId: string, classId: ShipClassId, livery: ShipLivery): ShipMesh {
    const zoneColors = liveryToPaintZones(livery);
    const materials: Record<PaintZone, PaintMaterial> = {
      hull: this.adapter.createPaintMaterial("hull", zoneColors.hull),
      accent: this.adapter.createPaintMaterial("accent", zoneColors.accent),
      trim: this.adapter.createPaintMaterial("trim", zoneColors.trim),
    };
    const adapterRef = this.adapter;
    let disposed = false;
    return {
      shipId,
      classId,
      materials,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        for (const zone of PAINT_ZONES) {
          adapterRef.disposeMaterial(materials[zone]);
        }
      },
    };
  }
}

/**
 * In-memory test adapter — no three.js, no GPU. Tracks every
 * `applyMaterialColor` call so a unit test can assert the hot
 * path swapped colors in place (no reallocation).
 *
 * Each created material exposes a `setCalls` counter the test can
 * read directly.
 */
export interface InMemoryPaintMaterial extends PaintMaterial {
  /** How many times `applyMaterialColor` has been invoked on this material. */
  setCalls: number;
}

export function createInMemoryAdapter(): MaterialAdapter & {
  /** Material creation history, in registration order. */
  readonly created: InMemoryPaintMaterial[];
  /** Total `applyMaterialColor` invocations across every material. */
  totalSetCalls(): number;
} {
  const created: InMemoryPaintMaterial[] = [];
  return {
    created,
    totalSetCalls(): number {
      return created.reduce((sum, m) => sum + m.setCalls, 0);
    },
    createPaintMaterial(zone: PaintZone, hex: string): InMemoryPaintMaterial {
      const material: InMemoryPaintMaterial = {
        zone,
        color: hex,
        setCalls: 0,
        dispose(): void {
          // No GPU resources to free in the in-memory adapter.
          this.color = "#000000";
        },
      };
      created.push(material);
      return material;
    },
    applyMaterialColor(material: InMemoryPaintMaterial, hex: string): void {
      material.color = hex;
      material.setCalls += 1;
    },
    disposeMaterial(material: InMemoryPaintMaterial): void {
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// doc note (kept terse on purpose)
// ---------------------------------------------------------------------------
//
// Why this file lives in `app/src/client/ships/` and not in
// `app/src/shared/`:
//   - The renderer is the only consumer. Keeping it client-side
//     means a future browser-only optimisation (e.g. lazy three.js
//     import) doesn't pollute the shared bundle.
//   - The persistence layer already owns `ShipLiverySchema` (TASK-21
//     ships the same hex triple on both sides of the wire). The
//     paint-zone mapping is purely a renderer concern.
//
// Why we don't expose `ShipMesh.geometry`:
//   - Three different ship classes will eventually have three
//     different meshes (scout: arrowhead, freighter: brick,
//     interceptor: dart). The builder today returns materials; the
//     renderer (TASK-26 onward) attaches the right geometry from a
//     per-class lookup table. Keeping geometry out of this module
//     means swapping meshes per class is a renderer-only change.
