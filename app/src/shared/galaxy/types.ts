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

/** A planet within a system (fields extended in TASK-4). */
export interface Planet {
  id: string;
  name: string;
  /** 1-based orbital slot around the star. */
  orbitIndex: number;
  /** Whether the planet has an atmosphere (landing possible). */
  hasAtmosphere: boolean;
  /** Whether the surface is habitable (oxygen + liquid water). */
  isHabitable: boolean;
  /** Planet radius in surface units. */
  radius: number;
}

/** A streaming surface chunk of a planet (generated in TASK-5). */
export interface SurfaceChunk {
  /** Planet id this chunk belongs to. */
  planetId: string;
  /** Sector column index on the planet's surface grid. */
  sectorX: number;
  /** Sector row index on the planet's surface grid. */
  sectorY: number;
  /** Deterministic seed for terrain/noise in this chunk. */
  terrainSeed: bigint;
}
