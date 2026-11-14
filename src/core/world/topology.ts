/**
 * The only spatial structure systems are allowed to depend on: a set of cells
 * with positions and a CSR adjacency table. The surface of a planet, a cave
 * layer or another planet are all just Topologies, so every system runs on any
 * of them unchanged.
 */
export interface Topology {
  readonly count: number;
  /** Unit-sphere position of each cell, xyz interleaved. */
  readonly pos: Float32Array;
  /** Latitude / longitude in radians. */
  readonly lat: Float32Array;
  readonly lon: Float32Array;
  /** CSR adjacency: neighbours of i are nbr[nbrStart[i] .. nbrStart[i+1]). */
  readonly nbrStart: Int32Array;
  readonly nbr: Int32Array;
  /** Planet radius and mean centre-to-centre distance between neighbours, km. */
  readonly radiusKm: number;
  readonly spacingKm: number;
}

export function degree(t: Topology, i: number): number {
  return t.nbrStart[i + 1] - t.nbrStart[i];
}

/** Great-circle distance between two cells in km. */
export function distanceKm(t: Topology, a: number, b: number): number {
  const p = t.pos;
  const dot = p[a * 3] * p[b * 3] + p[a * 3 + 1] * p[b * 3 + 1] + p[a * 3 + 2] * p[b * 3 + 2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) * t.radiusKm;
}

/** Index of the cell closest to a unit vector (linear scan; for UI/tests, not hot paths). */
export function nearestCell(t: Topology, x: number, y: number, z: number): number {
  let best = 0;
  let bestDot = -Infinity;
  const p = t.pos;
  for (let i = 0; i < t.count; i++) {
    const d = p[i * 3] * x + p[i * 3 + 1] * y + p[i * 3 + 2] * z;
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  return best;
}

/**
 * Multi-source breadth-first distance (in hops) from every cell flagged in
 * `sources`. Cells unreachable through `passable` get `Infinity`.
 */
export function hopDistance(
  t: Topology,
  sources: (i: number) => boolean,
  passable: (i: number) => boolean = () => true,
  out: Float32Array = new Float32Array(t.count),
): Float32Array {
  out.fill(Infinity);
  const queue = new Int32Array(t.count);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < t.count; i++) {
    if (sources(i)) {
      out[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const c = queue[head++];
    const d = out[c] + 1;
    for (let k = t.nbrStart[c]; k < t.nbrStart[c + 1]; k++) {
      const n = t.nbr[k];
      if (out[n] > d && passable(n)) {
        out[n] = d;
        queue[tail++] = n;
      }
    }
  }
  return out;
}

/**
 * Smooth a field by averaging each cell with its neighbours `iterations` times.
 * `weight` is the share kept from the cell itself.
 */
export function smoothField(
  t: Topology,
  field: Float32Array,
  iterations: number,
  weight = 0.5,
  scratch: Float32Array = new Float32Array(t.count),
): void {
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < t.count; i++) {
      const s = t.nbrStart[i];
      const e = t.nbrStart[i + 1];
      let sum = 0;
      for (let k = s; k < e; k++) sum += field[t.nbr[k]];
      scratch[i] = weight * field[i] + (1 - weight) * (sum / (e - s));
    }
    field.set(scratch);
  }
}
