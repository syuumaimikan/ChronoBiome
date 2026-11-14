import { MinHeap } from '../../minheap';
import { Noise3 } from '../../noise';
import { Rng } from '../../rng';
import type { RulePack } from '../../rules/schema';
import { hopDistance, smoothField } from '../../world/topology';
import { touch, type WorldState } from '../../world/state';
import { baseElevation, deriveElevation, ISOSTASY_DATUM_M, ISOSTASY_M_PER_KM, oceanVolume, OCEANIC_CRUST_KM } from './isostasy';
// Note: sea level stays at the datum chosen in step 6; the ocean fraction is
// then whatever share of cells lies below it after the sea floor is rebuilt.

/**
 * Primordial terrain: partition the sphere into tectonic plates, give each an
 * Euler pole and speed, raise mountains and open rifts along boundaries
 * according to how neighbouring plates move, then express the result as crust
 * (thickness, age, relief) so that tectonics and erosion can take over.
 */
export function generateInitialTerrain(state: WorldState, rules: RulePack): void {
  const { mesh, plates, fields } = state;
  const T = rules.terrain;
  const n = mesh.count;
  const pos = mesh.pos;
  const rng = new Rng(state.seed).fork('terrain.initial');
  const jitterNoise = new Noise3(rng.fork('plate-jitter').seed);
  const crustNoise = new Noise3(rng.fork('crust').seed);
  const detailNoise = new Noise3(rng.fork('detail').seed);
  const ridgeNoise = new Noise3(rng.fork('ridges').seed);

  // ---- 1. plates by noisy multi-source Dijkstra growth
  const P = plates.count;
  const growth = new Float64Array(P);
  const seeds = new Int32Array(P);
  const plateRng = rng.fork('plates');
  for (let p = 0; p < P; p++) {
    let c: number;
    let tries = 0;
    do {
      c = plateRng.int(n);
    } while (seeds.subarray(0, p).includes(c) && ++tries < 100);
    seeds[p] = c;
    growth[p] = plateRng.range(0.55, 1.6);
  }

  const owner = fields.plate;
  owner.fill(0xffff);
  const cost = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap(n * 2);
  for (let p = 0; p < P; p++) {
    cost[seeds[p]] = 0;
    heap.push(0, seeds[p] * 64 + p);
  }
  while (heap.size > 0) {
    const key = heap.peekKey();
    const packed = heap.pop();
    const c = Math.floor(packed / 64);
    const p = packed % 64;
    if (owner[c] !== 0xffff) continue;
    if (key > cost[c]) continue;
    owner[c] = p;
    for (let k = mesh.nbrStart[c]; k < mesh.nbrStart[c + 1]; k++) {
      const nb = mesh.nbr[k];
      if (owner[nb] !== 0xffff) continue;
      const x = pos[nb * 3], y = pos[nb * 3 + 1], z = pos[nb * 3 + 2];
      const jitter = 0.35 + 1.3 * (0.5 + 0.5 * jitterNoise.fbm(x * 2.2, y * 2.2, z * 2.2, 4));
      const nc = key + jitter / growth[p];
      if (nc < cost[nb]) {
        cost[nb] = nc;
        heap.push(nc, nb * 64 + p);
      }
    }
  }

  // ---- 2. plate kinematics and crust type
  const order = Array.from({ length: P }, (_, i) => i);
  for (let i = P - 1; i > 0; i--) {
    const j = plateRng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  let nCont = Math.round(T.continentalPlateShare * P);
  if (P >= 2) nCont = Math.min(P - 1, Math.max(1, nCont));
  const continental = new Uint8Array(P);
  for (let i = 0; i < nCont; i++) continental[order[i]] = 1;

  const [vMin, vMax] = T.plateSpeedDegPerMyr;
  for (let p = 0; p < P; p++) randomizeMotion(state, p, plateRng, vMin, vMax);

  // ---- 3. crust: continental plates with noisy, smoothed coastlines
  const crust = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    crust[i] = continental[owner[i]] + 0.45 * crustNoise.fbm(x * 1.8, y * 1.8, z * 1.8, 4);
  }
  smoothField(mesh, crust, 4, 0.4);

  // ---- 4. boundary interactions (trenches are left to the dynamic model)
  const uplift = new Float32Array(n);
  const rift = new Float32Array(n);
  const ridge = new Uint8Array(n);
  let maxOmega = 1e-30;
  for (let p = 0; p < P; p++) maxOmega = Math.max(maxOmega, Math.abs(plates.omega[p]));
  const va = new Float64Array(3);
  const vb = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    const p = owner[i];
    let best = 0;
    let bestQ = -1;
    for (let k = mesh.nbrStart[i]; k < mesh.nbrStart[i + 1]; k++) {
      const j = mesh.nbr[k];
      const q = owner[j];
      if (q === p) continue;
      const c = convergence(state, p, q, i, j, va, vb) / (2 * maxOmega);
      if (Math.abs(c) > Math.abs(best)) {
        best = c;
        bestQ = q;
      }
    }
    if (bestQ < 0) continue;
    const c = Math.max(-1, Math.min(1, best));
    const ownCont = crust[i] > 0.6;
    const otherCont = continental[bestQ] === 1;
    if (c > 0) {
      if (ownCont && otherCont) uplift[i] = T.collisionUpliftM * c;
      else if (ownCont && !otherCont) uplift[i] = T.arcUpliftM * c;
      else if (!ownCont && !otherCont && p > bestQ) uplift[i] = T.arcUpliftM * 0.8 * c;
    } else if (c < -0.05) {
      if (ownCont) rift[i] = T.riftDepthM * -c;
      else ridge[i] = 1;
    }
  }
  dilate(state, uplift, Math.round(T.boundaryWidthCells), 0.72);
  dilate(state, rift, Math.max(1, Math.round(T.boundaryWidthCells / 2)), 0.55);
  smoothField(mesh, uplift, 1, 0.6);
  smoothField(mesh, rift, 1, 0.6);

  // ---- 5. compose elevation
  // Continental crust covers the land plus a narrow shelf, as on Earth, so the
  // hypsometry is bimodal and a modest sea-level change does not drown or
  // expose whole continents.
  const contShare = Math.min(0.95, (1 - T.oceanFraction) * 1.25);
  const crustSorted = Float32Array.from(crust).sort();
  const th = crustSorted[Math.min(n - 1, Math.max(0, Math.floor((1 - contShare) * n)))];
  const e = fields.elevation;
  const f = T.noiseFrequency;
  const isCont = new Uint8Array(n);
  const crest = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const t = smoothstep(th - 0.08, th + 0.08, crust[i]);
    isCont[i] = t >= 0.5 ? 1 : 0;
    const base = T.oceanicBaseM + (T.continentalBaseM - T.oceanicBaseM) * t;
    crest[i] = 0.5 + 0.5 * ridgeNoise.ridged(x * 4, y * 4, z * 4, 4);
    const detail = detailNoise.fbm(x * f, y * f, z * f, T.noiseOctaves) * T.noiseAmplitudeM * (0.6 + 0.6 * t);
    e[i] = base + uplift[i] * crest[i] - rift[i] + detail;
  }

  // ---- 6. put sea level at the requested ocean fraction
  const sorted = Float32Array.from(e).sort();
  const q = sorted[Math.min(n - 1, Math.max(0, Math.floor(T.oceanFraction * n)))];
  for (let i = 0; i < n; i++) e[i] = Math.max(-11000, Math.min(8900, e[i] - q));

  // ---- 7. express the terrain as crust.
  // Continents keep the composed relief exactly. The sea floor is rebuilt in
  // near steady state: its age grows with distance from spreading ridges, so
  // it does not all subside at once when time starts.
  const ridgeHops = hopDistance(mesh, (i) => ridge[i] === 1, (i) => !isCont[i]);
  const ageRng = rng.fork('crust-age');
  const myrPerHop = mesh.spacingKm / 40; // ≈ 40 km/Myr full spreading rate
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let thick: number;
    let age: number;
    let relief: number;
    if (isCont[i]) {
      thick = Math.max(20, (e[i] + ISOSTASY_DATUM_M) / ISOSTASY_M_PER_KM);
      age = ageRng.range(800, 3000);
      relief = e[i] - baseElevation(thick, age);
    } else {
      // Island arcs above ocean–ocean subduction carry thickened crust.
      thick = OCEANIC_CRUST_KM + (0.6 * uplift[i] * crest[i]) / ISOSTASY_M_PER_KM;
      const hops = ridgeHops[i];
      age = Number.isFinite(hops) ? Math.min(180, hops * myrPerHop) : ageRng.range(40, 120);
      relief = 250 * detailNoise.fbm(x * 6, y * 6, z * 6, 3);
    }
    fields.crustThickness[i] = thick;
    fields.crustAge[i] = age;
    fields.relief[i] = relief;
  }
  fields.stress.fill(0);
  deriveElevation(state, rules);

  // ---- 8. water and hotspots
  state.seaLevel = 0;
  state.waterVolume = oceanVolume(fields.elevation, 0);
  const hsRng = rng.fork('hotspots');
  const hs = new Int32Array(rules.tectonics.hotspotCount);
  for (let h = 0; h < hs.length; h++) hs[h] = hsRng.int(n);
  state.hotspots = hs;

  touch(state, 'plate', 'crustThickness', 'crustAge', 'relief', 'stress');
}

/** Give plate p a random Euler pole and angular speed. */
export function randomizeMotion(state: WorldState, p: number, rng: Rng, vMinDeg: number, vMaxDeg: number): void {
  const plates = state.plates;
  let x = rng.normal(), y = rng.normal(), z = rng.normal();
  const l = Math.hypot(x, y, z) || 1;
  plates.pole[p * 3] = x / l;
  plates.pole[p * 3 + 1] = y / l;
  plates.pole[p * 3 + 2] = z / l;
  plates.omega[p] = rng.range(vMinDeg, vMaxDeg) * (Math.PI / 180 / 1e6) * (rng.chance(0.5) ? 1 : -1);
  plates.drive[p] = plates.omega[p];
}

/**
 * Relative velocity of plate p against plate q at cell i, projected on the
 * direction from i to its neighbour j. Positive = converging. Radians/year.
 */
export function convergence(state: WorldState, p: number, q: number, i: number, j: number, va: Float64Array, vb: Float64Array): number {
  const pos = state.mesh.pos;
  plateVelocity(state, p, i, va);
  plateVelocity(state, q, i, vb);
  let dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
  const dl = Math.hypot(dx, dy, dz);
  dx /= dl; dy /= dl; dz /= dl;
  return (va[0] - vb[0]) * dx + (va[1] - vb[1]) * dy + (va[2] - vb[2]) * dz;
}

/** v = ω (pole × r): surface velocity of plate p at cell i, radians/year. */
export function plateVelocity(state: WorldState, p: number, i: number, out: Float64Array): void {
  const plates = state.plates;
  const pos = state.mesh.pos;
  const w = plates.omega[p];
  const px = plates.pole[p * 3], py = plates.pole[p * 3 + 1], pz = plates.pole[p * 3 + 2];
  const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
  out[0] = w * (py * z - pz * y);
  out[1] = w * (pz * x - px * z);
  out[2] = w * (px * y - py * x);
}

/** Spread values outward with geometric decay, keeping the strongest contribution. */
function dilate(state: WorldState, field: Float32Array, steps: number, decay: number): void {
  const { mesh } = state;
  const next = new Float32Array(field.length);
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < mesh.count; i++) {
      let v = field[i];
      for (let k = mesh.nbrStart[i]; k < mesh.nbrStart[i + 1]; k++) {
        const d = field[mesh.nbr[k]] * decay;
        if (d > v) v = d;
      }
      next[i] = v;
    }
    field.set(next);
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
