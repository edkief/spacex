import type { Hemisphere } from './chart.ts';
import type { ShipClassId } from '../ships/ids.ts';

export type StarClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';

/** One star of the galaxy chart. `id` is the 16-hex-char hash used as the stable key. */
export interface Star {
  id: string;
  name: string;
  class: StarClass;
  /** Galactic coordinates in galactic units; the disk lies in the x/y plane, z is thickness. */
  x: number;
  y: number;
  z: number;
  /** Number of systems (2..8) attached to this star. */
  systemCount: number;
}

export type PlanetClass = 'rocky' | 'terran' | 'ocean' | 'gas' | 'ice';

/** The rogue-AI ships that patrol a planet; one entry in `classes` per ship. */
export interface AiRoster {
  count: number;
  classes: ShipClassId[];
}

/** A point in a frame, in metres. */
export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** An orbital dock platform: a fixed point in the system frame with one landing pad. */
export interface Dock {
  id: string;
  padId: string;
  position: XYZ;
}

/** Atmosphere parameters; `topFraction` is the atmosphere height as a fraction of sim radius. */
export interface PlanetAtmosphere {
  density: number;
  topFraction: number;
}

export interface Planet {
  id: string;
  name: string;
  class: PlanetClass;
  radiusKm: number;
  hasAtmosphere: boolean;
  landable: boolean;
  /** 0..3; at least 1 for every landable planet, 0 for non-landable ones. */
  dockCount: number;
  /** Which resource types exist on this planet (node placement is per surface chunk). */
  resourceTypes: string[];
  aiRoster: AiRoster;
  /** Sim radius in metres: `radiusKm * 10` (1:100 scale). */
  simRadius: number;
  /** Distance from the star in metres (the planet sits in the y = 0 plane). */
  orbitRadius: number;
  /** Fixed system-frame position of the planet centre, metres. */
  position: XYZ;
  /** `dockCount` orbital docks at 1.6 radii from the centre. */
  docks: Dock[];
  /** Null when the planet has no atmosphere. */
  atmosphere: PlanetAtmosphere | null;
}

/** A generated star system: everything below the star, derived from (seed, starId). */
export interface SystemGen {
  systemId: string;
  name: string;
  star: { class: StarClass; name: string; radius: number };
  planets: Planet[];
}

export type Biome = 'plains' | 'rock' | 'canyon' | 'frozen' | 'wetland';

export interface ResourceNode {
  /** Stable identity (hash of seed, planet, chunk and node index); keys resource_node_state. */
  nodeId: string;
  type: string;
  /** Flat metres in the chunk's chart. */
  x: number;
  z: number;
  baseQuantity: number;
}

export interface LandingPad {
  id: string;
  x: number;
  z: number;
}

/**
 * One 256 m x 256 m surface chunk. `heightmap` is a row-major 64x64 grid of integers in
 * HEIGHT_UNITS_PER_M units (decimetres, the Uint16 range): index = j * 64 + i, with i along +x
 * and j along +z. See terrain.ts for the exact world-space position of each sample.
 */
export interface SurfaceChunk {
  /** Which of the planet's two charts this chunk belongs to. */
  hemisphere: Hemisphere;
  chunkX: number;
  chunkZ: number;
  heightmap: number[];
  biome: Biome;
  resourceNodes: ResourceNode[];
  landingPads: LandingPad[];
}
