import type { FaunaKind, TreeKind } from '../../core/rules/schema';
import type { BiomeInfo } from '../../worker/protocol';

/** Resolved close-up look of one biome. Colours are linear 0..1 triples. */
export interface BiomeLook {
  ground: [number, number, number];
  treeDensity: number;
  trees: TreeKind[];
  /** Cumulative weights matching `trees`, last = 1. */
  treeCum: number[];
  grass: number;
  rocks: number;
  fauna: { kind: FaunaKind; perKm2: number }[];
  /** No `surface` in the rule pack: vegetation follows the local climate instead. */
  auto: boolean;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function resolveLooks(biomes: BiomeInfo[]): BiomeLook[] {
  return biomes.map((b) => {
    const s = b.surface;
    const trees = s?.trees ?? [];
    const total = trees.reduce((a, t) => a + t.weight, 0) || 1;
    let acc = 0;
    return {
      ground: hexToRgb(s?.ground ?? b.color),
      treeDensity: s?.treeDensity ?? 0,
      trees: trees.map((t) => t.kind),
      treeCum: trees.map((t) => (acc += t.weight) / total),
      grass: s?.grass ?? 0,
      rocks: s?.rocks ?? 0.05,
      fauna: s?.fauna ?? [],
      auto: !s,
    };
  });
}

/** Vegetation for a biome without a `surface` description, from climate alone. */
export function autoVegetation(temp: number, moisture: number): { density: number; kind: TreeKind; grass: number } {
  const wet = Math.max(0, Math.min(1, (moisture - 0.2) / 0.6));
  const warm = Math.max(0, Math.min(1, (temp + 6) / 12));
  const density = 0.75 * wet * warm;
  let kind: TreeKind = 'broadleaf';
  if (temp < 4) kind = 'conifer';
  else if (temp > 20) kind = moisture > 0.45 ? 'tropical' : 'acacia';
  if (moisture < 0.18) kind = temp > 14 ? 'cactus' : 'shrub';
  return { density, kind, grass: Math.min(1, moisture * 1.4) * warm };
}

/** Fauna for a biome without a `surface` description. */
export const AUTO_FAUNA: { kind: FaunaKind; perKm2: number }[] = [
  { kind: 'grazer', perKm2: 3 },
  { kind: 'small', perKm2: 5 },
  { kind: 'bird', perKm2: 3 },
];
