import type { TreeKind } from '../../core/rules/schema';
import { Noise3 } from '../../core/noise';
import { autoVegetation, type BiomeLook } from './looks';
import { grassTemplate, rockTemplate, TREE_SCALE, treeTemplate, type Template } from './models';

/**
 * Vegetation scattering for one terrain chunk.
 *
 * Candidate spots lie on a grid fixed to the cube-sphere faces, and every
 * decision about a spot comes from a hash of its grid index, so a tree is the
 * same tree whichever chunk (level of detail) draws it. Coarse chunks draw
 * only the spots with a low rank, so forests thin out with distance instead
 * of popping, and the nearest chunks also get grass.
 */

/** Tree candidates per cube-face side (≈ 6.4 m apart on an Earth-sized planet). */
export const VEG_GRID = 3 * 2 ** 19;
/** Lowest chunk level that carries vegetation. */
export const VEG_MIN_LEVEL = 13;
const MAX_VERTS = 240_000;

export interface VegChunk {
  face: number;
  level: number;
  x: number;
  y: number;
  /** Vertex grid size (quads per side). */
  n: number;
  /** Datum-relative heights, (n+1)² row-major (j * (n+1) + i). */
  heights: Float32Array;
  /** Unit directions of the grid vertices (float64), 3 per vertex. */
  dirs: Float64Array;
  biome: Uint8Array;
  temp: Float32Array;
  /** Gradient magnitude (rise / run). */
  slope: Float32Array;
  center: [number, number, number];
  radiusM: number;
  seaLevel: number;
}

export interface VegContext {
  seed: number;
  looks: BiomeLook[];
  patch: Noise3;
}

export function makeVegContext(seed: number, looks: BiomeLook[]): VegContext {
  return { seed, looks, patch: new Noise3((seed ^ 0x7a3b11) >>> 0) };
}

/** Share of candidates drawn at each level (rank threshold). */
function keepFor(level: number): number {
  if (level >= 16) return 1;
  if (level === 15) return 0.35;
  if (level === 14) return 0.12;
  if (level === 13) return 0.045;
  return 0;
}

function hash4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(b ^ 0x9e3779b9, 0x85ebca77) ^ Math.imul(c ^ 0xc2b2ae3d, 0x27d4eb2f) ^ d;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Cheap stream of floats from one hash. */
class Stream {
  private s = 0;
  reset(seed: number): void {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

class Sink {
  pos: Float32Array;
  col: Uint8Array;
  count = 0;
  constructor(cap: number) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Uint8Array(cap * 3);
  }
  ensure(extra: number): boolean {
    const need = this.count + extra;
    if (need > MAX_VERTS) return false;
    if (need * 3 > this.pos.length) {
      const cap = Math.min(MAX_VERTS, Math.max(need, (this.pos.length / 3) * 2));
      const p = new Float32Array(cap * 3);
      p.set(this.pos.subarray(0, this.count * 3));
      const c = new Uint8Array(cap * 3);
      c.set(this.col.subarray(0, this.count * 3));
      this.pos = p;
      this.col = c;
    }
    return true;
  }
}

const tmpUp = new Float64Array(3);
const tmpE = new Float64Array(3);
const tmpN = new Float64Array(3);
const tmpP = new Float64Array(3);
const stream = new Stream();

export interface VegMesh {
  pos: Float32Array;
  col: Uint8Array;
  vertexCount: number;
}

export interface VegBuild {
  /** Trees and boulders. */
  plants: VegMesh | null;
  /** Grass tufts (finest chunks only; drawn close to the camera). */
  grass: VegMesh | null;
}

export function buildVegetation(ch: VegChunk, ctx: VegContext): VegBuild {
  if (ch.level < VEG_MIN_LEVEL) return { plants: null, grass: null };
  const plants = buildPlants(ch, ctx);
  let grass: VegMesh | null = null;
  if (ch.level >= 16) {
    const sink = new Sink(8192);
    addGrass(ch, ctx, sink);
    grass = finish(sink);
  }
  return { plants, grass };
}

function buildPlants(ch: VegChunk, ctx: VegContext): VegMesh | null {
  const keep = keepFor(ch.level);
  const cells = VEG_GRID / 2 ** ch.level;
  const gx0 = ch.x * cells;
  const gy0 = ch.y * cells;
  const n = ch.n;
  const lod = ch.level >= 16 ? 0 : ch.level === 15 ? 1 : 2;
  const sink = new Sink(8192);
  const seed = ctx.seed | 0;
  const R = ch.radiusM;
  const sea = ch.seaLevel;

  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const h0 = hash4(ch.face, gx0 + gx, gy0 + gy, seed);
      const rank = h0 / 4294967296;
      if (rank >= keep) continue;
      stream.reset(h0);
      const fu = ((gx + stream.next()) / cells) * n;
      const fv = ((gy + stream.next()) / cells) * n;
      const vi = Math.min(n, Math.round(fu)) + Math.min(n, Math.round(fv)) * (n + 1);
      const look = ctx.looks[ch.biome[vi]];
      if (!look) continue;
      if (!surfacePoint(ch, fu, fv, tmpP, tmpUp)) continue;
      const height = Math.hypot(tmpP[0], tmpP[1], tmpP[2]) - R;
      if (height < sea + 0.6) continue;
      const temp = ch.temp[vi];
      const slope = ch.slope[vi];

      // Forest patches and clearings.
      const px = tmpUp[0] * (R / 420), py = tmpUp[1] * (R / 420), pz = tmpUp[2] * (R / 420);
      const patch = 0.5 + 0.5 * ctx.patch.sample(px, py, pz);
      let density = look.treeDensity;
      let kind: TreeKind | null = null;
      const roll = stream.next();
      if (look.auto) {
        const a = autoVegetation(temp, 0.5);
        density = a.density;
        kind = a.kind;
      } else if (look.trees.length) {
        const k = stream.next();
        let idx = 0;
        while (idx < look.treeCum.length - 1 && k > look.treeCum[idx]) idx++;
        kind = look.trees[idx];
      }
      const cold = kind === 'shrub' ? -9 : -2.5;
      const slopeOk = 1 - smooth(0.55, 1.0, slope);
      const pTree = density * (0.2 + 0.8 * smooth(0.25, 0.75, patch)) * slopeOk * (temp > cold ? 1 : 0);
      tangentFrame(tmpUp, tmpE, tmpN, stream.next() * Math.PI * 2);

      if (kind && roll < pTree) {
        const [s0, s1] = TREE_SCALE[kind];
        const scale = s0 + (s1 - s0) * stream.next();
        const t = treeTemplate(kind, lod, Math.floor(stream.next() * 3));
        const tint = 0.82 + 0.34 * stream.next();
        const warmShift = (stream.next() - 0.5) * 0.12;
        if (!emit(sink, t, tmpP, tmpUp, tmpE, tmpN, ch.center, scale, tint, warmShift, null)) return finish(sink);
        continue;
      }
      // Boulders: a few everywhere, many on steep or rocky ground.
      const pRock = (look.rocks * 0.25 + 0.5 * smooth(0.6, 1.2, slope)) * (lod === 0 ? 1 : lod === 1 ? 0.4 : 0.1);
      if (stream.next() < pRock) {
        const scale = 0.35 + 2.0 * stream.next() ** 2;
        const t = rockTemplate(Math.floor(stream.next() * 4));
        const sunk = tmpP;
        sunk[0] -= tmpUp[0] * scale * 0.18; sunk[1] -= tmpUp[1] * scale * 0.18; sunk[2] -= tmpUp[2] * scale * 0.18;
        if (!emit(sink, t, sunk, tmpUp, tmpE, tmpN, ch.center, scale, 0.85 + 0.3 * stream.next(), 0, null)) return finish(sink);
      }
    }
  }
  return finish(sink);
}

/** Grass tufts on the finest chunks, on a grid twice as fine as the trees. */
function addGrass(ch: VegChunk, ctx: VegContext, sink: Sink): void {
  const cells = (VEG_GRID * 2) / 2 ** ch.level;
  const gx0 = ch.x * cells;
  const gy0 = ch.y * cells;
  const n = ch.n;
  const R = ch.radiusM;
  const sea = ch.seaLevel;
  const seed = (ctx.seed ^ 0x5bd1e995) | 0;
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const h0 = hash4(ch.face + 8, gx0 + gx, gy0 + gy, seed);
      stream.reset(h0);
      const fu = ((gx + stream.next()) / cells) * n;
      const fv = ((gy + stream.next()) / cells) * n;
      const vi = Math.min(n, Math.round(fu)) + Math.min(n, Math.round(fv)) * (n + 1);
      const look = ctx.looks[ch.biome[vi]];
      if (!look) continue;
      const temp = ch.temp[vi];
      const grass = look.auto ? autoVegetation(temp, 0.5).grass : look.grass;
      if (grass <= 0 || temp < -5) continue;
      const slopeOk = 1 - smooth(0.5, 0.95, ch.slope[vi]);
      if (stream.next() >= grass * 0.75 * slopeOk) continue;
      if (!surfacePoint(ch, fu, fv, tmpP, tmpUp)) continue;
      if (Math.hypot(tmpP[0], tmpP[1], tmpP[2]) - R < sea + 0.3) continue;
      tangentFrame(tmpUp, tmpE, tmpN, stream.next() * Math.PI * 2);
      const t = grassTemplate(Math.floor(stream.next() * 3));
      const g = look.ground;
      // Blend the blade colour toward the ground colour so meadows match the terrain.
      const mix: [number, number, number] = [g[0] * 1.25, g[1] * 1.3, g[2] * 1.05];
      if (!emit(sink, t, tmpP, tmpUp, tmpE, tmpN, ch.center, 0.8 + 0.7 * stream.next(), 1, 0, mix)) return;
    }
  }
}

function finish(sink: Sink): VegMesh | null {
  if (sink.count === 0) return null;
  return { pos: sink.pos.slice(0, sink.count * 3), col: sink.col.slice(0, sink.count * 3), vertexCount: sink.count };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * World position (float64) of the mesh surface at fractional grid
 * coordinates, interpolated on the same triangles the terrain draws.
 */
function surfacePoint(ch: VegChunk, fu: number, fv: number, outP: Float64Array, outUp: Float64Array): boolean {
  const n = ch.n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(fu)));
  const j = Math.min(n - 1, Math.max(0, Math.floor(fv)));
  const s = fu - i, t = fv - j;
  const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
  let wa: number, wb: number, wc: number, wd: number;
  if (s >= t) { wa = 1 - s; wb = s - t; wc = t; wd = 0; }
  else { wa = 1 - t; wb = 0; wc = s; wd = t - s; }
  const R = ch.radiusM;
  let x = 0, y = 0, z = 0;
  const add = (v: number, w: number) => {
    if (w === 0) return;
    const r = R + ch.heights[v];
    x += w * ch.dirs[v * 3] * r;
    y += w * ch.dirs[v * 3 + 1] * r;
    z += w * ch.dirs[v * 3 + 2] * r;
  };
  add(a, wa); add(b, wb); add(c, wc); add(d, wd);
  const l = Math.hypot(x, y, z);
  if (!(l > 0)) return false;
  outP[0] = x; outP[1] = y; outP[2] = z;
  outUp[0] = x / l; outUp[1] = y / l; outUp[2] = z / l;
  return true;
}

/** East/north basis at `up`, rotated by `yaw` about it. */
export function tangentFrame(up: Float64Array, e: Float64Array, nrt: Float64Array, yaw: number): void {
  // east = up × Y (fallback X near the poles)
  let ex = -up[2], ey = 0, ez = up[0];
  let l = Math.hypot(ex, ey, ez);
  if (l < 1e-6) { ex = 0; ey = 0; ez = 1; l = 1; }
  ex /= l; ey /= l; ez /= l;
  // north = east × up, so (east, up, north) is right-handed like (x, y, z)
  const nx = ey * up[2] - ez * up[1];
  const ny = ez * up[0] - ex * up[2];
  const nz = ex * up[1] - ey * up[0];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  e[0] = ex * c + nx * s; e[1] = ey * c + ny * s; e[2] = ez * c + nz * s;
  nrt[0] = nx * c - ex * s; nrt[1] = ny * c - ey * s; nrt[2] = nz * c - ez * s;
}

/** Append a transformed template: local (x, y, z) → e·x + up·y + n·z, relative to the chunk centre. */
function emit(
  sink: Sink, t: Template, base: Float64Array, up: Float64Array, e: Float64Array, nrt: Float64Array,
  center: [number, number, number], scale: number, tint: number, warm: number, mix: [number, number, number] | null,
): boolean {
  if (!sink.ensure(t.vertexCount)) return false;
  const bx = base[0] - center[0], by = base[1] - center[1], bz = base[2] - center[2];
  const P = sink.pos, C = sink.col;
  let o = sink.count * 3;
  const tp = t.pos, tc = t.col;
  for (let v = 0; v < t.vertexCount; v++) {
    const x = tp[v * 3] * scale, y = tp[v * 3 + 1] * scale, z = tp[v * 3 + 2] * scale;
    P[o] = bx + e[0] * x + up[0] * y + nrt[0] * z;
    P[o + 1] = by + e[1] * x + up[1] * y + nrt[1] * z;
    P[o + 2] = bz + e[2] * x + up[2] * y + nrt[2] * z;
    let r = tc[v * 3] * tint, g = tc[v * 3 + 1] * tint, b = tc[v * 3 + 2] * tint;
    if (mix) { r *= mix[0]; g *= mix[1]; b *= mix[2]; }
    r += warm; b -= warm;
    C[o] = Math.max(0, Math.min(255, r * 255));
    C[o + 1] = Math.max(0, Math.min(255, g * 255));
    C[o + 2] = Math.max(0, Math.min(255, b * 255));
    o += 3;
  }
  sink.count += t.vertexCount;
  return true;
}
