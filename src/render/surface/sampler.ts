import { Noise3 } from '../../core/noise';
import { deriveSeed } from '../../core/rng';

/**
 * Continuous surface of the planet, built from the coarse simulation cells
 * (≈ 110 km apart at grid level 6) plus deterministic detail noise down to a
 * few metres. Pure and DOM-free: the same function feeds terrain chunks,
 * vegetation, animals and the walking player, so they always agree.
 *
 * Detail octaves are summed without normalisation, so a coarse level of
 * detail is exactly a fine one with the small wavelengths left out — terrain
 * does not jump when chunks refine.
 */

export interface SurfaceMesh {
  count: number;
  pos: Float32Array;
  nbrStart: Int32Array;
  nbr: Int32Array;
  radiusKm: number;
  spacingKm: number;
}

export interface SurfaceData {
  mesh: SurfaceMesh;
  elevation: Float32Array;
  biome: Uint8Array;
  moisture: Float32Array;
  tempMean: Float32Array;
  seaLevel: number;
  seed: number;
  lapseRateCPerKm: number;
}

export interface SurfaceSample {
  /** Metres relative to the datum (compare with `seaLevel`). */
  height: number;
  /** Biome index of the (domain-warped) nearest cell. */
  biome: number;
  /** Cell the biome came from (for data-layer colours). */
  cell: number;
  moisture: number;
  /** Annual mean temperature at this exact height, °C. */
  temp: number;
  /** 0 = plain, 1 = high mountains. */
  mountain: number;
}

export function newSample(): SurfaceSample {
  return { height: 0, biome: 0, cell: 0, moisture: 0, temp: 0, mountain: 0 };
}

/** Base wavelengths of the detail layers (m). */
const HILL_WAVE = 48_000;
const RIDGE_WAVE = 30_000;
const BUMP_WAVE = 900;
const MAX_OCTAVES = 15;

/** Number of octaves of a layer with base wavelength `wave` resolvable at `minWaveM`. */
export function octavesFor(wave: number, minWaveM: number): number {
  if (minWaveM <= 0) return MAX_OCTAVES;
  return Math.max(0, Math.min(MAX_OCTAVES, Math.ceil(Math.log2(wave / minWaveM))));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class SurfaceSampler {
  readonly data: SurfaceData;
  readonly radiusM: number;
  readonly seaLevel: number;
  private readonly kernelR: number;
  private readonly hills: Noise3;
  private readonly ridges: Noise3;
  private readonly bumps: Noise3;
  private readonly warpA: Noise3;
  private readonly warpB: Noise3;
  private readonly warpC: Noise3;
  private hint = 0;

  constructor(data: SurfaceData) {
    this.data = data;
    this.radiusM = data.mesh.radiusKm * 1000;
    this.seaLevel = data.seaLevel;
    this.kernelR = (1.25 * data.mesh.spacingKm) / data.mesh.radiusKm;
    const s = data.seed;
    this.hills = new Noise3(deriveSeed(s, 'surface-hills'));
    this.ridges = new Noise3(deriveSeed(s, 'surface-ridges'));
    this.bumps = new Noise3(deriveSeed(s, 'surface-bumps'));
    this.warpA = new Noise3(deriveSeed(s, 'surface-warp-a'));
    this.warpB = new Noise3(deriveSeed(s, 'surface-warp-b'));
    this.warpC = new Noise3(deriveSeed(s, 'surface-warp-c'));
  }

  /** Nearest cell by greedy ascent of the dot product (exact on the geodesic grid). */
  nearestCell(x: number, y: number, z: number): number {
    const { pos, nbrStart, nbr } = this.data.mesh;
    let cur = this.hint;
    let best = pos[cur * 3] * x + pos[cur * 3 + 1] * y + pos[cur * 3 + 2] * z;
    for (let guard = 0; guard < 4096; guard++) {
      let next = -1;
      for (let k = nbrStart[cur]; k < nbrStart[cur + 1]; k++) {
        const j = nbr[k];
        const d = pos[j * 3] * x + pos[j * 3 + 1] * y + pos[j * 3 + 2] * z;
        if (d > best) { best = d; next = j; }
      }
      if (next < 0) break;
      cur = next;
    }
    this.hint = cur;
    return cur;
  }

  /**
   * Sample the surface at unit vector (x, y, z). `minWaveM` is the smallest
   * wavelength worth resolving (≈ twice the vertex spacing); 0 = full detail.
   */
  sample(x: number, y: number, z: number, minWaveM: number, out: SurfaceSample): SurfaceSample {
    const d = this.data;
    const { pos, nbrStart, nbr } = d.mesh;
    const R = this.radiusM;
    const sea = d.seaLevel;

    // 1. Smooth interpolation of the cell values (compact Wendland kernel).
    const c = this.nearestCell(x, y, z);
    let wSum = 0, eSum = 0, tSum = 0, mSum = 0, absDev = 0;
    const kr = this.kernelR;
    for (let k = nbrStart[c] - 1; k < nbrStart[c + 1]; k++) {
      const i = k < nbrStart[c] ? c : nbr[k];
      const dx = pos[i * 3] - x, dy = pos[i * 3 + 1] - y, dz = pos[i * 3 + 2] - z;
      const q = Math.sqrt(dx * dx + dy * dy + dz * dz) / kr;
      if (q >= 1) continue;
      const a = 1 - q;
      const w = a * a * a * a * (4 * q + 1);
      wSum += w;
      eSum += w * d.elevation[i];
      tSum += w * d.tempMean[i];
      mSum += w * d.moisture[i];
    }
    if (wSum <= 0) {
      wSum = 1; eSum = d.elevation[c]; tSum = d.tempMean[c]; mSum = d.moisture[c];
    }
    const base = eSum / wSum;
    for (let k = nbrStart[c] - 1; k < nbrStart[c + 1]; k++) {
      const i = k < nbrStart[c] ? c : nbr[k];
      absDev += Math.abs(d.elevation[i] - base);
    }
    absDev /= nbrStart[c + 1] - nbrStart[c] + 1;

    // 2. Detail. Mountains get sharp ridged noise, lowlands gentle hills.
    const above = base - sea;
    const mountain = Math.min(1, smoothstep(500, 2600, above) + 0.6 * smoothstep(250, 1400, absDev) * (above > 0 ? 1 : 0.3));
    let h = base;
    const hx = x * (R / HILL_WAVE), hy = y * (R / HILL_WAVE), hz = z * (R / HILL_WAVE);
    const nh = octavesFor(HILL_WAVE, minWaveM);
    if (nh > 0) {
      const amp = above > 0 ? 90 + 260 * mountain : 260;
      h += amp * fbmRaw(this.hills, hx, hy, hz, nh);
    }
    const nr = octavesFor(RIDGE_WAVE, minWaveM);
    if (nr > 0 && mountain > 0.01) {
      const rx = x * (R / RIDGE_WAVE), ry = y * (R / RIDGE_WAVE), rz = z * (R / RIDGE_WAVE);
      h += 2400 * mountain * ridgedRaw(this.ridges, rx, ry, rz, nr);
    }
    const nb = octavesFor(BUMP_WAVE, minWaveM);
    if (nb > 0) {
      const bx = x * (R / BUMP_WAVE), by = y * (R / BUMP_WAVE), bz = z * (R / BUMP_WAVE);
      h += (5 + 30 * mountain) * fbmRaw(this.bumps, bx, by, bz, Math.min(nb, 6));
    }

    // 3. Biome from a domain-warped lookup: organic borders instead of hexagons.
    const ws = kr * 0.55;
    const wx = x + ws * fbmRaw(this.warpA, hx * 0.35, hy * 0.35, hz * 0.35, 5);
    const wy = y + ws * fbmRaw(this.warpB, hx * 0.35, hy * 0.35, hz * 0.35, 5);
    const wz = z + ws * fbmRaw(this.warpC, hx * 0.35, hy * 0.35, hz * 0.35, 5);
    const bc = this.nearestCell(wx, wy, wz);
    this.hint = c;

    const lapse = d.lapseRateCPerKm / 1000;
    out.height = h;
    out.cell = bc;
    out.biome = d.biome[bc];
    out.moisture = mSum / wSum;
    out.temp = tSum / wSum - lapse * (Math.max(h, sea) - Math.max(base, sea));
    out.mountain = mountain;
    return out;
  }

  /** Height only (m, datum-relative). */
  heightAt(x: number, y: number, z: number, minWaveM = 0): number {
    return this.sample(x, y, z, minWaveM, this.scratch).height;
  }
  private readonly scratch = newSample();
}

/** Un-normalised fBm (≈ [-1, 1]); dropping octaves only removes fine detail. */
function fbmRaw(n: Noise3, x: number, y: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n.sample(x * f, y * f, z * f);
    amp *= 0.5;
    f *= 2;
  }
  return sum;
}

/** Zero-mean ridged noise (≈ [-0.5, 0.5]): sharp crests, smooth valleys. */
function ridgedRaw(n: Noise3, x: number, y: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const v = 1 - Math.abs(n.sample(x * f, y * f, z * f));
    sum += amp * (v * v - 0.55);
    amp *= 0.5;
    f *= 2;
  }
  return sum * 1.6;
}
