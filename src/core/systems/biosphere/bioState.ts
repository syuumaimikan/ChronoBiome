import type { Species } from './species';

/** The great transitions of life, in order. */
export const LIFE_STAGES = [
  { name: '無生命', key: '' },
  { name: '原始生命', key: 'abiogenesisMyr' },
  { name: '光合成', key: 'photosynthesisMyr' },
  { name: '真核生物', key: 'eukaryotesMyr' },
  { name: '多細胞生物', key: 'multicellularMyr' },
  { name: '動物の出現', key: 'animalsMyr' },
  { name: '陸上植物', key: 'landPlantsMyr' },
  { name: '陸上動物', key: 'landAnimalsMyr' },
] as const;

export type StageKey = Exclude<(typeof LIFE_STAGES)[number]['key'], ''>;

/**
 * Everything the biosphere remembers, as plain data (so a keyframe is a
 * structured clone). Densities live on a coarse region grid
 * (geodesic level − 2): `density[slot * regions + r]`, individuals per km² of
 * the region's habitat (land or sea).
 */
export interface BioState {
  regions: number;
  stage: number;
  /** World time of the next transition (−1 = not scheduled). */
  nextAt: number;
  stageTimes: number[];
  /** Atmospheric oxygen, % by volume. */
  oxygen: number;
  /** Land plant cover 0..1 (0 before plants reach land). */
  vegetation: number;
  species: Map<number, Species>;
  living: number[];
  nextId: number;
  slots: number;
  density: Float32Array;
  slotOwner: Int32Array;
  sapientId: number;
  nextImpactAt: number;
  nextLipAt: number;
  massExtinctions: { time: number; cause: string; lostShare: number }[];
  extinctCount: number;
  /** Set by civilisation, per region: people per km² of land, share of land farmed or built. */
  human: Float32Array;
  farmed: Float32Array;
  /** Species alive per region. */
  richness: Uint16Array;
}

export function regionCount(gridLevel: number): number {
  return 10 * 4 ** regionLevel(gridLevel) + 2;
}

export function regionLevel(gridLevel: number): number {
  return Math.max(2, gridLevel - 2);
}

export function createBioState(gridLevel: number, slots: number): BioState {
  const R = regionCount(gridLevel);
  return {
    regions: R,
    stage: 0,
    nextAt: -1,
    stageTimes: [0],
    oxygen: 0,
    vegetation: 0,
    species: new Map(),
    living: [],
    nextId: 0,
    slots,
    density: new Float32Array(slots * R),
    slotOwner: new Int32Array(slots).fill(-1),
    sapientId: -1,
    nextImpactAt: -1,
    nextLipAt: -1,
    massExtinctions: [],
    extinctCount: 0,
    human: new Float32Array(R),
    farmed: new Float32Array(R),
    richness: new Uint16Array(R),
  };
}
