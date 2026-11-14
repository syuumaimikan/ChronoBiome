import type { TreeKind } from '../../core/rules/schema';

/**
 * Procedural low-poly models, built from a handful of primitives into flat
 * (non-indexed) triangle lists: one colour per triangle, no textures. Every
 * model is in a local frame with +Y up and +Z forward, base at the origin.
 */

export type RGB = [number, number, number];
type V3 = [number, number, number];

export interface Template {
  pos: Float32Array;
  col: Float32Array;
  /** Optional per-vertex animation part id (0 = rigid). */
  part?: Float32Array;
  /** Optional per-vertex pivot (xyz) for animated parts. */
  pivot?: Float32Array;
  vertexCount: number;
}

/** Small deterministic generator for model jitter. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hex(h: string): RGB {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function shade(c: RGB, k: number): RGB {
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
}

export class MeshBuilder {
  private readonly p: number[] = [];
  private readonly c: number[] = [];
  private readonly parts: number[] = [];
  private readonly pivots: number[] = [];
  part = 0;
  pivot: V3 = [0, 0, 0];

  tri(a: V3, b: V3, c: V3, col: RGB): void {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) {
      this.c.push(col[0], col[1], col[2]);
      this.parts.push(this.part);
      this.pivots.push(this.pivot[0], this.pivot[1], this.pivot[2]);
    }
  }

  /** Both windings, for thin sheets (leaves, blades, wings). */
  sheet(a: V3, b: V3, c: V3, col: RGB): void {
    this.tri(a, b, c, col);
    this.tri(a, c, b, shade(col, 0.85));
  }

  quad(a: V3, b: V3, c: V3, d: V3, col: RGB): void {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }

  /** Axis-aligned box centred at (cx, cy, cz). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: RGB): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const top = shade(col, 1.05), side = col, bottom = shade(col, 0.8);
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], top);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], bottom);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], side);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], side);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side);
  }

  /** Tapered prism between two points (trunks, limbs, legs). */
  limb(a: V3, b: V3, r0: number, r1: number, seg: number, col: RGB, capTop = true): void {
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
    const len = Math.hypot(ax, ay, az) || 1;
    const dx = ax / len, dy = ay / len, dz = az / len;
    // Perpendicular basis.
    let ux = -dz, uy = 0, uz = dx;
    if (Math.abs(dy) < 0.99) { ux = dz; uy = 0; uz = -dx; }
    else { ux = 1; uy = 0; uz = 0; }
    let ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    let vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    ul = Math.hypot(vx, vy, vz);
    vx /= ul; vy /= ul; vz /= ul;
    const ring = (o: V3, r: number, k: number): V3 => {
      const t = (k / seg) * Math.PI * 2;
      const cs = Math.cos(t) * r, sn = Math.sin(t) * r;
      return [o[0] + ux * cs + vx * sn, o[1] + uy * cs + vy * sn, o[2] + uz * cs + vz * sn];
    };
    for (let k = 0; k < seg; k++) {
      const p0 = ring(a, r0, k), p1 = ring(a, r0, k + 1), q0 = ring(b, r1, k), q1 = ring(b, r1, k + 1);
      const s = shade(col, 0.9 + 0.2 * ((k % 2) as number));
      this.quad(p0, p1, q1, q0, s);
      if (capTop && r1 > 0) this.tri(b, q0, q1, shade(col, 1.05));
    }
  }

  /** Cone with apex up. */
  cone(x: number, z: number, y0: number, h: number, r: number, seg: number, col: RGB, phase = 0): void {
    const apex: V3 = [x, y0 + h, z];
    for (let k = 0; k < seg; k++) {
      const t0 = ((k + phase) / seg) * Math.PI * 2, t1 = ((k + 1 + phase) / seg) * Math.PI * 2;
      const p0: V3 = [x + Math.cos(t0) * r, y0, z + Math.sin(t0) * r];
      const p1: V3 = [x + Math.cos(t1) * r, y0, z + Math.sin(t1) * r];
      this.tri(p1, p0, apex, shade(col, 0.88 + 0.24 * (k % 2)));
      this.tri(p0, p1, [x, y0, z], shade(col, 0.7));
    }
  }

  /** Jittered icosahedron (crowns, boulders, bodies). */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, col: RGB, rnd: () => number, jitter = 0.18): void {
    const v = ICO_V.map(([x, y, z]) => {
      const k = 1 + (rnd() * 2 - 1) * jitter;
      return [cx + x * rx * k, cy + y * ry * k, cz + z * rz * k] as V3;
    });
    for (let f = 0; f < ICO_F.length; f += 3) {
      const a = v[ICO_F[f]], b = v[ICO_F[f + 1]], c = v[ICO_F[f + 2]];
      // Light from above: upper faces slightly brighter.
      const up = (a[1] + b[1] + c[1]) / 3 - cy;
      this.tri(a, b, c, shade(col, 0.86 + 0.22 * Math.max(-1, Math.min(1, up / (ry || 1)))));
    }
  }

  build(): Template {
    const t: Template = {
      pos: new Float32Array(this.p),
      col: new Float32Array(this.c),
      vertexCount: this.p.length / 3,
    };
    if (this.parts.some((p) => p !== 0)) {
      t.part = new Float32Array(this.parts);
      t.pivot = new Float32Array(this.pivots);
    }
    return t;
  }
}

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V: V3[] = (() => {
  const raw: V3[] = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ];
  return raw.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l] as V3;
  });
})();
const ICO_F = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
  1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
  4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
];

// ---------------------------------------------------------------- vegetation

const BARK = hex('#5b4330');
const BARK_LIGHT = hex('#7a6248');

function conifer(lod: number, rnd: () => number): Template {
  const b = new MeshBuilder();
  const needle = hex('#2f5a37');
  if (lod === 0) {
    b.limb([0, 0, 0], [0, 2.4, 0], 0.3, 0.2, 5, BARK, false);
    b.cone(0, 0, 1.6, 3.8, 2.4, 7, needle, rnd());
    b.cone(0, 0, 3.7, 3.3, 1.85, 7, shade(needle, 1.06), rnd());
    b.cone(0, 0, 5.6, 3.1, 1.3, 6, shade(needle, 1.12), rnd());
  } else {
    b.cone(0, 0, 0.8, 8, 2.2, 5, needle);
  }
  return b.build();
}

function broadleaf(lod: number, rnd: () => number): Template {
  const b = new MeshBuilder();
  const leaf = hex('#4d8a3a');
  if (lod === 0) {
    b.limb([0, 0, 0], [0, 3.8, 0], 0.38, 0.26, 5, BARK, false);
    b.limb([0, 3.0, 0], [1.2, 4.8, 0.4], 0.18, 0.1, 4, BARK, false);
    b.blob(0, 5.4, 0, 2.9, 2.3, 2.9, leaf, rnd);
    b.blob(1.3, 6.3, 0.5, 1.9, 1.6, 1.9, shade(leaf, 1.08), rnd);
    b.blob(-1.0, 6.0, -0.7, 2.0, 1.7, 2.0, shade(leaf, 0.95), rnd);
  } else {
    b.limb([0, 0, 0], [0, 3.6, 0], 0.35, 0.3, 3, BARK, false);
    b.blob(0, 5.5, 0, 3.0, 2.6, 3.0, leaf, rnd, 0.1);
  }
  return b.build();
}

function birch(lod: number, rnd: () => number): Template {
  const b = new MeshBuilder();
  const leaf = hex('#8bb24e');
  const bark = hex('#e3ded0');
  b.limb([0, 0, 0], [0, 6.6, 0], 0.18, 0.11, lod === 0 ? 5 : 3, bark, false);
  if (lod === 0) {
    b.box(0, 1.6, 0.17, 0.2, 0.12, 0.04, hex('#3a3530'));
    b.box(0.17, 3.2, 0, 0.04, 0.1, 0.18, hex('#3a3530'));
    b.blob(0, 6.8, 0, 1.6, 2.6, 1.6, leaf, rnd);
    b.blob(0.4, 5.1, 0.3, 1.2, 1.5, 1.2, shade(leaf, 0.92), rnd);
  } else {
    b.blob(0, 6.4, 0, 1.6, 2.8, 1.6, leaf, rnd, 0.1);
  }
  return b.build();
}

function tropical(lod: number, rnd: () => number): Template {
  const b = new MeshBuilder();
  const leaf = hex('#2e6b2b');
  b.limb([0, 0, 0], [0, 11.5, 0], 0.55, 0.32, lod === 0 ? 6 : 4, BARK_LIGHT, false);
  if (lod === 0) {
    // Buttress roots.
    for (let k = 0; k < 4; k++) {
      const t = (k / 4) * Math.PI * 2 + 0.4;
      b.tri([Math.cos(t) * 1.4, 0, Math.sin(t) * 1.4], [0, 0, 0], [0, 2.2, 0], BARK_LIGHT);
      b.tri([0, 0, 0], [Math.cos(t) * 1.4, 0, Math.sin(t) * 1.4], [0, 2.2, 0], shade(BARK_LIGHT, 0.85));
    }
    b.blob(0, 12.2, 0, 4.4, 1.8, 4.4, leaf, rnd);
    b.blob(2.2, 11.2, 1.2, 2.6, 1.3, 2.6, shade(leaf, 1.1), rnd);
    b.blob(-1.9, 11.6, -1.3, 2.9, 1.4, 2.9, shade(leaf, 0.93), rnd);
  } else {
    b.blob(0, 12, 0, 4.6, 2.0, 4.6, leaf, rnd, 0.1);
  }
  return b.build();
}

function palm(lod: number, rnd: () => number): Template {
  const b = new MeshBuilder();
  const frond = hex('#4f8f3a');
  const trunk = hex('#8a6e4b');
  const bend = 0.6 + rnd() * 0.8;
  const pts: V3[] = [];
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    pts.push([bend * t * t * 1.6, t * 8.5, 0]);
  }
  for (let k = 0; k < 4; k++) b.limb(pts[k], pts[k + 1], 0.3 - k * 0.03, 0.27 - k * 0.03, lod === 0 ? 5 : 3, shade(trunk, 1 - k * 0.04), false);
  const top = pts[4];
  const n = lod === 0 ? 7 : 5;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2 + rnd() * 0.3;
    const cx = Math.cos(t), cz = Math.sin(t);
    const mid: V3 = [top[0] + cx * 1.6, top[1] + 0.5, top[2] + cz * 1.6];
    const tip: V3 = [top[0] + cx * 3.3, top[1] - 1.4, top[2] + cz * 3.3];
    const side: V3 = [-cz * 0.45, 0, cx * 0.45];
    b.sheet(top, [mid[0] + side[0], mid[1], mid[2] + side[2]], mid, frond);
    b.sheet(top, mid, [mid[0] - side[0], mid[1], mid[2] - side[2]], shade(frond, 0.9));
    b.sheet([mid[0] + side[0], mid[1], mid[2] + side[2]], tip, mid, shade(frond, 1.05));
    b.sheet(mid, tip, [mid[0] - side[0], mid[1], mid[2] - side[2]], shade(frond, 0.95));
  }
  return b.build();
}

function acacia(lod: number, rnd: () => number): Template {
  const b = new MeshBuilder();
  const leaf = hex('#7a8d3c');
  b.limb([0, 0, 0], [0.2, 2.6, 0], 0.26, 0.2, lod === 0 ? 5 : 3, BARK, false);
  if (lod === 0) {
    b.limb([0.2, 2.4, 0], [1.6, 3.8, 0.4], 0.16, 0.1, 4, BARK, false);
    b.limb([0.2, 2.4, 0], [-1.3, 3.7, -0.5], 0.16, 0.1, 4, BARK, false);
  }
  b.limb([0, 3.7, 0], [0, 4.5, 0], 3.9, 3.2, lod === 0 ? 8 : 6, leaf, true);
  if (lod === 0) b.blob(0.6, 4.6, 0.3, 2.0, 0.6, 1.8, shade(leaf, 1.08), rnd);
  return b.build();
}

function shrub(_lod: number, rnd: () => number): Template {
  const b = new MeshBuilder();
  const leaf = hex('#4b773a');
  b.blob(0, 0.6, 0, 1.0, 0.75, 1.0, leaf, rnd, 0.25);
  b.blob(0.6, 0.45, 0.35, 0.65, 0.5, 0.65, shade(leaf, 1.1), rnd, 0.25);
  return b.build();
}

function cactus(lod: number, _rnd: () => number): Template {
  const b = new MeshBuilder();
  const g = hex('#56884a');
  const seg = lod === 0 ? 6 : 4;
  b.limb([0, 0, 0], [0, 3.2, 0], 0.34, 0.3, seg, g, true);
  b.limb([0, 1.4, 0], [0.75, 1.5, 0], 0.18, 0.18, seg, g, false);
  b.limb([0.75, 1.45, 0], [0.8, 2.5, 0], 0.18, 0.15, seg, shade(g, 1.05), true);
  if (lod === 0) {
    b.limb([0, 2.0, 0], [-0.6, 2.1, 0.1], 0.16, 0.16, seg, g, false);
    b.limb([-0.6, 2.05, 0.1], [-0.65, 2.8, 0.1], 0.16, 0.13, seg, shade(g, 1.05), true);
  }
  return b.build();
}

function deadwood(lod: number, _rnd: () => number): Template {
  const b = new MeshBuilder();
  const wood = hex('#7d6e5c');
  b.limb([0, 0, 0], [0.1, 4.3, 0], 0.24, 0.1, lod === 0 ? 5 : 3, wood, true);
  b.limb([0.05, 2.2, 0], [1.2, 3.6, 0.3], 0.11, 0.04, 4, wood, true);
  if (lod === 0) b.limb([0.08, 3.0, 0], [-0.9, 4.0, -0.4], 0.09, 0.03, 4, wood, true);
  return b.build();
}

const TREE_BUILDERS: Record<TreeKind, (lod: number, rnd: () => number) => Template> = {
  conifer, broadleaf, birch, tropical, palm, acacia, shrub, cactus, deadwood,
};

/** Typical scale ranges per kind (multiplied by the template size). */
export const TREE_SCALE: Record<TreeKind, [number, number]> = {
  conifer: [0.8, 1.9],
  broadleaf: [0.8, 1.45],
  birch: [0.8, 1.3],
  tropical: [0.75, 1.5],
  palm: [0.8, 1.25],
  acacia: [0.8, 1.35],
  shrub: [0.6, 1.5],
  cactus: [0.6, 1.4],
  deadwood: [0.7, 1.3],
};

/** Distant silhouettes: crown base height, crown height, radius, colour; spiky crowns are cones. */
const FAR_TREE: Record<TreeKind, [number, number, number, string, boolean]> = {
  conifer: [0.4, 8.6, 2.3, '#2f5a37', true],
  broadleaf: [2.2, 6.0, 3.1, '#4d8a3a', false],
  birch: [3.2, 5.6, 1.7, '#8bb24e', false],
  tropical: [8.5, 6.5, 4.6, '#2e6b2b', false],
  palm: [6.5, 3.5, 3.2, '#4f8f3a', false],
  acacia: [3.2, 1.8, 3.9, '#7a8d3c', false],
  shrub: [0, 1.4, 1.2, '#4b773a', false],
  cactus: [0, 3.2, 0.45, '#56884a', true],
  deadwood: [0, 4.3, 0.5, '#7d6e5c', true],
};

function farTree(kind: TreeKind): Template {
  const [y0, h, r, colHex, spiky] = FAR_TREE[kind];
  const col = hex(colHex);
  const b = new MeshBuilder();
  const seg = 3;
  const ring = (k: number, y: number, rr: number): V3 => {
    const t = (k / seg) * Math.PI * 2;
    return [Math.cos(t) * rr, y, Math.sin(t) * rr];
  };
  if (spiky) {
    for (let k = 0; k < seg; k++) b.tri(ring(k + 1, y0, r), ring(k, y0, r), [0, y0 + h, 0], shade(col, 0.88 + 0.24 * (k % 2)));
  } else {
    const mid = y0 + h * 0.45;
    for (let k = 0; k < seg; k++) {
      b.tri(ring(k + 1, mid, r), ring(k, mid, r), [0, y0 + h, 0], shade(col, 0.95 + 0.15 * (k % 2)));
      b.tri(ring(k, mid, r), ring(k + 1, mid, r), [0, y0, 0], shade(col, 0.72));
    }
  }
  return b.build();
}

const VARIANTS = 3;
const treeCache = new Map<string, Template>();

/** Template for a kind, level of detail (0 near, 1 middle, 2 far silhouette) and variant. */
export function treeTemplate(kind: TreeKind, lod: number, variant: number): Template {
  const key = lod >= 2 ? `${kind}:far` : `${kind}:${lod}:${variant % VARIANTS}`;
  let t = treeCache.get(key);
  if (!t) {
    t = lod >= 2 ? farTree(kind) : TREE_BUILDERS[kind](lod, mulberry(0x51ed + (variant % VARIANTS) * 7919 + kind.length * 31));
    treeCache.set(key, t);
  }
  return t;
}

let rockCache: Template[] | null = null;
export function rockTemplate(variant: number): Template {
  if (!rockCache) {
    rockCache = [0, 1, 2, 3].map((v) => {
      const b = new MeshBuilder();
      const rnd = mulberry(901 + v * 13);
      const c = hex(['#7e786e', '#6f6b66', '#8a8172', '#77736a'][v]);
      b.blob(0, 0.25, 0, 1.0, 0.7, 0.85, c, rnd, 0.32);
      if (v % 2 === 0) b.blob(0.7, 0.15, 0.4, 0.5, 0.4, 0.45, shade(c, 0.95), rnd, 0.3);
      return b.build();
    });
  }
  return rockCache[variant % rockCache.length];
}

let grassCache: Template[] | null = null;
/** Grass tuft; colour is a neutral green that is tinted toward the ground colour per instance. */
export function grassTemplate(variant: number): Template {
  if (!grassCache) {
    grassCache = [0, 1, 2].map((v) => {
      const b = new MeshBuilder();
      const rnd = mulberry(4242 + v * 17);
      const blades = 4 + v;
      for (let k = 0; k < blades; k++) {
        const t = (k / blades) * Math.PI * 2 + rnd();
        const r = 0.08 + rnd() * 0.12;
        const bx = Math.cos(t) * r, bz = Math.sin(t) * r;
        const h = 0.35 + rnd() * 0.45;
        const lean = 0.15 + rnd() * 0.2;
        const w = 0.05;
        const tipCol: RGB = [0.75 + rnd() * 0.1, 0.85, 0.55];
        b.sheet([bx - Math.sin(t) * w, 0, bz + Math.cos(t) * w], [bx + Math.sin(t) * w, 0, bz - Math.cos(t) * w], [bx + Math.cos(t) * lean, h, bz + Math.sin(t) * lean], tipCol);
      }
      if (v === 2) {
        const fc: RGB = [[1, 0.95, 0.5], [0.95, 0.95, 1], [0.8, 0.55, 0.95]][Math.floor(rnd() * 3)] as RGB;
        b.sheet([-0.06, 0.55, 0], [0.06, 0.55, 0], [0, 0.62, 0.06], fc);
      }
      return b.build();
    });
  }
  return grassCache[variant % grassCache.length];
}
