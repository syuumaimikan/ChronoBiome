import { describe, expect, it } from 'vitest';
import { hashBytes, hashString } from '../src/core/hash';
import { MinHeap } from '../src/core/minheap';
import { Noise3 } from '../src/core/noise';
import { deriveSeed, normalizeSeed, Rng } from '../src/core/rng';

describe('Rng', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const sa = Array.from({ length: 8 }, () => a.u32());
    const sb = Array.from({ length: 8 }, () => b.u32());
    const sc = Array.from({ length: 8 }, () => c.u32());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('produces roughly uniform floats in [0,1)', () => {
    const r = new Rng(7);
    const bins = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      bins[Math.floor(v * 10)]++;
    }
    for (const b of bins) expect(Math.abs(b - 10_000)).toBeLessThan(500);
  });

  it('forks independent streams by label without consuming parent state', () => {
    const r = new Rng(1);
    const before = new Rng(1).u32();
    const f1 = r.fork('terrain');
    const f2 = r.fork('climate');
    expect(f1.u32()).not.toBe(f2.u32());
    expect(r.u32()).toBe(before);
    expect(deriveSeed(1, 'terrain')).toBe(new Rng(1).fork('terrain').seed);
  });

  it('normalises text and numeric seeds', () => {
    expect(normalizeSeed('123')).toBe(123);
    expect(normalizeSeed(123)).toBe(123);
    expect(normalizeSeed('Gaia')).toBe(hashString('Gaia'));
  });
});

describe('hash', () => {
  it('hashes bytes exactly', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    const c = new Float32Array([1, 2, 3.0001]);
    expect(hashBytes(a)).toBe(hashBytes(b));
    expect(hashBytes(a)).not.toBe(hashBytes(c));
    // unaligned view takes the byte-wise path and must still be stable
    const buf = new Uint8Array(13);
    buf.set(new Uint8Array(a.buffer), 1);
    expect(hashBytes(buf.subarray(1))).toBe(hashBytes(buf.subarray(1)));
  });
});

describe('Noise3', () => {
  it('is seeded, bounded and continuous', () => {
    const n1 = new Noise3(5), n2 = new Noise3(5), n3 = new Noise3(6);
    expect(n1.sample(0.3, 0.7, 0.1)).toBe(n2.sample(0.3, 0.7, 0.1));
    expect(n1.sample(0.3, 0.7, 0.1)).not.toBe(n3.sample(0.3, 0.7, 0.1));
    let maxStep = 0;
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.001;
      const v = n1.fbm(x, 0.2, 0.9);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.05);
      maxStep = Math.max(maxStep, Math.abs(v - n1.fbm(x + 0.001, 0.2, 0.9)));
    }
    expect(maxStep).toBeLessThan(0.05);
  });
});

describe('MinHeap', () => {
  it('pops in priority order', () => {
    const h = new MinHeap(2);
    const r = new Rng(3);
    const keys = Array.from({ length: 500 }, () => r.next());
    keys.forEach((k, i) => h.push(k, i));
    const out: number[] = [];
    while (h.size) out.push(keys[h.pop()]);
    expect(out).toEqual([...keys].sort((a, b) => a - b));
  });
});
