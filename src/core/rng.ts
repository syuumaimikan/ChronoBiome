import { fmix32, hashCombine, hashString } from './hash';

/**
 * Deterministic PRNG (sfc32) seeded through splitmix32.
 *
 * Every random decision in the simulation goes through an Rng that is derived
 * from the world seed by `fork(label)`, so adding a new system never shifts the
 * random stream of an existing one.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    let s = this.seed;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      return fmix32(s);
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    // Warm up so that nearby seeds diverge immediately.
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** Uniform 32-bit unsigned integer. */
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal sample (Box–Muller; one value per call to stay stateless). */
  normal(): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Pick a uniformly random element. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** Derive an independent child generator from a label (and optional index). */
  fork(label: string, index = 0): Rng {
    return new Rng(deriveSeed(this.seed, label, index));
  }
}

/** Derive a child seed purely from (seed, label, index) — no generator state involved. */
export function deriveSeed(seed: number, label: string, index = 0): number {
  return hashCombine(hashCombine(seed >>> 0, hashString(label)), index >>> 0);
}

/** Turn a user-facing seed (number or text) into a 32-bit seed. */
export function normalizeSeed(seed: string | number): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const text = String(seed).trim();
  if (/^\d+$/.test(text)) return Number(text) >>> 0;
  return hashString(text);
}
