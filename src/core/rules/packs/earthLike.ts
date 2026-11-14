import type { RulePackInput } from '../schema';

/**
 * "Earth-like": the default pack, calibrated against real-world rules of thumb.
 * Biomes follow a Whittaker-style split on annual mean temperature and
 * moisture; the first matching entry wins, so order matters.
 */
export const earthLikePack: RulePackInput = {
  schemaVersion: 1,
  meta: {
    name: 'Earth-like',
    description: '地球の経験則で較正した既定のルール（魔法なし）',
  },
  world: { gridLevel: 6, radiusKm: 6371 },
  terrain: {
    plateCount: 14,
    continentalPlateShare: 0.4,
    oceanFraction: 0.7,
    continentalBaseM: 600,
    oceanicBaseM: -4200,
    collisionUpliftM: 4200,
    arcUpliftM: 2600,
    trenchDepthM: 3500,
    ridgeHeightM: 1800,
    riftDepthM: 900,
    boundaryWidthCells: 3,
    noiseAmplitudeM: 900,
    noiseFrequency: 1.6,
    noiseOctaves: 6,
    plateSpeedDegPerMyr: [0.1, 0.65],
  },
  tectonics: {
    hotspotCount: 6,
    hotspotUpliftMPerMyr: 900,
    hotspotMaxHeightM: 1800,
    arcThickeningKm: 1,
    collisionThickening: 0.5,
    maxCrustKm: 70,
    reorganizeEveryMyr: 200,
    riftEveryMyr: 150,
    riftMinAreaShare: 0.15,
    collisionDrag: 0.003,
    reliefDecayMyr: 60,
  },
  erosion: {
    streamPowerK: 2e-7,
    hillslopeRatePerMyr: 0.02,
    depositShareAtMouth: 0.5,
  },
  climate: {
    equatorTempC: 27,
    poleTempC: -27,
    lapseRateCPerKm: 6.5,
    axialTiltDeg: 23.44,
    maxSeasonalSwingC: 50,
    oceanInfluenceKm: 1400,
    rainShadowStartM: 800,
  },
  biomes: [
    { id: 'sea_ice', name: '海氷', color: '#dbe7ee', when: 'ocean && temp < -1.8', surface: { ground: '#e4edf2', rocks: 0 } },
    { id: 'deep_ocean', name: '深海', color: '#1c3d70', when: 'ocean && depth > 1500', surface: { ground: '#4a5560', rocks: 0 } },
    { id: 'shallow_sea', name: '浅海', color: '#2f6ca6', when: 'ocean', surface: { ground: '#b9a77a', rocks: 0.03 } },
    {
      id: 'ice_sheet', name: '氷床', color: '#f1f4f6', when: 'temp < -10',
      surface: { ground: '#f2f5f7', rocks: 0.02, fauna: [{ kind: 'bird', perKm2: 0.5 }] },
    },
    {
      id: 'tundra', name: 'ツンドラ', color: '#97a287', when: 'temp < -2',
      surface: {
        ground: '#8f9a77', treeDensity: 0.06, trees: [{ kind: 'shrub', weight: 4 }, { kind: 'birch', weight: 1 }], grass: 0.55, rocks: 0.14,
        fauna: [{ kind: 'grazer', perKm2: 4 }, { kind: 'small', perKm2: 8 }, { kind: 'predator', perKm2: 0.4 }, { kind: 'bird', perKm2: 3 }],
      },
    },
    {
      id: 'alpine', name: '高山・裸岩', color: '#8c8377', when: 'elevation > 3800',
      surface: {
        ground: '#857d71', treeDensity: 0.03, trees: [{ kind: 'shrub', weight: 1 }], grass: 0.2, rocks: 0.5,
        fauna: [{ kind: 'grazer', perKm2: 2 }, { kind: 'bird', perKm2: 1.5 }],
      },
    },
    {
      id: 'taiga', name: '針葉樹林（タイガ）', color: '#3d6a4f', when: 'temp < 5 && moisture >= 0.3',
      surface: {
        ground: '#4d6a47', treeDensity: 0.6, trees: [{ kind: 'conifer', weight: 5 }, { kind: 'birch', weight: 1 }], grass: 0.3, rocks: 0.08,
        fauna: [{ kind: 'grazer', perKm2: 2 }, { kind: 'small', perKm2: 6 }, { kind: 'predator', perKm2: 0.4 }, { kind: 'bird', perKm2: 4 }],
      },
    },
    {
      id: 'cold_steppe', name: '寒冷ステップ', color: '#a7a27b', when: 'temp < 5',
      surface: {
        ground: '#a29e77', treeDensity: 0.03, trees: [{ kind: 'shrub', weight: 3 }, { kind: 'conifer', weight: 1 }], grass: 0.75, rocks: 0.07,
        fauna: [{ kind: 'grazer', perKm2: 7 }, { kind: 'small', perKm2: 10 }, { kind: 'predator', perKm2: 0.3 }, { kind: 'bird', perKm2: 2 }],
      },
    },
    {
      id: 'temperate_rainforest', name: '温帯雨林', color: '#2c7649', when: 'temp < 18 && moisture > 0.68',
      surface: {
        ground: '#3a6440', treeDensity: 0.8, trees: [{ kind: 'conifer', weight: 3 }, { kind: 'broadleaf', weight: 2 }], grass: 0.4, rocks: 0.05,
        fauna: [{ kind: 'grazer', perKm2: 3 }, { kind: 'small', perKm2: 6 }, { kind: 'predator', perKm2: 0.4 }, { kind: 'bird', perKm2: 6 }],
      },
    },
    {
      id: 'temperate_forest', name: '温帯落葉樹林', color: '#4f8e3f', when: 'temp < 18 && moisture > 0.42',
      surface: {
        ground: '#5a8240', treeDensity: 0.55, trees: [{ kind: 'broadleaf', weight: 5 }, { kind: 'birch', weight: 1 }, { kind: 'conifer', weight: 1 }],
        grass: 0.55, rocks: 0.05,
        fauna: [{ kind: 'grazer', perKm2: 4 }, { kind: 'small', perKm2: 8 }, { kind: 'predator', perKm2: 0.3 }, { kind: 'bird', perKm2: 6 }],
      },
    },
    {
      id: 'grassland', name: '温帯草原', color: '#a4b65f', when: 'temp < 18 && moisture > 0.2',
      surface: {
        ground: '#97ab56', treeDensity: 0.03, trees: [{ kind: 'broadleaf', weight: 1 }, { kind: 'shrub', weight: 2 }], grass: 0.95, rocks: 0.04,
        fauna: [{ kind: 'grazer', perKm2: 10 }, { kind: 'heavy', perKm2: 1.5 }, { kind: 'small', perKm2: 12 }, { kind: 'predator', perKm2: 0.5 }, { kind: 'bird', perKm2: 4 }],
      },
    },
    {
      id: 'cold_desert', name: '温帯砂漠', color: '#c8b88b', when: 'temp < 18',
      surface: {
        ground: '#c4b487', treeDensity: 0.03, trees: [{ kind: 'shrub', weight: 3 }, { kind: 'deadwood', weight: 1 }], grass: 0.1, rocks: 0.22,
        fauna: [{ kind: 'small', perKm2: 3 }, { kind: 'grazer', perKm2: 0.8 }, { kind: 'bird', perKm2: 1 }],
      },
    },
    {
      id: 'tropical_rainforest', name: '熱帯雨林', color: '#1d6b2d', when: 'moisture > 0.68',
      surface: {
        ground: '#2d5d2b', treeDensity: 0.88, trees: [{ kind: 'tropical', weight: 5 }, { kind: 'palm', weight: 1 }], grass: 0.45, rocks: 0.03,
        fauna: [{ kind: 'small', perKm2: 8 }, { kind: 'grazer', perKm2: 2 }, { kind: 'predator', perKm2: 0.3 }, { kind: 'bird', perKm2: 10 }],
      },
    },
    {
      id: 'tropical_seasonal', name: '熱帯季節林', color: '#5e9834', when: 'moisture > 0.42',
      surface: {
        ground: '#6a9237', treeDensity: 0.45, trees: [{ kind: 'tropical', weight: 2 }, { kind: 'broadleaf', weight: 2 }, { kind: 'palm', weight: 1 }],
        grass: 0.65, rocks: 0.04,
        fauna: [{ kind: 'grazer', perKm2: 5 }, { kind: 'heavy', perKm2: 0.8 }, { kind: 'small', perKm2: 8 }, { kind: 'predator', perKm2: 0.3 }, { kind: 'bird', perKm2: 6 }],
      },
    },
    {
      id: 'savanna', name: 'サバンナ', color: '#c1b55b', when: 'moisture > 0.2',
      surface: {
        ground: '#b9aa57', treeDensity: 0.06, trees: [{ kind: 'acacia', weight: 4 }, { kind: 'shrub', weight: 1 }], grass: 0.9, rocks: 0.05,
        fauna: [{ kind: 'grazer', perKm2: 12 }, { kind: 'heavy', perKm2: 2 }, { kind: 'predator', perKm2: 0.6 }, { kind: 'small', perKm2: 5 }, { kind: 'bird', perKm2: 4 }],
      },
    },
    {
      id: 'hot_desert', name: '熱帯砂漠', color: '#dfc68a', when: '1',
      surface: {
        ground: '#d9c088', treeDensity: 0.015, trees: [{ kind: 'cactus', weight: 2 }, { kind: 'shrub', weight: 1 }, { kind: 'deadwood', weight: 1 }],
        grass: 0.03, rocks: 0.18,
        fauna: [{ kind: 'small', perKm2: 2 }, { kind: 'grazer', perKm2: 0.5 }, { kind: 'bird', perKm2: 0.6 }],
      },
    },
  ],
};
