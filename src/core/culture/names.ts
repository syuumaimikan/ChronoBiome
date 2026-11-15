import { hashCombine, hashString } from '../hash';
import { Rng } from '../rng';

/**
 * Procedural names from a phonology. A culture's language is a small vector of
 * sound tendencies (hard/soft consonants, vowel colour, closed syllables, word
 * length, exotic sounds, long vowels); the consonant inventory and syllable
 * shapes follow from it, so every place and person of one culture sounds
 * alike, and dialects that drift apart start to sound different. Names are
 * written in katakana.
 */

export const LANG_DIM = 6;

const VOWELS = ['a', 'i', 'u', 'e', 'o'] as const;
type Vowel = (typeof VOWELS)[number];

const KANA: Record<string, readonly string[]> = {
  '': ['ア', 'イ', 'ウ', 'エ', 'オ'],
  k: ['カ', 'キ', 'ク', 'ケ', 'コ'],
  g: ['ガ', 'ギ', 'グ', 'ゲ', 'ゴ'],
  s: ['サ', 'シ', 'ス', 'セ', 'ソ'],
  z: ['ザ', 'ジ', 'ズ', 'ゼ', 'ゾ'],
  t: ['タ', 'ティ', 'トゥ', 'テ', 'ト'],
  d: ['ダ', 'ディ', 'ドゥ', 'デ', 'ド'],
  n: ['ナ', 'ニ', 'ヌ', 'ネ', 'ノ'],
  h: ['ハ', 'ヒ', 'フ', 'ヘ', 'ホ'],
  b: ['バ', 'ビ', 'ブ', 'ベ', 'ボ'],
  p: ['パ', 'ピ', 'プ', 'ペ', 'ポ'],
  m: ['マ', 'ミ', 'ム', 'メ', 'モ'],
  y: ['ヤ', 'イ', 'ユ', 'イェ', 'ヨ'],
  r: ['ラ', 'リ', 'ル', 'レ', 'ロ'],
  w: ['ワ', 'ウィ', 'ウ', 'ウェ', 'ウォ'],
  v: ['ヴァ', 'ヴィ', 'ヴ', 'ヴェ', 'ヴォ'],
  f: ['ファ', 'フィ', 'フ', 'フェ', 'フォ'],
  sh: ['シャ', 'シ', 'シュ', 'シェ', 'ショ'],
  ch: ['チャ', 'チ', 'チュ', 'チェ', 'チョ'],
  ts: ['ツァ', 'ツィ', 'ツ', 'ツェ', 'ツォ'],
  j: ['ジャ', 'ジ', 'ジュ', 'ジェ', 'ジョ'],
  ky: ['キャ', 'キ', 'キュ', 'ケ', 'キョ'],
};

/** Consonants with their (hardness, exoticness) character. */
const CONSONANTS: readonly [string, number, number][] = [
  ['k', 0.9, 0], ['g', 0.8, 0.1], ['s', 0.4, 0], ['z', 0.6, 0.3], ['t', 0.8, 0], ['d', 0.8, 0.1],
  ['n', 0.2, 0], ['h', 0.3, 0], ['b', 0.7, 0.1], ['p', 0.9, 0.3], ['m', 0.1, 0], ['y', 0.1, 0.1],
  ['r', 0.3, 0], ['w', 0.1, 0.2], ['v', 0.5, 0.9], ['f', 0.4, 0.8], ['sh', 0.4, 0.6], ['ch', 0.6, 0.6],
  ['ts', 0.7, 0.8], ['j', 0.6, 0.6], ['ky', 0.8, 0.7], ['', 0.2, 0],
];

const CODAS = ['ン', 'ル', 'ス', 'ク', 'ト', 'ム', 'ド', 'ル'];

export interface Phonology {
  cons: string[];
  /** Vowel weights a i u e o. */
  vowelW: number[];
  codaRate: number;
  minSyl: number;
  maxSyl: number;
  longRate: number;
  /** Favourite word endings (a culture's recognisable suffixes). */
  endings: string[];
}

/** A random language vector (all dimensions 0..1). */
export function randomLanguage(rng: Rng): Float32Array {
  const v = new Float32Array(LANG_DIM);
  for (let i = 0; i < LANG_DIM; i++) v[i] = rng.next();
  return v;
}

export function languageDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < LANG_DIM; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / LANG_DIM);
}

/** Derive a phonology from a language vector; `seed` separates languages with similar vectors. */
export function phonologyFrom(vec: ArrayLike<number>, seed: number): Phonology {
  const hard = vec[0], vowelColour = vec[1], closed = vec[2], length = vec[3], exotic = vec[4], longV = vec[5];
  const scored = CONSONANTS.map(([c, h, x]) => {
    const noise = (hashCombine(seed, hashString(c)) >>> 0) / 4294967296;
    return { c, s: -Math.abs(h - hard) * 1.4 - Math.max(0, x - exotic) * 2 + noise * 0.9 };
  }).sort((a, b) => b.s - a.s);
  const count = 7 + Math.floor(length * 3 + exotic * 2);
  const cons = scored.slice(0, count).map((x) => x.c);
  if (!cons.includes('')) cons.push('');
  const vowelW = [
    1 + (1 - vowelColour) * 1.5, // a
    0.6 + vowelColour * 1.4, // i
    0.7, // u
    0.5 + vowelColour * 1.2, // e
    0.8 + (1 - vowelColour) * 1.2, // o
  ];
  const rng = new Rng(hashCombine(seed, 0x51ab));
  const endings: string[] = [];
  const phon: Phonology = {
    cons,
    vowelW,
    codaRate: 0.05 + closed * 0.45,
    minSyl: 2,
    maxSyl: 2 + Math.round(length * 2),
    longRate: longV * 0.25,
    endings,
  };
  for (let e = 0; e < 3; e++) endings.push(syllable(phon, rng, true));
  return phon;
}

function pickVowel(ph: Phonology, rng: Rng): number {
  let total = 0;
  for (const w of ph.vowelW) total += w;
  let x = rng.next() * total;
  for (let i = 0; i < VOWELS.length; i++) {
    x -= ph.vowelW[i];
    if (x <= 0) return i;
  }
  return 0;
}

function syllable(ph: Phonology, rng: Rng, final: boolean): string {
  const c = rng.pick(ph.cons);
  const v = pickVowel(ph, rng) as number;
  let s = KANA[c][v];
  if (rng.chance(ph.longRate)) s += 'ー';
  if (final ? rng.chance(ph.codaRate) : rng.chance(ph.codaRate * 0.4)) s += rng.pick(CODAS);
  return s;
}

/** A name in the given phonology (2–5 syllables, sometimes with a cultural ending). */
export function makeName(ph: Phonology, rng: Rng): string {
  const n = ph.minSyl + rng.int(ph.maxSyl - ph.minSyl + 1);
  let s = '';
  for (let i = 0; i < n; i++) s += syllable(ph, rng, i === n - 1);
  if (rng.chance(0.35)) s = s.slice(0, Math.max(2, s.length - 1)) + rng.pick(ph.endings);
  // Avoid small kana or long marks at the start.
  return s.replace(/^[ーンッ]+/, 'ア');
}

/** A short deterministic name from a vector and a key, for things named once (rivers, stars). */
export function nameFor(vec: ArrayLike<number>, langSeed: number, key: number): string {
  return makeName(phonologyFrom(vec, langSeed), new Rng(hashCombine(langSeed, key)));
}

export type { Vowel };
