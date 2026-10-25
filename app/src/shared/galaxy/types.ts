export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';

export interface Star {
  id: string;
  name: string;
  class: SpectralClass;
  x: number;
  y: number;
  z: number;
  systemCount: number;
}

export type ShipClassId = 'scout' | 'freighter' | 'interceptor';

export interface Planet {
  id: string;
  name: string;
  class: 'rocky' | 'terran' | 'ocean' | 'gas' | 'ice';
  radiusKm: number;
  hasAtmosphere: boolean;
  atmosphereHeight?: number; // Height in km above radiusKm
  atmosphereDensity?: number; // Scaling factor for drag/haze
  landable: boolean;
  dockCount: number;
  resourceTypes: string[];
  aiRoster: {
    count: number;
    classes: ShipClassId[];
  };
}

export interface SystemGen {
  systemId: string;
  name: string;
  star: {
    class: SpectralClass;
    name: string;
  };
  planets: Planet[];
}

export interface SystemSummary {
  starId: string;
  planetCount: number;
  hasStation: boolean;
  dangerLevel: number;
}

export interface SurfaceChunk {
  chunkX: number;
  chunkZ: number;
  heightmap: number[];
  biome: 'plains' | 'rock' | 'canyon' | 'frozen' | 'wetland';
  resourceNodes: {
    nodeId: string;
    type: string;
    x: number;
    z: number;
    baseQuantity: number;
  }[];
  landingPads: {
    id: string;
    x: number;
    z: number;
  }[];
}
