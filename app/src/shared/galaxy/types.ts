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
  id: string;
  planetId: string;
  coords: [number, number];
  seed: string;
}
