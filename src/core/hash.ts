/**
 * Small, fast, deterministic 32-bit hashes. Used for seed derivation and
 * for fingerprinting world state in determinism tests.
 */

/** FNV-1a over a UTF-16 string, finalised with a murmur3 avalanche. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/** murmur3 finaliser: spreads entropy across all 32 bits. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Order-dependent combination of two 32-bit hashes. */
export function hashCombine(a: number, b: number): number {
  return fmix32((a ^ (b + 0x9e3779b9 + (a << 6) + (a >>> 2))) >>> 0);
}

/** Hash the raw bytes of any typed array (exact bit pattern, so -0 and NaN payloads count). */
export function hashBytes(view: ArrayBufferView, seed = 0): number {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let h = (seed ^ 0x811c9dc5) >>> 0;
  const n4 = bytes.length & ~3;
  let i = 0;
  // Read 4 bytes at a time when aligned for speed; fall back to byte-wise tail.
  if ((bytes.byteOffset & 3) === 0) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, n4 >>> 2);
    for (let w = 0; w < words.length; w++) {
      h ^= words[w];
      h = Math.imul(h, 0x01000193);
      h ^= h >>> 15;
    }
    i = n4;
  }
  for (; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}
