/**
 * Cube-sphere parameterisation for the surface quadtree. Each of the six cube
 * faces is a square [-1, 1]² that is subdivided as a quadtree; a tangent warp
 * keeps cells close to equal area. Faces are oriented so that U × V points
 * outward, so (i, j) grids are counter-clockwise seen from space.
 */

// normal, U, V for +X, -X, +Y, -Y, +Z, -Z
const FACE = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, -1, 0, 0, 0, 1, 0],
] as const;

const QUARTER_PI = Math.PI / 4;

/** Unit vector for face parameters u, v ∈ [-1, 1]. Writes into `out` (length ≥ 3). */
export function faceToDir(face: number, u: number, v: number, out: Float64Array | number[]): void {
  const f = FACE[face];
  const a = Math.tan(u * QUARTER_PI);
  const b = Math.tan(v * QUARTER_PI);
  const x = f[0] + a * f[3] + b * f[6];
  const y = f[1] + a * f[4] + b * f[7];
  const z = f[2] + a * f[5] + b * f[8];
  const l = 1 / Math.sqrt(x * x + y * y + z * z);
  out[0] = x * l;
  out[1] = y * l;
  out[2] = z * l;
}

export interface FacePoint {
  face: number;
  u: number;
  v: number;
}

/** Inverse of faceToDir. */
export function dirToFace(x: number, y: number, z: number, out: FacePoint): FacePoint {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face: number;
  if (ax >= ay && ax >= az) face = x > 0 ? 0 : 1;
  else if (ay >= az) face = y > 0 ? 2 : 3;
  else face = z > 0 ? 4 : 5;
  const f = FACE[face];
  const n = x * f[0] + y * f[1] + z * f[2];
  const a = (x * f[3] + y * f[4] + z * f[5]) / n;
  const b = (x * f[6] + y * f[7] + z * f[8]) / n;
  out.face = face;
  out.u = Math.atan(a) / QUARTER_PI;
  out.v = Math.atan(b) / QUARTER_PI;
  return out;
}

/** Numeric key of a quadtree node (level ≤ 20). */
export function nodeKey(face: number, level: number, x: number, y: number): number {
  return ((face * 21 + level) * 1_048_576 + x) * 1_048_576 + y;
}

/** Approximate edge length (m) of a node at `level` on a planet of radius `radiusM`. */
export function nodeSizeM(level: number, radiusM: number): number {
  return ((Math.PI / 2) * radiusM) / 2 ** level;
}
