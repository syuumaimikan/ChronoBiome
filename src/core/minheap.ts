/** Binary min-heap of (priority, int value) pairs on typed arrays. Grows on demand. */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) this.grow();
    let i = this.size++;
    const k = this.keys;
    const v = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }

  /** Priority of the top element (undefined behaviour when empty). */
  peekKey(): number {
    return this.keys[0];
  }

  /** Remove and return the value with the smallest priority. */
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const n = --this.size;
    const key = k[n];
    const val = v[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && k[c + 1] < k[c]) c++;
      if (k[c] >= key) break;
      k[i] = k[c];
      v[i] = v[c];
      i = c;
    }
    k[i] = key;
    v[i] = val;
    return top;
  }

  private grow(): void {
    const k = new Float64Array(this.keys.length * 2);
    k.set(this.keys);
    const v = new Int32Array(this.vals.length * 2);
    v.set(this.vals);
    this.keys = k;
    this.vals = v;
  }
}
