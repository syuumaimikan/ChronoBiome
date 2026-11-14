import * as THREE from 'three';
import { Noise3 } from '../../core/noise';
import { faceToDir, nodeKey, nodeSizeM } from './cube';
import type { BiomeLook } from './looks';
import { newSample, type SurfaceSampler } from './sampler';
import { buildVegetation, makeVegContext, VEG_MIN_LEVEL, type VegContext } from './vegetation';

/**
 * Seamless level-of-detail terrain on a cube-sphere quadtree. From orbit the
 * six root chunks show the whole planet; walking on the ground, chunks of a
 * few metres per triangle surround the player. Chunks are generated on the
 * main thread within a per-frame time budget, nearest first; a parent stays
 * visible until all four children are ready, so there are never holes.
 *
 * Positions are stored relative to each chunk's centre and the chunk mesh
 * sits at its true world position: three.js composes the model-view matrix
 * in float64 on the CPU, so the ground does not jitter even 6 371 km from
 * the planet's centre.
 */

export const CHUNK_N = 32;
export const MAX_LEVEL = 16;
const SPLIT_K = 1.45;
/** Split distance (in node sizes) for chunks outside the view. */
const SPLIT_OUT = 0.7;
/** Split distance into the finest level (full-detail trees). */
const SPLIT_LAST = 1.0;
/** Grass is drawn on chunks closer than this (m). */
const GRASS_DIST = 90;
const MAX_CHUNKS = 900;
const G = (CHUNK_N + 1) * (CHUNK_N + 1);
const PERIM = 4 * CHUNK_N;

interface Chunk {
  key: number;
  face: number;
  level: number;
  x: number;
  y: number;
  center: THREE.Vector3;
  radius: number;
  /** Highest point (m, datum-relative); unknown before the first build. */
  top: number;
  built: boolean;
  version: number;
  lastUsed: number;
  group: THREE.Group | null;
}

/** Shared index buffers (copied per geometry: three.js frees index buffers with their geometry). */
const GRID_INDEX = (() => {
  const n = CHUNK_N;
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  // Skirts: both windings, so they hide cracks from any side.
  const perim = perimeter();
  for (let k = 0; k < PERIM; k++) {
    const a = perim[k], b = perim[(k + 1) % PERIM];
    const a2 = G + k, b2 = G + ((k + 1) % PERIM);
    idx.push(a, b2, b, a, a2, b2, a, b, b2, a, b2, a2);
  }
  return new Uint16Array(idx);
})();

function perimeter(): number[] {
  const n = CHUNK_N;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  for (let j = 0; j < n; j++) out.push(j * (n + 1) + n);
  for (let i = n; i > 0; i--) out.push(n * (n + 1) + i);
  for (let j = n; j > 0; j--) out.push(j * (n + 1));
  return out;
}
const PERIMETER = perimeter();

const ROCK = [0.49, 0.47, 0.44];
const SNOW = [0.93, 0.95, 0.97];
const SAND = [0.85, 0.79, 0.6];
const SEABED_SHALLOW = [0.76, 0.7, 0.52];
const SEABED_DEEP = [0.2, 0.26, 0.32];

export interface TerrainStats {
  chunks: number;
  visible: number;
  pending: number;
  buildMs: number;
  /** Finest level among the visible chunks. */
  maxLevel: number;
}

export class SurfaceTerrain {
  readonly group = new THREE.Group();
  readonly uniforms = { uExag: { value: 1 }, uTime: { value: 0 }, uRadius: { value: 6.371e6 } };
  private readonly material: THREE.MeshLambertMaterial;
  private readonly waterMaterial: THREE.MeshPhongMaterial;
  private readonly vegMaterial: THREE.MeshLambertMaterial;
  private readonly chunks = new Map<number, Chunk>();
  private frame = 0;
  private version = 0;
  private sampler: SurfaceSampler | null = null;
  private looks: BiomeLook[] = [];
  private cellRgb: Uint8Array | null = null;
  private veg: VegContext | null = null;
  private colorNoise = new Noise3(77);
  private readonly sample = newSample();
  private readonly tmpDir = new Float64Array(3);
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private horizonCam = 0;
  stats: TerrainStats = { chunks: 0, visible: 0, pending: 0, buildMs: 0, maxLevel: 0 };
  /** Vegetation and fauna are pointless when the relief is exaggerated (high altitude). */
  vegetationVisible = true;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uExag = this.uniforms.uExag;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aLift;\nuniform float uExag;\nvarying vec3 vUpView;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += aLift.xyz * (aLift.w * (uExag - 1.0));\nvUpView = normalMatrix * aLift.xyz;');
      // Skirts (the only vertical faces) are lit like level ground, so chunk seams do not show as lines.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vUpView;')
        .replace(
          '#include <normal_fragment_begin>',
          '#include <normal_fragment_begin>\n{ vec3 upV = normalize(vUpView); if (abs(dot(normal, upV)) < 0.12) normal = upV; }',
        );
      flatColors(shader);
    };
    this.waterMaterial = new THREE.MeshPhongMaterial({
      vertexColors: true, flatShading: true, transparent: true, opacity: 0.8, shininess: 70, specular: 0x6688aa,
    });
    this.waterMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uRadius = this.uniforms.uRadius;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aWave;\nuniform float uTime;\nuniform float uRadius;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          if (aWave.w > 0.0) {
            vec3 q = aWave.xyz * (uRadius / 23.0);
            float w = sin(q.x + q.y * 0.7 + uTime * 1.3) + sin(q.z * 1.3 - q.x * 0.4 + uTime * 0.9);
            transformed += aWave.xyz * (w * 0.22 * aWave.w);
          }`,
        );
    };
    this.vegMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  }

  /** New world data: every chunk is rebuilt (stale ones stay visible meanwhile). */
  setData(sampler: SurfaceSampler, looks: BiomeLook[], seed: number, cellRgb: Uint8Array | null): void {
    const first = !this.sampler || this.sampler.radiusM !== sampler.radiusM;
    this.sampler = sampler;
    this.looks = looks;
    this.cellRgb = cellRgb;
    this.veg = makeVegContext(seed, looks);
    this.colorNoise = new Noise3((seed ^ 0x1234567) >>> 0);
    this.uniforms.uRadius.value = sampler.radiusM;
    this.version++;
    if (first) this.clear();
    // Roots are cheap (no detail octaves) and guarantee full coverage at once.
    for (let f = 0; f < 6; f++) this.buildChunk(this.getChunk(f, 0, 0, 0));
  }

  get ready(): boolean {
    return this.sampler !== null;
  }

  clear(): void {
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
  }

  /** Forget the world (a new one is being generated). */
  reset(): void {
    this.clear();
    this.sampler = null;
  }

  /** Select chunks for this camera and build what is missing within `budgetMs`. */
  update(camera: THREE.Camera, budgetMs: number): void {
    if (!this.sampler) return;
    this.frame++;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const cam = camera.position;
    const S = this.sampler;
    const hc = Math.max(1, cam.length() - S.radiusM - Math.max(0, S.seaLevel));
    this.horizonCam = Math.sqrt(2 * S.radiusM * hc + hc * hc);
    const wanted: Chunk[] = [];
    const visible: Chunk[] = [];
    for (let f = 0; f < 6; f++) this.select(this.getChunk(f, 0, 0, 0), cam, wanted, visible);

    for (const c of this.chunks.values()) if (c.group) c.group.visible = false;
    for (const c of visible) {
      const g = c.group!;
      g.visible = true;
      g.children[2].visible = this.vegetationVisible;
      g.children[3].visible = this.vegetationVisible && cam.distanceTo(c.center) - c.radius < GRASS_DIST;
    }

    // Build: missing chunks first (nearest, coarsest), then stale ones.
    const t0 = performance.now();
    const score = (c: Chunk) => {
      const d = Math.max(0, cam.distanceTo(c.center) - c.radius);
      return d / nodeSizeM(c.level, this.sampler!.radiusM) + (c.built ? 1000 : 0);
    };
    for (const c of visible) if (c.version !== this.version) wanted.push(c);
    wanted.sort((a, b) => score(a) - score(b));
    let built = 0;
    for (const c of wanted) {
      if (c.built && c.version === this.version) continue;
      if (performance.now() - t0 > budgetMs && built > 0) break;
      this.buildChunk(c);
      built++;
    }
    const ms = performance.now() - t0;
    let maxLevel = 0;
    for (const c of visible) maxLevel = Math.max(maxLevel, c.level);
    this.stats = { chunks: this.chunks.size, visible: visible.length, pending: Math.max(0, wanted.length - built), buildMs: ms, maxLevel };
    if (this.chunks.size > MAX_CHUNKS) this.evict();
  }

  private select(c: Chunk, cam: THREE.Vector3, wanted: Chunk[], visible: Chunk[]): boolean {
    c.lastUsed = this.frame;
    if (!c.built) {
      wanted.push(c);
      return false;
    }
    const R = this.sampler!.radiusM;
    const size = nodeSizeM(c.level, R);
    const dist = Math.max(0, cam.distanceTo(c.center) - c.radius);
    // Beyond the horizon: neither drawn nor refined.
    if (c.level > 0) {
      const top = Math.max(0, c.top - this.sampler!.seaLevel) * this.uniforms.uExag.value;
      if (dist > this.horizonCam + Math.sqrt(2 * R * top + top * top)) return true;
    }
    // Full detail only where the camera looks; around and behind it just enough to turn quickly.
    this.sphere.center.copy(c.center);
    this.sphere.radius = c.radius * 1.1 + size * 0.1;
    let k = this.frustum.intersectsSphere(this.sphere) ? SPLIT_K : SPLIT_OUT;
    if (c.level === MAX_LEVEL - 1) k = Math.min(k, SPLIT_LAST);
    if (c.level < MAX_LEVEL && dist < k * size) {
      const kids = this.children(c);
      let ready = true;
      for (const k of kids) {
        k.lastUsed = this.frame;
        if (!k.built) { ready = false; wanted.push(k); }
      }
      if (ready) {
        for (const k of kids) this.select(k, cam, wanted, visible);
        return true;
      }
    }
    visible.push(c);
    return true;
  }

  private children(c: Chunk): Chunk[] {
    const l = c.level + 1, x = c.x * 2, y = c.y * 2;
    return [this.getChunk(c.face, l, x, y), this.getChunk(c.face, l, x + 1, y), this.getChunk(c.face, l, x, y + 1), this.getChunk(c.face, l, x + 1, y + 1)];
  }

  private getChunk(face: number, level: number, x: number, y: number): Chunk {
    const key = nodeKey(face, level, x, y);
    let c = this.chunks.get(key);
    if (!c) {
      const R = this.sampler!.radiusM;
      const size = 2 / 2 ** level;
      faceToDir(face, -1 + (x + 0.5) * size, -1 + (y + 0.5) * size, this.tmpDir);
      const r = R + this.sampler!.seaLevel;
      c = {
        key, face, level, x, y,
        center: new THREE.Vector3(this.tmpDir[0] * r, this.tmpDir[1] * r, this.tmpDir[2] * r),
        radius: nodeSizeM(level, R) * 0.8,
        top: 9000,
        built: false, version: -1, lastUsed: this.frame, group: null,
      };
      this.chunks.set(key, c);
    }
    return c;
  }

  private evict(): void {
    const old = [...this.chunks.values()].filter((c) => c.lastUsed < this.frame - 2 && c.level > 0).sort((a, b) => a.lastUsed - b.lastUsed);
    const drop = this.chunks.size - MAX_CHUNKS * 0.85;
    for (let k = 0; k < drop && k < old.length; k++) {
      this.disposeChunk(old[k]);
      this.chunks.delete(old[k].key);
    }
  }

  private disposeChunk(c: Chunk): void {
    if (!c.group) return;
    this.group.remove(c.group);
    for (const m of c.group.children) (m as Partial<THREE.Mesh>).geometry?.dispose();
    c.group = null;
    c.built = false;
  }

  /** Generate the meshes of one chunk. */
  private buildChunk(c: Chunk): void {
    const S = this.sampler!;
    const R = S.radiusM;
    const sea = S.seaLevel;
    const n = CHUNK_N;
    const size = 2 / 2 ** c.level;
    const u0 = -1 + c.x * size, v0 = -1 + c.y * size;
    const spacing = nodeSizeM(c.level, R) / n;
    const minWave = spacing * 2;
    const s = this.sample;

    const dirs = new Float64Array(G * 3);
    const heights = new Float32Array(G);
    const biome = new Uint8Array(G);
    const temp = new Float32Array(G);
    const cells = new Int32Array(G);
    const d = this.tmpDir;
    let minH = Infinity, maxH = -Infinity;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const v = j * (n + 1) + i;
        faceToDir(c.face, u0 + (size * i) / n, v0 + (size * j) / n, d);
        S.sample(d[0], d[1], d[2], minWave, s);
        dirs[v * 3] = d[0]; dirs[v * 3 + 1] = d[1]; dirs[v * 3 + 2] = d[2];
        heights[v] = s.height;
        biome[v] = s.biome;
        temp[v] = s.temp;
        cells[v] = s.cell;
        if (s.height < minH) minH = s.height;
        if (s.height > maxH) maxH = s.height;
      }
    }

    // Chunk centre on the mean surface; vertex positions relative to it.
    faceToDir(c.face, u0 + size / 2, v0 + size / 2, d);
    const midR = R + Math.max(sea, (minH + maxH) / 2);
    const cx = d[0] * midR, cy = d[1] * midR, cz = d[2] * midR;
    c.center.set(cx, cy, cz);

    const slope = new Float32Array(G);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const v = j * (n + 1) + i;
        const il = Math.max(0, i - 1), ir = Math.min(n, i + 1), jd = Math.max(0, j - 1), ju = Math.min(n, j + 1);
        const gx = (heights[j * (n + 1) + ir] - heights[j * (n + 1) + il]) / ((ir - il) * spacing);
        const gy = (heights[ju * (n + 1) + i] - heights[jd * (n + 1) + i]) / ((ju - jd) * spacing);
        slope[v] = Math.hypot(gx, gy);
      }
    }

    const vCount = G + PERIM;
    const pos = new Float32Array(vCount * 3);
    const lift = new Float32Array(vCount * 4);
    const col = new Uint8Array(vCount * 3);
    let radius = 0;
    const skirt = Math.max(4, Math.min(4000, spacing * 0.6));
    for (let v = 0; v < G; v++) {
      const h = heights[v];
      const r = R + h;
      const x = dirs[v * 3] * r - cx, y = dirs[v * 3 + 1] * r - cy, z = dirs[v * 3 + 2] * r - cz;
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      radius = Math.max(radius, x * x + y * y + z * z);
      lift[v * 4] = dirs[v * 3]; lift[v * 4 + 1] = dirs[v * 3 + 1]; lift[v * 4 + 2] = dirs[v * 3 + 2];
      lift[v * 4 + 3] = Math.max(0, h - sea);
      this.colorVertex(v, h, sea, biome[v], temp[v], slope[v], cells[v], dirs, col);
    }
    for (let k = 0; k < PERIM; k++) {
      const src = PERIMETER[k], dst = G + k;
      pos[dst * 3] = pos[src * 3] - dirs[src * 3] * skirt;
      pos[dst * 3 + 1] = pos[src * 3 + 1] - dirs[src * 3 + 1] * skirt;
      pos[dst * 3 + 2] = pos[src * 3 + 2] - dirs[src * 3 + 2] * skirt;
      lift.copyWithin(dst * 4, src * 4, src * 4 + 4);
      col.copyWithin(dst * 3, src * 3, src * 3 + 3);
    }
    radius = Math.sqrt(radius) + skirt;
    c.radius = radius;
    c.top = maxH;
    // Exaggerated relief (high altitude only) can lift land far beyond the chunk's bounds.
    const cullRadius = radius + Math.max(0, maxH - sea) * (c.level < 9 ? 80 : 2);

    const group = new THREE.Group();
    group.position.copy(c.center);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setAttribute('aLift', new THREE.BufferAttribute(lift, 4));
    geo.setIndex(new THREE.BufferAttribute(GRID_INDEX.slice(), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), cullRadius);
    group.add(new THREE.Mesh(geo, this.material));

    // Sea surface where any part of the chunk is under water.
    const water = minH < sea + 1 ? this.buildWater(c, dirs, heights, sea, R, cx, cy, cz, radius) : null;
    group.add(water ?? new THREE.Object3D());

    // Children 2 and 3: trees and boulders, grass (placeholders keep the indices fixed).
    const veg = c.level >= VEG_MIN_LEVEL && this.veg && maxH > sea
      ? buildVegetation(
        { face: c.face, level: c.level, x: c.x, y: c.y, n, heights, dirs, biome, temp, slope, center: [cx, cy, cz], radiusM: R, seaLevel: sea },
        this.veg,
      )
      : null;
    for (const part of [veg?.plants, veg?.grass]) {
      if (!part) {
        group.add(new THREE.Object3D());
        continue;
      }
      const vg = new THREE.BufferGeometry();
      vg.setAttribute('position', new THREE.BufferAttribute(part.pos, 3));
      vg.setAttribute('color', new THREE.BufferAttribute(part.col, 3, true));
      vg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius + 40);
      group.add(new THREE.Mesh(vg, this.vegMaterial));
    }

    if (c.group) this.disposeChunk(c);
    c.group = group;
    group.visible = false;
    this.group.add(group);
    c.built = true;
    c.version = this.version;
  }

  private buildWater(c: Chunk, dirs: Float64Array, heights: Float32Array, sea: number, R: number, cx: number, cy: number, cz: number, radius: number): THREE.Mesh | null {
    const n = CHUNK_N;
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, cc = a + n + 2, d = a + n + 1;
        const lo = Math.min(heights[a], heights[b], heights[cc], heights[d]);
        if (lo < sea + 0.5) idx.push(a, b, cc, a, cc, d);
      }
    }
    if (!idx.length) return null;
    const pos = new Float32Array(G * 3);
    const wave = new Float32Array(G * 4);
    const col = new Uint8Array(G * 3);
    const r = R + sea;
    const waves = c.level >= 13 ? 1 : 0;
    for (let v = 0; v < G; v++) {
      pos[v * 3] = dirs[v * 3] * r - cx;
      pos[v * 3 + 1] = dirs[v * 3 + 1] * r - cy;
      pos[v * 3 + 2] = dirs[v * 3 + 2] * r - cz;
      wave[v * 4] = dirs[v * 3]; wave[v * 4 + 1] = dirs[v * 3 + 1]; wave[v * 4 + 2] = dirs[v * 3 + 2];
      const depth = sea - heights[v];
      wave[v * 4 + 3] = waves * Math.min(1, Math.max(0, depth / 6));
      const t = Math.min(1, Math.max(0, depth / 60));
      col[v * 3] = (0.16 + (0.05 - 0.16) * t) * 255 + 40 * (1 - t);
      col[v * 3 + 1] = (0.55 + (0.2 - 0.55) * t) * 255;
      col[v * 3 + 2] = (0.62 + (0.45 - 0.62) * t) * 255;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setAttribute('aWave', new THREE.BufferAttribute(wave, 4));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
    const m = new THREE.Mesh(geo, this.waterMaterial);
    m.renderOrder = 1;
    return m;
  }

  private colorVertex(v: number, h: number, sea: number, biome: number, temp: number, slope: number, cell: number, dirs: Float64Array, out: Uint8Array): void {
    let r: number, g: number, b: number;
    if (this.cellRgb) {
      r = this.cellRgb[cell * 3] / 255; g = this.cellRgb[cell * 3 + 1] / 255; b = this.cellRgb[cell * 3 + 2] / 255;
    } else if (h < sea) {
      const t = Math.min(1, (sea - h) / 250);
      r = SEABED_SHALLOW[0] + (SEABED_DEEP[0] - SEABED_SHALLOW[0]) * t;
      g = SEABED_SHALLOW[1] + (SEABED_DEEP[1] - SEABED_SHALLOW[1]) * t;
      b = SEABED_SHALLOW[2] + (SEABED_DEEP[2] - SEABED_SHALLOW[2]) * t;
    } else {
      const look = this.looks[biome];
      const gc = look ? look.ground : [0.5, 0.5, 0.4];
      r = gc[0]; g = gc[1]; b = gc[2];
      // Bare rock on steep slopes.
      const rock = smooth(0.5, 1.0, slope);
      r += (ROCK[0] - r) * rock; g += (ROCK[1] - g) * rock; b += (ROCK[2] - b) * rock;
      // Beaches.
      const above = h - sea;
      if (above < 3 && temp > 1 && slope < 0.35) {
        const t = 1 - above / 3;
        r += (SAND[0] - r) * t; g += (SAND[1] - g) * t; b += (SAND[2] - b) * t;
      }
      // Snow where it is cold enough, less on cliffs.
      const snow = smooth(-1.5, -6, temp) * (1 - 0.6 * rock);
      r += (SNOW[0] - r) * snow; g += (SNOW[1] - g) * snow; b += (SNOW[2] - b) * snow;
    }
    // Gentle mottling so large plains are not flat colour.
    const R = this.sampler!.radiusM;
    const k = R / 700;
    const m = 1 + 0.07 * this.colorNoise.sample(dirs[v * 3] * k, dirs[v * 3 + 1] * k, dirs[v * 3 + 2] * k);
    out[v * 3] = Math.min(255, r * m * 255);
    out[v * 3 + 1] = Math.min(255, g * m * 255);
    out[v * 3 + 2] = Math.min(255, b * m * 255);
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
    this.waterMaterial.dispose();
    this.vegMaterial.dispose();
  }
}

/** One colour per triangle (provoking vertex) for the faceted low-poly look. */
export function flatColors(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader.replace('#include <color_pars_vertex>', '#if defined( USE_COLOR )\nflat varying vec4 vColor;\n#endif');
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_pars_fragment>', '#if defined( USE_COLOR )\nflat varying vec4 vColor;\n#endif');
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
