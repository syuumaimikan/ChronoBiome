import type { Rng } from '../../rng';

/**
 * Animal species: a vector of continuous traits plus a few discrete
 * innovations (clade, warm blood, flight). The same record serves the
 * ecology (energy needs, tolerances), evolution (mutation, speciation) and
 * the renderer (body plan, size, colour).
 */

export type Clade = 'arthropod' | 'mollusc' | 'fish' | 'amphibian' | 'reptile' | 'mammal' | 'bird' | 'insect' | 'marine_mammal';

export const CLADE_NAMES: Record<Clade, string> = {
  arthropod: '節足動物',
  mollusc: '軟体動物',
  fish: '魚類',
  amphibian: '両生類',
  reptile: '爬虫類',
  mammal: '哺乳類',
  bird: '鳥類',
  insect: '昆虫',
  marine_mammal: '海生哺乳類',
};

export const DIET_NAMES = ['草食', '雑食', '肉食'] as const;
/** Renderer body plans (surface view). */
export type RenderPlan = 'grazer' | 'heavy' | 'small' | 'predator' | 'bird' | 'aquatic';

export interface Species {
  id: number;
  parent: number;
  name: string;
  sci: string;
  clade: Clade;
  /** 0 land, 1 sea. */
  habitat: 0 | 1;
  /** 0 herbivore, 1 omnivore, 2 carnivore. */
  diet: 0 | 1 | 2;
  massKg: number;
  tempOpt: number;
  tempTol: number;
  moistOpt: number;
  /** 0..1; sapience at the rule pack's threshold. */
  intelligence: number;
  social: number;
  /** Natural spread, km per year. */
  dispersal: number;
  endotherm: boolean;
  flight: boolean;
  /** Colour: hue 0..1, shade 0 (dark) .. 1 (pale), pattern 0 plain / 1 spots / 2 stripes. */
  hue: number;
  shade: number;
  pattern: number;
  /** Horns, crest, tail length and other cosmetic shape genes (0..1). */
  horn: number;
  tail: number;
  born: number;
  /** World time of extinction, −1 while alive. */
  died: number;
  /** Individuals alive (sum over regions) and regions occupied. */
  pop: number;
  range: number;
  peakPop: number;
  /** Density slot in the ecology, −1 when extinct. */
  slot: number;
  sapient: boolean;
  /** Herd animals people can tame (enables husbandry). */
  domesticable: boolean;
  /** Region of origin (coarse grid). */
  origin: number;
  /** Why it went extinct, when it did. */
  cause?: string;
}

/** Field metabolic rate (kcal per year): Kleiber's law, ectotherms ≈ 1/3. */
export function needKcal(sp: Species): number {
  const bmr = 70 * Math.pow(Math.max(1e-4, sp.massKg), 0.75);
  return 365 * bmr * (sp.endotherm ? 3 : 1);
}

/** Maximum population growth rate (per year), falling with body size. */
export function rmax(sp: Species): number {
  return Math.min(6, 1.6 * Math.pow(Math.max(1e-4, sp.massKg), -0.26));
}

/** Body-size guild: < 10 g, < 100 g, < 1 kg, < 10 kg, < 100 kg, < 1 t, < 10 t, larger. */
export function sizeClass(massKg: number): number {
  return Math.max(0, Math.min(7, Math.floor(Math.log10(Math.max(1e-6, massKg)) + 3)));
}

export function renderPlan(sp: Species): RenderPlan {
  if (sp.habitat === 1) return 'aquatic';
  if (sp.clade === 'bird' || (sp.flight && sp.massKg > 0.02)) return 'bird';
  if (sp.massKg < 6) return 'small';
  if (sp.diet === 2) return 'predator';
  if (sp.massKg > 600) return 'heavy';
  return 'grazer';
}

export function isDomesticable(sp: Species): boolean {
  return sp.habitat === 0 && sp.diet === 0 && sp.social > 0.5 && sp.massKg >= 15 && sp.massKg <= 1500 && (sp.clade === 'mammal' || sp.clade === 'bird');
}

// ------------------------------------------------------------------ names

const BASES: Record<Clade, (sp: Species) => string[]> = {
  mammal: (s) =>
    s.diet === 2
      ? s.massKg < 5 ? ['イタチ', 'マングース', 'テン'] : s.massKg < 60 ? ['オオカミ', 'ヤマネコ', 'キツネ', 'ジャッカル'] : ['トラ', 'シシ', 'ヒグマ', 'サーベルネコ']
      : s.diet === 1
        ? s.massKg < 3 ? ['ネズミ', 'アナグマ', 'ハリネズミ'] : s.social > 0.5 && s.massKg < 150 ? ['ザル', 'ヒヒ', 'テナガザル'] : s.massKg < 200 ? ['イノシシ', 'タヌキ', 'アライグマ'] : ['クマ', 'オオグマ']
        : s.massKg < 3 ? ['ウサギ', 'リス', 'ネズミ', 'モグラ'] : s.massKg < 250 ? ['シカ', 'カモシカ', 'ヤギ', 'ガゼル', 'ウマ'] : s.massKg < 3000 ? ['ウシ', 'サイ', 'バク', 'ヘラジカ'] : s.tempOpt < 0 ? ['マンモス'] : ['ゾウ', 'オオナマケモノ'],
  marine_mammal: (s) => (s.massKg < 300 ? ['アザラシ', 'アシカ'] : s.massKg < 3000 ? ['イルカ', 'シャチ'] : ['クジラ']),
  bird: (s) =>
    !s.flight
      ? s.massKg > 40 ? ['ダチョウ', 'モア', 'オオドリ'] : ['ペンギン', 'キーウィ']
      : s.diet === 2 ? (s.massKg < 0.5 ? ['モズ', 'ツバメ'] : ['ワシ', 'タカ', 'コンドル']) : s.massKg < 0.2 ? ['スズメ', 'ヒタキ', 'ハチドリ'] : s.massKg < 3 ? ['カラス', 'ハト', 'キジ', 'カモ'] : ['ツル', 'ペリカン', 'ガン'],
  reptile: (s) =>
    s.diet === 2
      ? s.massKg < 3 ? ['トカゲ', 'ヘビ', 'ヤモリ'] : s.massKg < 800 ? ['ワニ', 'オオトカゲ', 'ニシキヘビ'] : ['ボウリュウ', 'キバリュウ', 'ティラノ']
      : s.massKg < 5 ? ['トカゲ', 'イグアナ'] : s.massKg < 500 ? ['カメ', 'ゾウガメ', 'ヨロイトカゲ'] : s.massKg < 8000 ? ['ツノリュウ', 'ヨロイリュウ', 'カモノハシリュウ'] : ['クビナガリュウ', 'カミナリリュウ'],
  amphibian: (s) => (s.massKg < 0.3 ? ['ガエル', 'イモリ'] : ['サンショウウオ', 'ヨロイガエル']),
  fish: (s) =>
    s.diet === 2 ? (s.massKg < 5 ? ['カマス', 'アンコウ', 'カサゴ'] : ['サメ', 'カジキ', 'ヨロイウオ']) : s.massKg < 0.5 ? ['イワシ', 'メダカ', 'ハゼ', 'ヤツメ'] : s.massKg < 50 ? ['タイ', 'マス', 'ボラ'] : ['ジンベエ', 'マンボウ'],
  arthropod: (s) => (s.diet === 2 ? (s.massKg < 0.5 ? ['ウミグモ', 'シャコ'] : ['ウミサソリ', 'アノマロカリス']) : s.massKg < 0.05 ? ['オキアミ', 'ミジンコ', 'エビ'] : ['サンヨウチュウ', 'カニ', 'カブトガニ']),
  mollusc: (s) => (s.diet === 2 ? (s.massKg < 2 ? ['イカ', 'タコ'] : ['オウムガイ', 'ダイオウイカ']) : ['ガイ', 'サザエ', 'ウミウシ']),
  insect: (s) =>
    s.diet === 2 ? (s.flight ? ['トンボ', 'カマキリ'] : ['クモ', 'サソリ', 'ムカデ']) : s.social > 0.6 ? ['アリ', 'ハチ', 'シロアリ'] : s.flight ? ['チョウ', 'ガ', 'コガネムシ'] : ['バッタ', 'ヤスデ', 'ゴミムシ'],
};

function colourWord(sp: Species): string {
  if (sp.shade < 0.15) return 'クロ';
  if (sp.shade > 0.88) return 'シロ';
  if (sp.shade > 0.4 && sp.shade < 0.5) return 'ハイイロ';
  const h = sp.hue;
  return h < 0.06 || h > 0.94 ? 'アカ' : h < 0.12 ? 'チャ' : h < 0.19 ? 'キ' : h < 0.45 ? 'ミドリ' : h < 0.7 ? 'アオ' : h < 0.85 ? 'ムラサキ' : 'ベニ';
}

function placeWord(sp: Species): string {
  if (sp.habitat === 1) return sp.tempOpt < 4 ? 'ヒョウカイ' : 'ウミ';
  if (sp.tempOpt < -4) return 'ユキ';
  if (sp.moistOpt < 0.22) return 'スナ';
  if (sp.moistOpt > 0.72) return sp.tempOpt > 20 ? 'ミツリン' : 'ヌマ';
  if (sp.tempOpt < 6) return 'ヤマ';
  return sp.tempOpt > 22 ? 'ネッタイ' : 'モリ';
}

/** A Japanese common name ("オオアカシカ") unique among `taken`. */
export function commonName(sp: Species, rng: Rng, taken: Set<string>): string {
  const bases = BASES[sp.clade](sp);
  const base = rng.pick(bases);
  const size = sp.massKg > typicalMass(sp) * 3 ? 'オオ' : sp.massKg < typicalMass(sp) / 3 ? rng.pick(['コ', 'ヒメ']) : '';
  const pattern = sp.pattern === 1 ? 'マダラ' : sp.pattern === 2 ? 'シマ' : '';
  const words = [size, rng.chance(0.6) ? colourWord(sp) : '', pattern, rng.chance(0.55) ? placeWord(sp) : ''].filter(Boolean);
  for (let attempt = 0; attempt < 12; attempt++) {
    const k = Math.min(words.length, attempt < 4 ? 1 + rng.int(2) : 2 + rng.int(2));
    const chosen: string[] = [];
    const pool = [...words];
    for (let i = 0; i < k && pool.length; i++) chosen.push(pool.splice(rng.int(pool.length), 1)[0]);
    // Keep a natural order: size, colour, pattern, place.
    chosen.sort((a, b) => words.indexOf(a) - words.indexOf(b));
    const name = chosen.join('') + base;
    if (!taken.has(name)) return name;
    if (attempt === 11) break;
  }
  let n = 2;
  while (taken.has(`${base}${n}号`) || taken.has(`${words.join('')}${base}モドキ${n > 2 ? n : ''}`)) n++;
  return `${words.join('')}${base}モドキ${n > 2 ? n : ''}`;
}

function typicalMass(sp: Species): number {
  switch (sp.clade) {
    case 'insect': return 0.002;
    case 'arthropod': return 0.05;
    case 'mollusc': return 0.3;
    case 'fish': return 2;
    case 'amphibian': return 0.2;
    case 'reptile': return sp.diet === 2 ? 20 : 30;
    case 'bird': return 1;
    case 'mammal': return sp.diet === 2 ? 30 : 60;
    case 'marine_mammal': return 800;
  }
}

const GREEK_SIZE = ['Micro', 'Lepto', 'Brachy', '', 'Pachy', 'Mega', 'Giganto', 'Titano'];
const GREEK_MISC = ['Xeno', 'Eo', 'Proto', 'Para', 'Neo', 'Cera', 'Dolicho', 'Hydro', 'Ptero', 'Thero', 'Acantho', 'Chloro', 'Melano', 'Rhino', 'Lopho'];
const SUFFIX: Record<Clade, string[]> = {
  mammal: ['therium', 'don', 'cyon', 'lagus', 'mys', 'hippus'],
  marine_mammal: ['cetus', 'phoca'],
  bird: ['ornis', 'pteryx', 'avis'],
  reptile: ['saurus', 'suchus', 'ops', 'chelys'],
  amphibian: ['batrachus', 'triton', 'rana'],
  fish: ['ichthys', 'aspis', 'odus'],
  arthropod: ['caris', 'pterus', 'lithus'],
  mollusc: ['conus', 'teuthis', 'ceras'],
  insect: ['opterus', 'myia', 'merus'],
};
const EPITHETS = {
  cold: ['borealis', 'glacialis', 'nivalis'],
  dry: ['deserti', 'arenarius', 'aridus'],
  wet: ['palustris', 'silvestris', 'fluviatilis'],
  warm: ['tropicus', 'calidus'],
  sea: ['maritimus', 'pelagicus', 'abyssalis'],
  mild: ['montanus', 'campestris', 'vulgaris', 'communis'],
  colour: ['ruber', 'niger', 'albus', 'viridis', 'caeruleus', 'fulvus', 'maculatus', 'striatus'],
};

/** A Latin-style binomial. Children keep the parent's genus unless they changed clade or size a lot. */
export function scientificName(sp: Species, rng: Rng, parent?: Species): string {
  let genus: string;
  if (parent && parent.clade === sp.clade && sizeClass(parent.massKg) === sizeClass(sp.massKg) && rng.chance(0.7)) {
    genus = parent.sci.split(' ')[0];
  } else {
    const size = GREEK_SIZE[sizeClass(sp.massKg)] ?? '';
    const root = rng.chance(0.5) || !size ? rng.pick(GREEK_MISC) : '';
    const g = (size + root.toLowerCase()) || rng.pick(GREEK_MISC);
    genus = g.charAt(0).toUpperCase() + g.slice(1) + rng.pick(SUFFIX[sp.clade]);
  }
  const pool = sp.habitat === 1 ? EPITHETS.sea : sp.tempOpt < 0 ? EPITHETS.cold : sp.moistOpt < 0.25 ? EPITHETS.dry : sp.moistOpt > 0.7 ? EPITHETS.wet : sp.tempOpt > 22 ? EPITHETS.warm : EPITHETS.mild;
  const epithet = rng.chance(0.3) ? rng.pick(EPITHETS.colour) : rng.pick(pool);
  return `${genus} ${epithet}`;
}

/** Short description for lists and the creature card. */
export function describe(sp: Species): string {
  const parts = [CLADE_NAMES[sp.clade], DIET_NAMES[sp.diet], formatMass(sp.massKg)];
  if (sp.flight) parts.push('飛行');
  if (sp.endotherm) parts.push('恒温');
  if (sp.sapient) parts.push('知性種');
  return parts.join('・');
}

export function formatMass(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(kg >= 10_000 ? 0 : 1)} t`;
  if (kg >= 1) return `${kg.toFixed(kg >= 10 ? 0 : 1)} kg`;
  if (kg >= 0.001) return `${(kg * 1000).toFixed(kg >= 0.01 ? 0 : 1)} g`;
  return `${(kg * 1e6).toFixed(0)} mg`;
}
