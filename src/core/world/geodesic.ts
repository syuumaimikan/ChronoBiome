import type { Topology } from './topology';

/**
 * Geodesic grid: an icosahedron subdivided `level` times and projected onto
 * the unit sphere. Its vertices are the simulation cells (12 have 5
 * neighbours, the rest 6). The triangles are kept so the renderer can draw
 * each cell as the polygon of the dual (hexagons + 12 pentagons).
 */
export interface GeodesicMesh extends Topology {
  readonly level: number;
  /** Triangles of the primal mesh, vertex (= cell) indices. */
  readonly faces: Uint32Array;
  /** Unit-sphere centroid of each triangle: the corners of the dual polygons. */
  readonly faceCenter: Float32Array;
  /**
   * CSR list of the triangles around each cell in counter-clockwise order seen
   * from outside the sphere: ring[ringStart[i] .. ringStart[i+1]).
   */
  readonly ringStart: Int32Array;
  readonly ring: Int32Array;
}

export function cellCountForLevel(level: number): number {
  return 10 * 4 ** level + 2;
}

export function buildGeodesic(level: number, radiusKm = 6371): GeodesicMesh {
  if (!Number.isInteger(level) || level < 0 || level > 8) throw new Error(`grid level out of range: ${level}`);
  const vCount = cellCountForLevel(level);

  // ---- icosahedron
  const t = (1 + Math.sqrt(5)) / 2;
  const P = new Float64Array(vCount * 3);
  let nv = 0;
  const addVertex = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z);
    P[nv * 3] = x / l;
    P[nv * 3 + 1] = y / l;
    P[nv * 3 + 2] = z / l;
    return nv++;
  };
  for (const [x, y, z] of [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]) addVertex(x, y, z);

  let faces = new Uint32Array([
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ]);

  // ---- subdivision with a shared midpoint cache per round
  for (let l = 0; l < level; l++) {
    const cache = new Map<number, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? a * vCount + b : b * vCount + a;
      let m = cache.get(key);
      if (m === undefined) {
        m = addVertex(P[a * 3] + P[b * 3], P[a * 3 + 1] + P[b * 3 + 1], P[a * 3 + 2] + P[b * 3 + 2]);
        cache.set(key, m);
      }
      return m;
    };
    const next = new Uint32Array(faces.length * 4);
    let o = 0;
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.set([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca], o);
      o += 12;
    }
    faces = next;
  }
  if (nv !== vCount) throw new Error(`geodesic vertex count mismatch ${nv} != ${vCount}`);

  const fCount = faces.length / 3;
  const pos = Float32Array.from(P);
  const lat = new Float32Array(vCount);
  const lon = new Float32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    lat[i] = Math.asin(Math.max(-1, Math.min(1, P[i * 3 + 1])));
    lon[i] = Math.atan2(P[i * 3 + 2], P[i * 3]);
  }

  // ---- face centroids
  const faceCenter = new Float32Array(fCount * 3);
  for (let f = 0; f < fCount; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const x = P[a] + P[b] + P[c];
    const y = P[a + 1] + P[b + 1] + P[c + 1];
    const z = P[a + 2] + P[b + 2] + P[c + 2];
    const len = Math.hypot(x, y, z);
    faceCenter[f * 3] = x / len;
    faceCenter[f * 3 + 1] = y / len;
    faceCenter[f * 3 + 2] = z / len;
  }

  // ---- incident faces per vertex (CSR), then sort each ring by angle
  const deg = new Int32Array(vCount);
  for (let k = 0; k < faces.length; k++) deg[faces[k]]++;
  const ringStart = new Int32Array(vCount + 1);
  for (let i = 0; i < vCount; i++) ringStart[i + 1] = ringStart[i] + deg[i];
  const ring = new Int32Array(ringStart[vCount]);
  const fill = ringStart.slice(0, vCount);
  for (let f = 0; f < fCount; f++) {
    for (let j = 0; j < 3; j++) ring[fill[faces[f * 3 + j]]++] = f;
  }

  // Neighbours: each vertex has exactly as many neighbours as incident faces.
  const nbrStart = ringStart.slice();
  const nbr = new Int32Array(ring.length);
  const angles = new Float64Array(8);
  const tmpF = new Int32Array(8);
  const tmpN = new Int32Array(8);
  const order = [0, 1, 2, 3, 4, 5, 6, 7];

  for (let i = 0; i < vCount; i++) {
    const nx = P[i * 3], ny = P[i * 3 + 1], nz = P[i * 3 + 2];
    // Tangent basis (u, w) with w = n × u, so increasing angle is CCW seen from outside.
    let ux: number, uy: number, uz: number;
    if (Math.abs(ny) < 0.9) { ux = -nz; uy = 0; uz = nx; } else { ux = 0; uy = nz; uz = -ny; }
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;

    const s = ringStart[i];
    const d = ringStart[i + 1] - s;
    // Sort faces by angle.
    for (let k = 0; k < d; k++) {
      const f = ring[s + k];
      const cx = faceCenter[f * 3], cy = faceCenter[f * 3 + 1], cz = faceCenter[f * 3 + 2];
      angles[k] = Math.atan2(cx * wx + cy * wy + cz * wz, cx * ux + cy * uy + cz * uz);
      tmpF[k] = f;
    }
    const ord = order.slice(0, d).sort((a, b) => angles[a] - angles[b]);
    for (let k = 0; k < d; k++) ring[s + k] = tmpF[ord[k]];

    // Neighbours: the vertex shared by consecutive faces in the ring (besides i).
    for (let k = 0; k < d; k++) {
      const f0 = ring[s + k];
      const f1 = ring[s + ((k + 1) % d)];
      let shared = -1;
      for (let a = 0; a < 3 && shared < 0; a++) {
        const va = faces[f0 * 3 + a];
        if (va === i) continue;
        for (let b = 0; b < 3; b++) if (faces[f1 * 3 + b] === va) { shared = va; break; }
      }
      if (shared < 0) throw new Error(`broken ring at vertex ${i}`);
      tmpN[k] = shared;
    }
    for (let k = 0; k < d; k++) nbr[s + k] = tmpN[k];
  }

  // Mean neighbour spacing.
  let sum = 0;
  for (let i = 0; i < vCount; i++) {
    for (let k = nbrStart[i]; k < nbrStart[i + 1]; k++) {
      const j = nbr[k];
      const dot = P[i * 3] * P[j * 3] + P[i * 3 + 1] * P[j * 3 + 1] + P[i * 3 + 2] * P[j * 3 + 2];
      sum += Math.acos(Math.min(1, dot));
    }
  }
  const spacingKm = (sum / nbr.length) * radiusKm;

  return { level, count: vCount, pos, lat, lon, nbrStart, nbr, radiusKm, spacingKm, faces, faceCenter, ringStart, ring };
}
