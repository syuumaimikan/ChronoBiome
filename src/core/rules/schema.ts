import { z } from 'zod';
import { checkExpr } from './expr';

/**
 * Rule pack schema. A rule pack is the tool's input: plain JSON that describes
 * the laws of a world. Sections are added milestone by milestone; unknown
 * top-level keys are rejected so typos surface instead of being ignored.
 */

export const RULE_PACK_SCHEMA_VERSION = 1;

/** Variables available to biome `when` expressions. */
export const BIOME_VARIABLES = [
  'temp', // annual mean temperature, °C
  'moisture', // 0..1 relative wetness
  'elevation', // metres above sea level (0 for ocean)
  'depth', // metres below sea level (0 for land)
  'lat', // latitude in degrees, signed
  'absLat', // |lat|
  'ocean', // 1 if below sea level
] as const;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '色は #rrggbb で指定します');

const expr = (allowed: readonly string[]) =>
  z.string().min(1).superRefine((src, ctx) => {
    const err = checkExpr(src, allowed);
    if (err) ctx.addIssue({ code: 'custom', message: err });
  });

/** Low-poly tree models the surface view can grow. */
export const TREE_KINDS = ['conifer', 'broadleaf', 'birch', 'tropical', 'palm', 'acacia', 'shrub', 'cactus', 'deadwood'] as const;
export type TreeKind = (typeof TREE_KINDS)[number];
/** Animal body plans; each world grows its own species from them. */
export const FAUNA_KINDS = ['grazer', 'heavy', 'small', 'predator', 'bird'] as const;
export type FaunaKind = (typeof FAUNA_KINDS)[number];

/**
 * What the ground of a biome looks like up close (surface view). Optional: a
 * biome without it gets vegetation inferred from its climate.
 */
export const BiomeSurfaceSchema = z.strictObject({
  /** Ground colour; defaults to the biome's map colour. */
  ground: hexColor.optional(),
  /** 0 = treeless, 1 = closed canopy. */
  treeDensity: z.number().min(0).max(1).default(0),
  trees: z.array(z.strictObject({ kind: z.enum(TREE_KINDS), weight: z.number().positive().default(1) })).max(8).default([]),
  /** Grass and herb cover, 0..1. */
  grass: z.number().min(0).max(1).default(0),
  /** Boulders, 0..1 (steep slopes always get some). */
  rocks: z.number().min(0).max(1).default(0.05),
  /** Animals per km² by body plan. */
  fauna: z.array(z.strictObject({ kind: z.enum(FAUNA_KINDS), perKm2: z.number().min(0).max(500) })).max(8).default([]),
});

export const BiomeSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'id は英小文字・数字・_ のみ'),
  name: z.string().min(1),
  color: hexColor,
  /** First biome whose expression is non-zero wins. */
  when: expr(BIOME_VARIABLES),
  surface: BiomeSurfaceSchema.optional(),
});

export const RulePackSchema = z
  .strictObject({
    schemaVersion: z.literal(RULE_PACK_SCHEMA_VERSION),
    meta: z.strictObject({
      name: z.string().min(1),
      description: z.string().default(''),
    }),
    world: z.strictObject({
      /** Geodesic subdivision level: cells = 10·4^level + 2 (6 → 40,962). */
      gridLevel: z.number().int().min(3).max(7).default(6),
      radiusKm: z.number().positive().default(6371),
    }),
    terrain: z.strictObject({
      plateCount: z.number().int().min(2).max(64).default(14),
      /** Share of plates that carry continental crust. */
      continentalPlateShare: z.number().min(0).max(1).default(0.4),
      /** Target share of the surface below sea level. */
      oceanFraction: z.number().min(0).max(1).default(0.7),
      continentalBaseM: z.number().default(600),
      oceanicBaseM: z.number().default(-4200),
      /** Uplift at continent–continent collisions (m). */
      collisionUpliftM: z.number().min(0).default(4200),
      /** Uplift of volcanic arcs over subduction zones (m). */
      arcUpliftM: z.number().min(0).default(2600),
      trenchDepthM: z.number().min(0).default(3500),
      ridgeHeightM: z.number().min(0).default(1800),
      riftDepthM: z.number().min(0).default(900),
      /** Width of boundary features in cells (mountain belt half-width). */
      boundaryWidthCells: z.number().positive().default(3),
      noiseAmplitudeM: z.number().min(0).default(900),
      noiseFrequency: z.number().positive().default(1.6),
      noiseOctaves: z.number().int().min(1).max(10).default(6),
      /** Plate angular speed range, degrees per million years. */
      plateSpeedDegPerMyr: z.tuple([z.number().min(0), z.number().min(0)]).default([0.1, 0.65]),
    }),
    tectonics: z
      .strictObject({
        /** Mantle plumes; plates drifting over them leave island chains. */
        hotspotCount: z.number().int().min(0).max(32).default(6),
        hotspotUpliftMPerMyr: z.number().min(0).default(900),
        /** Hotspot volcanoes stop growing this far above sea level (m). */
        hotspotMaxHeightM: z.number().default(1800),
        /**
         * Arc crust added to the overriding plate per cell of subducted crust (km),
         * scaled by how much of the motion is real convergence. Balances the
         * sediment that erosion carries off the continents into the deep sea.
         */
        arcThickeningKm: z.number().min(0).default(1),
        /** Share of the thinner crust stacked onto the thicker one in a continental collision. */
        collisionThickening: z.number().min(0).max(1).default(0.5),
        maxCrustKm: z.number().min(10).default(70),
        /** Mean time between changes of a plate's motion (Myr). */
        reorganizeEveryMyr: z.number().positive().default(200),
        /** Mean time between rifts of a large plate (Myr). */
        riftEveryMyr: z.number().positive().default(150),
        /** Only plates larger than this share of the surface rift. */
        riftMinAreaShare: z.number().min(0).max(1).default(0.15),
        /** Fractional slow-down of a plate per continental collision cell. */
        collisionDrag: z.number().min(0).max(1).default(0.003),
        /** e-folding time of uncompensated relief (sea floor, and any positive relief) (Myr). */
        reliefDecayMyr: z.number().positive().default(60),
      })
      .default({
        hotspotCount: 6, hotspotUpliftMPerMyr: 900, hotspotMaxHeightM: 1800, arcThickeningKm: 1,
        collisionThickening: 0.5, maxCrustKm: 70, reorganizeEveryMyr: 200, riftEveryMyr: 150,
        riftMinAreaShare: 0.15, collisionDrag: 0.003, reliefDecayMyr: 60,
      }),
    erosion: z
      .strictObject({
        /** Stream-power coefficient K in E = K·√A·S (per year, A in m²). */
        streamPowerK: z.number().min(0).default(2e-7),
        /** Hillslope relaxation toward the neighbour mean, share per Myr. */
        hillslopeRatePerMyr: z.number().min(0).max(1).default(0.02),
        /** Share of a river's sediment dropped in the mouth cell (rest spreads to its sea neighbours). */
        depositShareAtMouth: z.number().min(0).max(1).default(0.5),
      })
      .default({ streamPowerK: 2e-7, hillslopeRatePerMyr: 0.02, depositShareAtMouth: 0.5 }),
    climate: z.strictObject({
      equatorTempC: z.number().default(27),
      poleTempC: z.number().default(-27),
      /** Environmental lapse rate, °C per km of altitude. */
      lapseRateCPerKm: z.number().min(0).default(6.5),
      axialTiltDeg: z.number().min(0).max(90).default(23.44),
      /** Summer–winter swing (°C) of a fully continental cell at the pole at Earth's tilt. */
      maxSeasonalSwingC: z.number().min(0).default(50),
      /** e-folding distance of oceanic influence inland (km). */
      oceanInfluenceKm: z.number().positive().default(1400),
      /** Elevation difference (m) upwind that starts a rain shadow. */
      rainShadowStartM: z.number().min(0).default(800),
    }),
    biomes: z.array(BiomeSchema).min(1).max(250),
    /** Carbon cycle (milestone 3). */
    carbon: z
      .strictObject({
        /** Starting CO2, ppm (pre-industrial Earth ≈ 280). */
        co2Ppm: z.number().min(10).max(100_000).default(280),
        /** Ice-sheet water equivalent per frozen land cell (m), for sea-level change. */
        iceSheetM: z.number().min(0).default(1800),
      })
      .prefault({}),
    /** Life and evolution (milestones 4–5). Mean waiting times in Myr between the great transitions. */
    life: z
      .strictObject({
        enabled: z.boolean().default(true),
        abiogenesisMyr: z.number().positive().default(600),
        photosynthesisMyr: z.number().positive().default(700),
        eukaryotesMyr: z.number().positive().default(1300),
        multicellularMyr: z.number().positive().default(900),
        animalsMyr: z.number().positive().default(350),
        landPlantsMyr: z.number().positive().default(80),
        landAnimalsMyr: z.number().positive().default(60),
        /** Mean time between speciations of one lineage (Myr). */
        speciationMyr: z.number().positive().default(2.5),
        /** Mean lifetime of a species before background extinction (Myr). */
        extinctionMyr: z.number().positive().default(7),
        /** Living species tracked at once (diversification slows near it). */
        maxSpecies: z.number().int().min(8).max(240).default(150),
        /** Intelligence (0..1) at which a lineage becomes sapient and civilisation begins. */
        sapienceThreshold: z.number().min(0.3).max(1).default(0.9),
        /** Upward drift of intelligence per speciation in social, omnivorous warm-blooded lineages. */
        intelligenceDrift: z.number().min(0).max(0.5).default(0.022),
        /** Mean time between large asteroid impacts (Myr). */
        impactEveryMyr: z.number().positive().default(110),
      })
      .prefault({}),
    /** Settlements, economy, technology, buildings, nations, culture (milestones 6–7.5). */
    civilization: z
      .strictObject({
        enabled: z.boolean().default(true),
        /** Multiplier on research speed. */
        researchRate: z.number().min(0).max(100).default(1),
        /** Multiplier on population growth. */
        growthRate: z.number().min(0).max(10).default(1),
        /** Multiplier on the willingness to go to war. */
        aggression: z.number().min(0).max(10).default(1),
        maxSettlements: z.number().int().min(4).max(400).default(200),
        /** CO2 emitted per person per year at full fossil-fuel use (ppm; Earth ≈ 3e-10). */
        emissionPerCapitaPpm: z.number().min(0).default(3e-10),
        /** Pathogens jump from animals to people at this rate multiplier. */
        plagueRate: z.number().min(0).max(10).default(1),
        spaceAge: z.boolean().default(true),
      })
      .prefault({}),
    /** Magic (milestone 8). Disabled by default: the Earth-like pack is pure realism. */
    magic: z
      .strictObject({
        enabled: z.boolean().default(false),
        /** Elements spells can be made of. */
        elements: z.array(z.string().min(1)).min(1).max(12).default(['火', '水', '地', '風', '生命', '精神', '時空']),
        /** Mana welling up at plate boundaries, volcanoes and old forests (per year, field units). */
        sourceRate: z.number().min(0).default(0.02),
        /** Share of the field that dissipates per year. */
        decayPerYear: z.number().min(0).max(1).default(0.01),
        /** Spell power per unit of mana. */
        potency: z.number().positive().default(1),
      })
      .prefault({}),
    /** Astrology (milestone 9): cultural always, arcane (affecting mana) only with magic. */
    astrology: z
      .strictObject({
        enabled: z.boolean().default(true),
        /** Planetary aspects change mana and spell strength (needs magic). */
        arcane: z.boolean().default(false),
        /** Orb (degrees) within which an aspect counts. */
        orbDeg: z.number().min(0.5).max(15).default(6),
      })
      .prefault({}),
  })
  .superRefine((pack, ctx) => {
    const seen = new Set<string>();
    pack.biomes.forEach((b, i) => {
      if (seen.has(b.id)) ctx.addIssue({ code: 'custom', message: `バイオーム id '${b.id}' が重複しています`, path: ['biomes', i, 'id'] });
      seen.add(b.id);
    });
  });

export type RulePack = z.output<typeof RulePackSchema>;
export type RulePackInput = z.input<typeof RulePackSchema>;
export type Biome = z.output<typeof BiomeSchema>;
export type BiomeSurface = z.output<typeof BiomeSurfaceSchema>;

export type ParseResult = { ok: true; pack: RulePack } | { ok: false; errors: string[] };

/** Validate untrusted JSON into a rule pack with defaults applied. */
export function parseRulePack(data: unknown): ParseResult {
  const r = RulePackSchema.safeParse(data);
  if (r.success) return { ok: true, pack: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((iss) => `${iss.path.length ? iss.path.join('.') : '(ルート)'}: ${iss.message}`),
  };
}

/** Parse rule pack text (JSON). */
export function parseRulePackText(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`JSON の構文エラー: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return parseRulePack(data);
}
