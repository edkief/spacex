/**
 * Galaxy domain types. Interfaces here are deliberately forward-looking:
 * TASK-3 (stars) is the first consumer, later tasks extend the rest.
 */

/** Spectral class of a star, hottest to coolest. */
export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';

/** A star in the galaxy. Coordinates are in galactic units (see config). */
export interface Star {
  /** Stable 16-hex-char id derived from (galaxySeed, starIndex). Referenced by systems and the DB. */
  id: string;
  /** Human-readable name; unique within the galaxy. */
  name: string;
  /** Spectral class (drives color/temperature in rendering tasks). */
  class: SpectralClass;
  /** Galactic x coordinate (galactic units, thin-disk distribution). */
  x: number;
  /** Galactic y coordinate (galactic units, thin-disk distribution). */
  y: number;
  /** Galactic z coordinate (thin: |z| << radius). */
  z: number;
  /** Number of planetary systems the star hosts (2..8). */
  systemCount: number;
}

/** Compact per-system descriptor used by the chart and system shards. */
export interface SystemSummary {
  /** Star id this system orbits. */
  starId: string;
  /** Unique system name (generated in TASK-4). */
  name: string;
  /** Number of planets in the system. */
  planetCount: number;
}

/** Surface class of a planet. */
export type PlanetClass = 'rocky' | 'terran' | 'ocean' | 'gas' | 'ice';

/** Rogue-AI ship class ids; must match the TASK-19 catalog ids. */
export type ShipClassId = 'scout' | 'freighter' | 'interceptor';

/** Rogue-AI ship roster active on a planet. */
export interface AiRoster {
  /** Number of rogue-AI ships (2..5). */
  count: number;
  /** Ship class of each ship, in roster order (length === count). */
  classes: ShipClassId[];
}

/** A planet within a system (TASK-4). */
export interface Planet {
  id: string;
  name: string;
  class: PlanetClass;
  /** Planet radius in kilometres. */
  radiusKm: number;
  /** Whether the planet has an atmosphere. */
  hasAtmosphere: boolean;
  /** Whether a ship can land (gas giants are never landable). */
  landable: boolean;
  /** Docks on the surface: 1..3 when landable, 0 otherwise. */
  dockCount: number;
  /** Resource types present as surface deposit fields (per-chunk placement is TASK-5). */
  resourceTypes: string[];
  /** Rogue-AI ships active on this planet. */
  aiRoster: AiRoster;
}

/** Full generated star system (TASK-4). */
export interface SystemGen {
  /** Unique system id, 16-hex, derived from (seed, starId). */
  systemId: string;
  /** System name (star name + ' system'). */
  name: string;
  /** Host star (class + name, derived from the same (seed, starId) sub-seed). */
  star: { class: SpectralClass; name: string };
  /** Planets, in deterministic orbital-slot order (index order, never by value). */
  planets: Planet[];
}

/** Surface biome of a chunk. */
export type Biome = 'plains' | 'rock' | 'canyon' | 'frozen' | 'wetland';

/** A surface resource node (stable id keys the resource_node_state table). */
export interface ResourceNode {
  /** 16-hex-char id derived from (seed, planetId, chunkX, chunkZ, nodeIndex). */
  nodeId: string;
  /** Resource type; always one of the planet's resourceTypes. */
  type: string;
  /** X position in meters from the chunk origin (cell-aligned). */
  x: number;
  /** Z position in meters from the chunk origin (cell-aligned). */
  z: number;
  /** Initial extractable quantity (50..200). */
  baseQuantity: number;
}

/** A landing pad on a chunk. */
export interface LandingPad {
  /** 16-hex-char id derived from the chunk sub-seed. */
  id: string;
  /** X position in meters from the chunk origin (cell-aligned). */
  x: number;
  /** Z position in meters from the chunk origin (cell-aligned). */
  z: number;
}

/** A streaming surface chunk of a planet (generated in TASK-5). */
export interface SurfaceChunk {
  /** Sector column index on the planet's surface grid. */
  chunkX: number;
  /** Sector row index on the planet's surface grid. */
  chunkZ: number;
  /** 64x64 row-major heightmap in meters (Uint16-safe integers). */
  heightmap: number[];
  /** Dominant biome of the chunk. */
  biome: Biome;
  /** 1..4 resource nodes (0 on non-landable planets). */
  resourceNodes: ResourceNode[];
  /** 0..1 landing pad (always exactly 1 on chunk (0,0) of a landable planet). */
  landingPads: LandingPad[];
}
