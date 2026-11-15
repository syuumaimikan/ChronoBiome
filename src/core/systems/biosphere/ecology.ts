import { hashCombine } from '../../hash';
import { deriveSeed, Rng } from '../../rng';
import type { RulePack } from '../../rules/schema';
import { buildGeodesic, type GeodesicMesh } from '../../world/geodesic';
import { chronicle, touch, type WorldState } from '../../world/state';
import { LIFE_STAGES, regionLevel, type BioState, type StageKey } from './bioState';
import {
  CLADE_NAMES, commonName, isDomesticable, needKcal, rmax, scientificName, sizeClass, type Clade, type Species,
} from './species';

/**
 * Ecology and evolution (milestones 4–5) on a coarse region grid.
 *
 * - Energy: net primary production from the Miami model (temperature and
 *   rainfall); ~3 % of it feeds vertebrate-sized herbivores, ~10 % of that
 *   reaches carnivores (trophic efficiency). Each guild (diet × body-size
 *   class × land/sea) gets a fixed share; species in a guild split it by
 *   fitness⁴ (strong competition, near-exclusion of the less fit). Density
 *   at equilibrium = energy / Kleiber need.
 * - Dispersal over suitable, connected habitat; rafting and flight across sea;
 *   land bridges open when the sea falls.
 * - Speciation: allopatric (a split range) or peripatric (an edge
 *   population), with traits adapting to the new range; clade innovations
 *   (amphibians, reptiles, mammals, birds …). Extinction when numbers fall,
 *   background turnover, and mass extinctions from impacts and flood basalts.
 * - Intelligence drifts upward in social, warm-blooded omnivores until a
 *   lineage becomes sapient — civilisation starts there.
 */

const KCAL_PER_G = 4.5;
const HERB_SHARE = 0.03;
const TROPHIC_EFF = 0.1;
/** Energy share of each body-size class (sums to 1). */
const CLASS_SHARE = [0.12, 0.16, 0.18, 0.17, 0.15, 0.12, 0.07, 0.03];
const MAX_MASS: Record<Clade, number> = {
  insect: 0.08, arthropod: 3, mollusc: 300, fish: 20_000, amphibian: 60, reptile: 80_000, mammal: 15_000, bird: 450, marine_mammal: 150_000,
};
/** Smallest bodies a clade can build (bee hummingbird and Etruscan shrew ≈ 2 g, the tiniest geckos ≈ 0.1 g). */
const MIN_MASS: Record<Clade, number> = {
  insect: 1e-7, arthropod: 1e-6, mollusc: 1e-6, fish: 1e-6, amphibian: 5e-5, reptile: 1e-4, mammal: 0.002, bird: 0.002, marine_mammal: 10,
};
/**
 * Vertebrates and invertebrates feed in different ways (jaws and skeletons vs
 * filter-feeding, grazing films, …), so they form separate guilds even at the
 * same size and diet, and each group has its own share of the species budget.
 */
const VERT: Record<Clade, 0 | 1> = {
  insect: 0, arthropod: 0, mollusc: 0, fish: 1, amphibian: 1, reptile: 1, mammal: 1, bird: 1, marine_mammal: 1,
};
/** Share of each habitat's species budget held by vertebrates. */
const VERT_BUDGET = [0.65, 0.5];

const meshCache = new Map<string, GeodesicMesh>();
function regionMesh(level: number, radiusKm: number): GeodesicMesh {
  const key = `${level}:${radiusKm}`;
  let m = meshCache.get(key);
  if (!m) meshCache.set(key, (m = buildGeodesic(level, radiusKm)));
  return m;
}

/** Miami model NPP (g dry matter / m² / yr) from annual mean temperature and a 0..1 wetness. */
export function nppMiami(tempC: number, moisture: number): number {
  const P = 120 + 2900 * Math.pow(Math.max(0, moisture), 1.25);
  const nT = 3000 / (1 + Math.exp(1.315 - 0.119 * tempC));
  const nP = 3000 * (1 - Math.exp(-0.000664 * P));
  return Math.min(nT, nP) * (tempC < -8 ? 0.03 : 1);
}

export function seaNpp(tempC: number, depthM: number): number {
  if (tempC < -1.8) return 25;
  const shelf = depthM < 250 ? 260 : 0;
  return 70 + shelf + 150 * Math.exp(-(((tempC - 6) / 12) ** 2));
}

function hash01(a: number, b: number, c: number): number {
  return (hashCombine(hashCombine(a, b), c) >>> 0) / 4294967296;
}

export class Ecology {
  readonly regions: GeodesicMesh;
  readonly R: number;
  readonly cellRegion: Int32Array;
  readonly areaKm2: number;
  readonly landFrac: Float32Array;
  readonly seaFrac: Float32Array;
  readonly tLand: Float32Array;
  readonly mLand: Float32Array;
  readonly nppLand: Float32Array;
  readonly tSea: Float32Array;
  readonly nppSea: Float32Array;
  readonly coastal: Uint8Array;
  private envKey = '';
  private readonly W = new Float64Array(48);
  private readonly mark: Int32Array;
  private readonly queue: Int32Array;
  private readonly depth: Int32Array;
  private markStamp = 1;

  constructor(state: WorldState) {
    const m = state.mesh;
    this.regions = regionMesh(regionLevel(m.level), m.radiusKm);
    const R = (this.R = this.regions.count);
    this.areaKm2 = (4 * Math.PI * m.radiusKm * m.radiusKm) / R;
    this.cellRegion = new Int32Array(m.count);
    // Greedy walk on the coarse grid from the previous answer: exact for a Delaunay mesh.
    const rp = this.regions.pos;
    let r = 0;
    for (let i = 0; i < m.count; i++) {
      const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2];
      for (;;) {
        let best = r;
        let bestDot = rp[r * 3] * x + rp[r * 3 + 1] * y + rp[r * 3 + 2] * z;
        for (let k = this.regions.nbrStart[r]; k < this.regions.nbrStart[r + 1]; k++) {
          const q = this.regions.nbr[k];
          const d = rp[q * 3] * x + rp[q * 3 + 1] * y + rp[q * 3 + 2] * z;
          if (d > bestDot) { bestDot = d; best = q; }
        }
        if (best === r) break;
        r = best;
      }
      this.cellRegion[i] = r;
    }
    this.landFrac = new Float32Array(R);
    this.seaFrac = new Float32Array(R);
    this.tLand = new Float32Array(R);
    this.mLand = new Float32Array(R);
    this.nppLand = new Float32Array(R);
    this.tSea = new Float32Array(R);
    this.nppSea = new Float32Array(R);
    this.coastal = new Uint8Array(R);
    this.mark = new Int32Array(R);
    this.queue = new Int32Array(R);
    this.depth = new Int32Array(R);
  }

  // ---------------------------------------------------------------- environment

  /** Forget cached environment (after restoring a keyframe). */
  invalidate(): void {
    this.envKey = '';
  }

  updateEnv(state: WorldState): void {
    const key = `${state.versions.tempMean}:${state.versions.elevation}:${state.seaLevel}`;
    if (key === this.envKey) return;
    this.envKey = key;
    const R = this.R;
    const f = state.fields;
    const sea = state.seaLevel;
    const nLand = new Float32Array(R), nSea = new Float32Array(R);
    this.tLand.fill(0); this.mLand.fill(0); this.nppLand.fill(0); this.tSea.fill(0); this.nppSea.fill(0);
    for (let i = 0; i < state.mesh.count; i++) {
      const r = this.cellRegion[i];
      const t = f.tempMean[i];
      const h = f.elevation[i] - sea;
      if (h >= 0) {
        nLand[r]++;
        this.tLand[r] += t;
        this.mLand[r] += f.moisture[i];
        this.nppLand[r] += nppMiami(t, f.moisture[i]) * (h > 4500 ? 0.3 : 1);
      } else {
        nSea[r]++;
        this.tSea[r] += t;
        this.nppSea[r] += seaNpp(t, -h);
      }
    }
    for (let r = 0; r < R; r++) {
      const tot = nLand[r] + nSea[r];
      this.landFrac[r] = tot ? nLand[r] / tot : 0;
      this.seaFrac[r] = tot ? nSea[r] / tot : 0;
      if (nLand[r]) { this.tLand[r] /= nLand[r]; this.mLand[r] /= nLand[r]; this.nppLand[r] /= nLand[r]; }
      if (nSea[r]) { this.tSea[r] /= nSea[r]; this.nppSea[r] /= nSea[r]; }
    }
    for (let r = 0; r < R; r++) {
      let c = this.landFrac[r] > 0.05 && this.seaFrac[r] > 0.05 ? 1 : 0;
      if (!c && this.landFrac[r] > 0.05) {
        for (let k = this.regions.nbrStart[r]; k < this.regions.nbrStart[r + 1]; k++) if (this.seaFrac[this.regions.nbr[k]] > 0.3) c = 1;
      }
      this.coastal[r] = c;
    }
  }

  /** Habitat fitness 0..1 of a species in a region. */
  fitness(sp: Species, r: number): number {
    if (sp.habitat === 0) {
      if (this.landFrac[r] < 0.03) return 0;
      const tol = sp.tempTol * (sp.endotherm ? 1.6 : 1);
      const fT = Math.exp(-0.5 * ((this.tLand[r] - sp.tempOpt) / tol) ** 2);
      const fM = Math.exp(-0.5 * ((this.mLand[r] - sp.moistOpt) / 0.28) ** 2);
      return fT * (0.25 + 0.75 * fM);
    }
    if (this.seaFrac[r] < 0.03) return 0;
    const tol = sp.tempTol * (sp.endotherm ? 1.8 : 1);
    return Math.exp(-0.5 * ((this.tSea[r] - sp.tempOpt) / tol) ** 2);
  }

  habitatKm2(sp: Species, r: number): number {
    return this.areaKm2 * (sp.habitat === 0 ? this.landFrac[r] : this.seaFrac[r]);
  }

  // ---------------------------------------------------------------- main step

  step(state: WorldState, rules: RulePack, dt: number): void {
    const L = rules.life;
    const bio = state.bio;
    if (!L.enabled || dt <= 0) return;
    const rng = new Rng(deriveSeed(state.seed, 'biosphere', state.tick));
    this.densityRef = bio.density;
    // The regional environment is only needed once there is life to place (or a transition to check).
    if (bio.stage >= 4 || state.time >= bio.nextAt) this.updateEnv(state);
    this.advanceStages(state, rules, dt, rng);
    // Oxygen and plant cover relax toward what the stage of life supports.
    const o2Target = [0, 0.2, 1.5, 3, 10, 15, 21, 21][bio.stage];
    bio.oxygen += (o2Target - bio.oxygen) * (1 - Math.exp(-dt / 1.5e8));
    if (bio.stage >= 6) bio.vegetation = Math.min(1, bio.vegetation + dt / 3e7);
    if (bio.stage < 5) return;
    this.populations(state, dt);
    this.disperse(state, dt, rng);
    this.evolve(state, rules, dt, rng);
    this.catastrophes(state, rules, dt, rng);
    this.census(state);
  }

  private advanceStages(state: WorldState, rules: RulePack, dt: number, rng: Rng): void {
    const bio = state.bio;
    const schedule = () => {
      if (bio.stage >= LIFE_STAGES.length - 1) { bio.nextAt = Infinity; return; }
      const key = LIFE_STAGES[bio.stage + 1].key as StageKey;
      bio.nextAt = state.time + rules.life[key] * 1e6 * Math.exp(0.35 * rng.normal());
    };
    if (bio.nextAt < 0) schedule();
    let guard = 0;
    while (state.time >= bio.nextAt && guard++ < 8) {
      if (bio.stage === 0) {
        // Life needs liquid water: an ocean that is not frozen solid.
        let seaWarm = 0, sea = 0;
        for (let r = 0; r < this.R; r++) if (this.seaFrac[r] > 0.5) { sea++; if (this.tSea[r] > -1.5) seaWarm++; }
        if (sea === 0 || seaWarm / sea < 0.2) { bio.nextAt = state.time + 5e7; break; }
      }
      bio.stage++;
      bio.stageTimes[bio.stage] = state.time;
      chronicle(state, 'life', STAGE_TEXT[bio.stage]);
      if (bio.stage === 5) this.seedMarine(state, rng);
      if (bio.stage === 7) this.seedLand(state, rng);
      schedule();
    }
    void dt;
  }

  // ---------------------------------------------------------------- founding faunas

  private newSpecies(state: WorldState, rng: Rng, t: Partial<Species> & Pick<Species, 'clade' | 'habitat' | 'diet' | 'massKg'>, parent?: Species): Species | null {
    const bio = state.bio;
    let slot = -1;
    for (let s = 0; s < bio.slots; s++) if (bio.slotOwner[s] < 0) { slot = s; break; }
    if (slot < 0) return null;
    const sp: Species = {
      id: bio.nextId++,
      parent: parent ? parent.id : -1,
      name: '',
      sci: '',
      tempOpt: 15,
      tempTol: 8,
      moistOpt: 0.5,
      intelligence: 0.08,
      social: 0.2,
      dispersal: 2,
      endotherm: false,
      flight: false,
      hue: rng.next(),
      shade: 0.2 + 0.6 * rng.next(),
      pattern: rng.int(3),
      horn: rng.next(),
      tail: rng.next(),
      born: state.time,
      died: -1,
      pop: 0,
      range: 0,
      peakPop: 0,
      slot,
      sapient: false,
      domesticable: false,
      origin: 0,
      ...t,
    };
    sp.massKg = Math.min(MAX_MASS[sp.clade], Math.max(MIN_MASS[sp.clade], sp.massKg));
    sp.domesticable = isDomesticable(sp);
    const taken = new Set<string>();
    for (const id of bio.living) taken.add(bio.species.get(id)!.name);
    sp.name = commonName(sp, rng, taken);
    sp.sci = scientificName(sp, rng, parent);
    bio.slotOwner[slot] = sp.id;
    bio.species.set(sp.id, sp);
    bio.living.push(sp.id);
    bio.density.fill(0, slot * this.R, (slot + 1) * this.R);
    return sp;
  }

  private meanSeaTemp(): number {
    let s = 0, n = 0;
    for (let r = 0; r < this.R; r++) if (this.seaFrac[r] > 0.3) { s += this.tSea[r]; n++; }
    return n ? s / n : 10;
  }

  private seedMarine(state: WorldState, rng: Rng): void {
    const T = this.meanSeaTemp();
    const founders: (Partial<Species> & Pick<Species, 'clade' | 'habitat' | 'diet' | 'massKg'>)[] = [
      { clade: 'arthropod', habitat: 1, diet: 0, massKg: 0.003, tempOpt: T - 4, tempTol: 9, dispersal: 30 },
      { clade: 'arthropod', habitat: 1, diet: 0, massKg: 0.06, tempOpt: T + 2, tempTol: 8, dispersal: 10 },
      { clade: 'mollusc', habitat: 1, diet: 0, massKg: 0.2, tempOpt: T, tempTol: 9, dispersal: 6 },
      { clade: 'fish', habitat: 1, diet: 0, massKg: 0.08, tempOpt: T + 3, tempTol: 8, dispersal: 25 },
      { clade: 'fish', habitat: 1, diet: 1, massKg: 0.6, tempOpt: T - 2, tempTol: 8, dispersal: 25 },
      { clade: 'arthropod', habitat: 1, diet: 2, massKg: 0.9, tempOpt: T + 4, tempTol: 7, dispersal: 15 },
      { clade: 'mollusc', habitat: 1, diet: 2, massKg: 2, tempOpt: T - 3, tempTol: 8, dispersal: 12 },
      { clade: 'fish', habitat: 1, diet: 2, massKg: 6, tempOpt: T, tempTol: 9, dispersal: 30 },
    ];
    for (const f of founders) {
      const sp = this.newSpecies(state, rng, f);
      if (!sp) continue;
      for (let r = 0; r < this.R; r++) if (this.seaFrac[r] > 0.05 && this.fitness(sp, r) > 0.1) state.bio.density[sp.slot * this.R + r] = 1e-3;
    }
  }

  private seedLand(state: WorldState, rng: Rng): void {
    let sT = 0, sM = 0, n = 0;
    for (let r = 0; r < this.R; r++) if (this.coastal[r]) { sT += this.tLand[r]; sM += this.mLand[r]; n++; }
    const T = n ? sT / n : 15, M = n ? sM / n : 0.6;
    const founders: (Partial<Species> & Pick<Species, 'clade' | 'habitat' | 'diet' | 'massKg'>)[] = [
      { clade: 'insect', habitat: 0, diet: 0, massKg: 0.002, tempOpt: T, tempTol: 9, moistOpt: M + 0.1, dispersal: 5 },
      { clade: 'insect', habitat: 0, diet: 0, massKg: 0.0008, tempOpt: T + 3, tempTol: 9, moistOpt: M, dispersal: 20, flight: true },
      { clade: 'insect', habitat: 0, diet: 2, massKg: 0.01, tempOpt: T + 2, tempTol: 8, moistOpt: M, dispersal: 3 },
      { clade: 'amphibian', habitat: 0, diet: 2, massKg: 1.5, tempOpt: T + 3, tempTol: 7, moistOpt: Math.min(0.9, M + 0.25), dispersal: 1 },
      { clade: 'amphibian', habitat: 0, diet: 1, massKg: 0.2, tempOpt: T, tempTol: 7, moistOpt: Math.min(0.9, M + 0.2), dispersal: 1 },
    ];
    for (const f of founders) {
      const sp = this.newSpecies(state, rng, f);
      if (!sp) continue;
      for (let r = 0; r < this.R; r++) if (this.coastal[r] && this.fitness(sp, r) > 0.1) state.bio.density[sp.slot * this.R + r] = 1e-3;
    }
  }

  // ---------------------------------------------------------------- populations

  private populations(state: WorldState, dt: number): void {
    const bio = state.bio;
    const R = this.R;
    const W = this.W;
    const living = bio.living.map((id) => bio.species.get(id)!);
    const n = living.length;
    const need = new Float64Array(n), grow = new Float64Array(n), cls = new Int32Array(n), fit = new Float64Array(n), hunt = new Float64Array(n);
    const guild = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const sp = living[k];
      need[k] = needKcal(sp);
      grow[k] = 1 - Math.exp(-rmax(sp) * dt);
      cls[k] = sizeClass(sp.massKg);
      guild[k] = (VERT[sp.clade] * 3 + sp.diet) * 8 + cls[k];
      // Hunting pressure from people falls hardest on big, slow-breeding animals.
      hunt[k] = sp.habitat === 0 && !sp.sapient && sp.massKg > 30 ? 0.6 * Math.sqrt(sp.massKg / 100) : 0;
    }
    const sapient = bio.sapientId >= 0 ? bio.species.get(bio.sapientId) : undefined;
    const civActive = state.civ.settlements.length > 0;
    const D = bio.density;
    for (let r = 0; r < R; r++) {
      for (let hh = 0; hh <= 1; hh++) {
        const h = hh as 0 | 1;
        const frac = h === 0 ? this.landFrac[r] : this.seaFrac[r];
        if (frac < 0.03) {
          for (let k = 0; k < n; k++) if (living[k].habitat === h) D[living[k].slot * R + r] = 0;
          continue;
        }
        const plant = h === 0 ? this.nppLand[r] * bio.vegetation * (1 - 0.85 * bio.farmed[r]) : this.nppSea[r];
        const Eh = plant * 1e6 * KCAL_PER_G * HERB_SHARE;
        W.fill(0);
        for (let k = 0; k < n; k++) {
          const sp = living[k];
          if (sp.habitat !== h || D[sp.slot * R + r] <= 0) { fit[k] = 0; continue; }
          const f = this.fitness(sp, r);
          fit[k] = f;
          W[guild[k]] += f * f * f * f;
        }
        let consumed = 0;
        for (let c = 0; c < 8; c++) {
          if (W[c] > 0 || W[24 + c] > 0) consumed += Eh * 0.85 * CLASS_SHARE[c];
          if (W[8 + c] > 0 || W[32 + c] > 0) consumed += Eh * 0.15 * CLASS_SHARE[c];
        }
        const Ec = TROPHIC_EFF * consumed;
        const people = bio.human[r];
        for (let k = 0; k < n; k++) {
          const sp = living[k];
          if (sp.habitat !== h) continue;
          const idx = sp.slot * R + r;
          const d = D[idx];
          if (d <= 0) continue;
          if (sp === sapient && civActive) {
            D[idx] = people;
            continue;
          }
          const c = cls[k];
          const g = guild[k];
          // The two body-plan groups split a niche they both occupy.
          const other = g >= 24 ? g - 24 : g + 24;
          const split = W[other] > 0 ? 0.5 : 1;
          const Eg = split * (sp.diet === 0 ? Eh * 0.85 * CLASS_SHARE[c] : sp.diet === 1 ? (Eh * 0.15 + Ec * 0.3) * CLASS_SHARE[c] : Ec * 0.7 * CLASS_SHARE[c]);
          const w = W[g];
          const f4 = fit[k] ** 4;
          let K = w > 0 ? (Eg * f4) / w / need[k] : 0;
          if (hunt[k] > 0 && people > 0) K /= 1 + hunt[k] * people;
          const next = d + (K - d) * grow[k];
          D[idx] = next * this.areaKm2 * frac < 2 ? 0 : next;
        }
      }
    }
  }

  // ---------------------------------------------------------------- dispersal

  private passable(sp: Species, r: number): boolean {
    return sp.habitat === 0 ? this.landFrac[r] >= 0.05 : this.seaFrac[r] >= 0.05;
  }

  private disperse(state: WorldState, dt: number, rng: Rng): void {
    const bio = state.bio;
    const R = this.R;
    const D = bio.density;
    const spacing = this.regions.spacingKm;
    const nbrStart = this.regions.nbrStart, nbr = this.regions.nbr;
    for (const id of bio.living) {
      const sp = bio.species.get(id)!;
      if (sp.sapient && state.civ.settlements.length > 0) continue;
      const base = sp.slot * R;
      const reach = (dt * sp.dispersal) / spacing;
      const hops = Math.min(12, Math.floor(reach));
      const stamp = ++this.markStamp;
      let tail = 0;
      for (let r = 0; r < R; r++) if (D[base + r] > 0) { this.mark[r] = stamp; this.depth[r] = 0; this.queue[tail++] = r; }
      if (tail === 0) continue;
      let head = 0;
      const limit = Math.max(1, hops);
      while (head < tail) {
        const r = this.queue[head++];
        const dep = this.depth[r];
        if (dep >= limit) continue;
        for (let k = nbrStart[r]; k < nbrStart[r + 1]; k++) {
          const q = nbr[k];
          if (this.mark[q] === stamp) continue;
          this.mark[q] = stamp;
          const ok = this.passable(sp, q) && this.fitness(sp, q) > 0.05;
          // Flyers cross water without settling on it.
          const over = !ok && sp.flight && sp.habitat === 0;
          if (!ok && !over) continue;
          if (hops === 0 && hash01(id, q, state.tick) >= reach) continue;
          if (ok) D[base + q] = Math.max(D[base + q], 1e-3);
          this.depth[q] = dep + 1;
          this.queue[tail++] = q;
        }
      }
      // Rafting / storms: now and then a land animal reaches a coast across the sea.
      if (sp.habitat === 0 && !sp.flight && rng.chance(1 - Math.exp(-dt / (sp.massKg < 5 ? 2e6 : 8e6)))) this.raft(sp, rng);
    }
    void state;
  }

  private raft(sp: Species, rng: Rng): void {
    const R = this.R;
    const D = this.densityRef!;
    const base = sp.slot * R;
    const coasts: number[] = [];
    for (let r = 0; r < R; r++) if (D[base + r] > 0 && this.coastal[r]) coasts.push(r);
    if (!coasts.length) return;
    let r = rng.pick(coasts);
    for (let step = 0; step < 6; step++) {
      const s = this.regions.nbrStart[r], e = this.regions.nbrStart[r + 1];
      r = this.regions.nbr[s + rng.int(e - s)];
      if (this.landFrac[r] > 0.1 && D[base + r] === 0 && this.fitness(sp, r) > 0.1) {
        D[base + r] = 1e-3;
        return;
      }
      if (this.landFrac[r] > 0.5) return;
    }
  }

  private densityRef: Float32Array | null = null;

  // ---------------------------------------------------------------- evolution

  private evolve(state: WorldState, rules: RulePack, dt: number, rng: Rng): void {
    const bio = state.bio;
    const L = rules.life;
    this.densityRef = bio.density;
    const living = bio.living.slice();
    // Land and sea fill their own share of the species budget, so an ocean
    // full of fish does not stop the radiation of land animals.
    const cap = Math.min(L.maxSpecies, bio.slots);
    const capLand = Math.round(cap * 0.6), capSea = cap - capLand;
    const budget = [
      [capLand * (1 - VERT_BUDGET[0]), capLand * VERT_BUDGET[0]],
      [capSea * (1 - VERT_BUDGET[1]), capSea * VERT_BUDGET[1]],
    ];
    const counts = [[0, 0], [0, 0]];
    const clades = new Map<Clade, number>();
    for (const id of living) {
      const sp = bio.species.get(id)!;
      counts[sp.habitat][VERT[sp.clade]]++;
      clades.set(sp.clade, (clades.get(sp.clade) ?? 0) + 1);
    }
    for (const id of living) {
      const sp = bio.species.get(id);
      if (!sp || sp.died >= 0) continue;
      if (sp.sapient && state.civ.settlements.length > 0) continue;
      // Brains also grow within a lineage (anagenesis), not only at speciation:
      // social, warm-blooded omnivores keep being selected for cleverness.
      if (sp.habitat === 0 && sp.endotherm && sp.diet === 1 && sp.social > 0.35 && sp.massKg > 2 && sp.massKg < 400) {
        const rate = L.intelligenceDrift * 0.5 * (sp.clade === 'bird' ? 0.35 : 1) * (0.5 + sp.social);
        sp.intelligence = Math.min(1, sp.intelligence + (rate * dt) / 1e6);
      }
      const v = VERT[sp.clade];
      const fill = counts[sp.habitat][v] / Math.max(1, budget[sp.habitat][v]);
      const radiation = 1 + 2.5 * Math.max(0, 1 - fill) ** 2;
      // Clever generalists open new niches a little faster.
      const brainy = sp.endotherm && sp.habitat === 0 && sp.intelligence > 0.2 ? 1.6 : 1;
      const lam = (dt / (L.speciationMyr * 1e6)) * Math.max(0, 1 - fill) * radiation * brainy;
      if (rng.next() < 1 - Math.exp(-lam) && bio.living.length < bio.slots) {
        const before = bio.living.length;
        this.speciate(state, rules, sp, rng);
        if (bio.living.length > before) {
          const child = bio.species.get(bio.living[bio.living.length - 1])!;
          counts[child.habitat][VERT[child.clade]]++;
          clades.set(child.clade, (clades.get(child.clade) ?? 0) + 1);
        }
      }
      // Each simulated species stands for a whole group of real ones: the last
      // members of a clade are an ecological niche of their own and persist.
      const relict = (clades.get(sp.clade) ?? 0) <= 2 ? 0.15 : 1;
      const lamE = (dt / (L.extinctionMyr * 1e6)) * (0.5 + 3 / Math.max(1, sp.range)) * relict;
      if (rng.next() < 1 - Math.exp(-lamE)) this.extinguish(state, sp, '自然な種の入れ替わり');
    }
    // Sapience.
    if (bio.sapientId < 0 && rules.civilization.enabled) {
      let best: Species | null = null;
      for (const id of bio.living) {
        const sp = bio.species.get(id)!;
        if (sp.habitat === 0 && sp.intelligence >= L.sapienceThreshold && sp.pop > 1000 && (!best || sp.intelligence > best.intelligence)) best = sp;
      }
      if (best) {
        best.sapient = true;
        bio.sapientId = best.id;
        chronicle(state, 'life', `${best.name}（${best.sci}）が言葉と道具を操る知性を獲得した。文明の時代が始まる。`, { species: best.id });
      }
    }
  }

  /** Regions where a species lives, split into connected components. */
  private components(sp: Species): number[][] {
    const R = this.R;
    const D = this.densityRef!;
    const base = sp.slot * R;
    const stamp = ++this.markStamp;
    const comps: number[][] = [];
    for (let r0 = 0; r0 < R; r0++) {
      if (D[base + r0] <= 0 || this.mark[r0] === stamp) continue;
      const comp: number[] = [r0];
      this.mark[r0] = stamp;
      for (let h = 0; h < comp.length; h++) {
        const r = comp[h];
        for (let k = this.regions.nbrStart[r]; k < this.regions.nbrStart[r + 1]; k++) {
          const q = this.regions.nbr[k];
          if (this.mark[q] !== stamp && D[base + q] > 0) { this.mark[q] = stamp; comp.push(q); }
        }
      }
      comps.push(comp);
    }
    return comps;
  }

  private speciate(state: WorldState, rules: RulePack, parent: Species, rng: Rng): void {
    const bio = state.bio;
    const R = this.R;
    const D = bio.density;
    const comps = this.components(parent);
    if (!comps.length) return;
    let subset: number[];
    let sympatric = false;
    if (comps.length >= 2) {
      comps.sort((a, b) => a.length - b.length);
      subset = comps[rng.int(comps.length - 1)];
    } else {
      const range = comps[0];
      if (range.length <= 2) {
        subset = range;
        sympatric = true;
      } else {
        const edge = range.filter((r) => {
          for (let k = this.regions.nbrStart[r]; k < this.regions.nbrStart[r + 1]; k++) if (D[parent.slot * R + this.regions.nbr[k]] <= 0) return true;
          return false;
        });
        const start = edge.length ? rng.pick(edge) : rng.pick(range);
        const want = Math.max(1, Math.round(range.length * rng.range(0.12, 0.4)));
        subset = [start];
        const inSub = new Set(subset);
        for (let h = 0; h < subset.length && subset.length < want; h++) {
          const r = subset[h];
          for (let k = this.regions.nbrStart[r]; k < this.regions.nbrStart[r + 1] && subset.length < want; k++) {
            const q = this.regions.nbr[k];
            if (!inSub.has(q) && D[parent.slot * R + q] > 0) { inSub.add(q); subset.push(q); }
          }
        }
      }
    }
    // Environment of the new range.
    let T = 0, M = 0, coast = false;
    for (const r of subset) {
      T += parent.habitat === 0 ? this.tLand[r] : this.tSea[r];
      M += this.mLand[r];
      if (this.coastal[r]) coast = true;
    }
    T /= subset.length;
    M /= subset.length;
    const child = this.mutate(state, rules, parent, T, M, coast, rng);
    if (!child) return;
    if (child.habitat !== parent.habitat) {
      // Moving between land and sea: settle the neighbouring habitat of the founding range.
      for (const r of subset) {
        if (this.passable(child, r) && this.fitness(child, r) > 0.05) D[child.slot * R + r] = 1e-3;
        for (let k = this.regions.nbrStart[r]; k < this.regions.nbrStart[r + 1]; k++) {
          const q = this.regions.nbr[k];
          if (this.passable(child, q) && this.fitness(child, q) > 0.05) D[child.slot * R + q] = 1e-3;
        }
      }
    } else {
      for (const r of subset) {
        const v = D[parent.slot * R + r];
        if (sympatric) {
          D[child.slot * R + r] = v * 0.5;
          D[parent.slot * R + r] = v * 0.5;
        } else {
          D[child.slot * R + r] = v;
          D[parent.slot * R + r] = 0;
        }
      }
    }
    child.origin = subset[0];
    this.noteBirth(state, child, parent);
  }

  private mutate(state: WorldState, rules: RulePack, p: Species, T: number, M: number, coast: boolean, rng: Rng): Species | null {
    const bio = state.bio;
    const N = () => rng.normal();
    const t: Partial<Species> & Pick<Species, 'clade' | 'habitat' | 'diet' | 'massKg'> = {
      clade: p.clade,
      habitat: p.habitat,
      diet: p.diet,
      massKg: p.massKg * Math.exp(0.45 * N()),
      tempOpt: p.tempOpt + 0.6 * (T - p.tempOpt) + 1.5 * N(),
      tempTol: Math.max(3, Math.min(25, p.tempTol * Math.exp(0.15 * N()))),
      moistOpt: p.habitat === 0 ? Math.max(0.02, Math.min(1, p.moistOpt + 0.6 * (M - p.moistOpt) + 0.06 * N())) : p.moistOpt,
      social: Math.max(0, Math.min(1, p.social + 0.08 * N())),
      dispersal: Math.max(0.1, Math.min(60, p.dispersal * Math.exp(0.2 * N()))),
      endotherm: p.endotherm,
      flight: p.flight,
      hue: (p.hue + 0.05 * N() + 1) % 1,
      shade: Math.max(0, Math.min(1, p.shade + 0.08 * N())),
      pattern: rng.chance(0.1) ? rng.int(3) : p.pattern,
      horn: Math.max(0, Math.min(1, p.horn + 0.1 * N())),
      tail: Math.max(0, Math.min(1, p.tail + 0.1 * N())),
    };
    if (rng.chance(0.07)) t.diet = Math.max(0, Math.min(2, p.diet + (rng.chance(0.5) ? 1 : -1))) as 0 | 1 | 2;
    // Clade innovations, once life is on land.
    if (bio.stage >= 7) {
      const u = rng.next();
      if (p.clade === 'fish' && coast && bio.vegetation > 0.5 && u < 0.03) {
        Object.assign(t, { clade: 'amphibian', habitat: 0, moistOpt: 0.75, massKg: Math.min(20, t.massKg), dispersal: 1 });
      } else if (p.clade === 'arthropod' && coast && u < 0.02) {
        Object.assign(t, { clade: 'insect', habitat: 0, moistOpt: 0.6, massKg: Math.min(0.02, t.massKg), dispersal: 3 });
      } else if (p.clade === 'amphibian' && u < 0.09) {
        // Amniotic eggs free reptiles from the water's edge.
        Object.assign(t, { clade: 'reptile', moistOpt: Math.max(0.1, (t.moistOpt ?? 0.5) - 0.25), tempTol: (t.tempTol ?? 8) * 1.15 });
      } else if (p.clade === 'reptile' && u < 0.06) {
        Object.assign(t, { clade: 'mammal', endotherm: true, social: Math.min(1, (t.social ?? 0.3) + 0.2), massKg: Math.min(5, t.massKg), diet: 1, tempTol: (t.tempTol ?? 8) * 1.2 });
      } else if (p.clade === 'reptile' && p.massKg < 60 && u < 0.085) {
        Object.assign(t, { clade: 'bird', endotherm: true, flight: true, massKg: Math.min(3, t.massKg * 0.3), dispersal: 20 });
      } else if (p.clade === 'mammal' && coast && p.diet === 2 && u < 0.006) {
        Object.assign(t, { clade: 'marine_mammal', habitat: 1, massKg: t.massKg * 3, dispersal: 40, tempOpt: this.meanSeaTemp() });
      } else if (p.clade === 'insect' && u < 0.1) {
        t.flight = !p.flight;
      } else if (p.clade === 'bird' && p.flight && p.massKg > 1.5 && u < 0.04) {
        Object.assign(t, { flight: false, massKg: t.massKg * 4, dispersal: 3 });
      }
    }
    // Big insects need oxygen-rich air.
    const cap = MAX_MASS[t.clade] * (t.clade === 'insect' || t.clade === 'arthropod' ? Math.max(0.5, bio.oxygen / 21) ** 3 : 1);
    t.massKg = Math.max(MIN_MASS[t.clade], Math.min(cap, t.massKg));
    if (t.flight && t.clade === 'bird') t.massKg = Math.min(15, t.massKg);
    // Intelligence: social, warm-blooded omnivores of middling size are pushed up; brains are costly elsewhere.
    const eligible = t.habitat === 0 && t.endotherm && t.diet === 1 && (t.social ?? 0) > 0.35 && t.massKg > 2 && t.massKg < 400;
    const drift = eligible ? rules.life.intelligenceDrift * (t.clade === 'bird' ? 0.5 : 1) : -0.02 * (p.intelligence - 0.1);
    t.intelligence = Math.max(0, Math.min(1, p.intelligence + drift + 0.03 * N()));
    return this.newSpecies(state, rng, t, p);
  }

  private noteBirth(state: WorldState, sp: Species, parent: Species): void {
    if (sp.clade !== parent.clade) {
      let first = true;
      for (const other of state.bio.species.values()) if (other !== sp && other.clade === sp.clade) { first = false; break; }
      if (first) chronicle(state, 'life', `最初の${CLADE_NAMES[sp.clade]}「${sp.name}」が${CLADE_NAMES[parent.clade]}から分かれた。`, { species: sp.id });
    }
    if (sp.massKg > 20_000 && parent.massKg <= 20_000 && sp.habitat === 0) {
      chronicle(state, 'life', `体重 ${(sp.massKg / 1000).toFixed(0)} t の巨大動物「${sp.name}」が現れた。`, { species: sp.id });
    }
  }

  extinguish(state: WorldState, sp: Species, cause: string): void {
    const bio = state.bio;
    if (sp.died >= 0) return;
    sp.died = state.time;
    sp.cause = cause;
    if (sp.slot >= 0) {
      bio.density.fill(0, sp.slot * this.R, (sp.slot + 1) * this.R);
      bio.slotOwner[sp.slot] = -1;
      sp.slot = -1;
    }
    const i = bio.living.indexOf(sp.id);
    if (i >= 0) bio.living.splice(i, 1);
    bio.extinctCount++;
    let lastOfClade = true;
    for (const id of bio.living) if (bio.species.get(id)!.clade === sp.clade) { lastOfClade = false; break; }
    if (lastOfClade) chronicle(state, 'life', `最後の${CLADE_NAMES[sp.clade]}「${sp.name}」が絶滅した（${cause}）。`, { species: sp.id });
    else if (cause === '人の狩猟') chronicle(state, 'life', `人の狩猟と開発で「${sp.name}」が絶滅した。`, { species: sp.id });
    if (sp.sapient) {
      chronicle(state, 'life', `知性種「${sp.name}」が絶滅した。`, { species: sp.id });
      bio.sapientId = -1;
    }
    this.prune(bio);
  }

  /** Keep the record bounded: drop the oldest extinct species that have no recorded descendants. */
  private prune(bio: BioState): void {
    if (bio.species.size < 5000) return;
    const parents = new Set<number>();
    for (const s of bio.species.values()) parents.add(s.parent);
    const removable = [...bio.species.values()].filter((s) => s.died >= 0 && !parents.has(s.id)).sort((a, b) => a.died - b.died);
    for (const s of removable.slice(0, 1200)) bio.species.delete(s.id);
  }

  // ---------------------------------------------------------------- catastrophes

  private catastrophes(state: WorldState, rules: RulePack, dt: number, rng: Rng): void {
    const bio = state.bio;
    const g = state.climate;
    if (bio.nextImpactAt < 0) bio.nextImpactAt = state.time + rules.life.impactEveryMyr * 1e6 * -Math.log(1 - rng.next());
    if (bio.nextLipAt < 0) bio.nextLipAt = state.time + 70e6 * -Math.log(1 - rng.next());
    if (state.time >= bio.nextImpactAt) {
      this.impact(state, Math.pow(rng.next(), 2.2), rng.int(state.mesh.count), rng);
      bio.nextImpactAt = state.time + rules.life.impactEveryMyr * 1e6 * -Math.log(1 - rng.next());
    }
    if (state.time >= bio.nextLipAt) {
      const mag = 0.3 + 0.7 * rng.next();
      g.pulse += 900 * mag;
      const lost = this.massDie(state, 0.1 + 0.3 * mag, (sp) => (sp.habitat === 1 ? 1.3 : 1) * (sp.tempTol < 6 ? 1.4 : 1), '大規模火成活動と温暖化', rng);
      const hs = state.hotspots.length ? state.hotspots[rng.int(state.hotspots.length)] : rng.int(state.mesh.count);
      chronicle(state, 'disaster', `巨大な洪水玄武岩の噴出が始まり、大気の CO2 が急増した。種の ${(lost * 100).toFixed(0)}% が絶滅。`, { cell: hs });
      state.events.push({ kind: 'lip', time: state.time, cell: hs, magnitude: mag });
      bio.nextLipAt = state.time + 70e6 * -Math.log(1 - rng.next());
    }
    void dt;
  }

  /** An asteroid strike of magnitude 0..1 (≈ 2–14 km): impact winter and a pulse of CO2. */
  impact(state: WorldState, mag: number, cell: number, rng: Rng): number {
    const g = state.climate;
    g.aerosolCooling += 3 + 11 * mag;
    g.pulse += 150 * mag;
    const lost = state.bio.stage >= 5 ? this.massDie(state, 0.08 + 0.65 * mag, (sp) => (sp.massKg > 25 ? 1.5 : 0.7) * (sp.habitat === 1 ? 0.8 : 1), '隕石の衝突', rng) : 0;
    const lat = (state.mesh.lat[cell] * 180) / Math.PI, lon = (state.mesh.lon[cell] * 180) / Math.PI;
    chronicle(state, 'disaster', `直径 ${(2 + mag * 12).toFixed(0)} km の小惑星が衝突した（緯度 ${lat.toFixed(0)}°, 経度 ${lon.toFixed(0)}°）。衝突の冬で種の ${(lost * 100).toFixed(0)}% が絶滅。`, { cell });
    state.events.push({ kind: 'impact', time: state.time, cell, magnitude: mag });
    return lost;
  }

  private massDie(state: WorldState, base: number, weight: (sp: Species) => number, cause: string, rng: Rng): number {
    const bio = state.bio;
    const before = bio.living.length;
    if (!before) return 0;
    const clades = new Map<Clade, number>();
    for (const id of bio.living) {
      const c = bio.species.get(id)!.clade;
      clades.set(c, (clades.get(c) ?? 0) + 1);
    }
    for (const id of bio.living.slice()) {
      const sp = bio.species.get(id)!;
      if (sp.sapient) continue;
      // Some members of every clade ride out the catastrophe in refuges.
      const left = clades.get(sp.clade) ?? 0;
      const refuge = left <= 2 ? 0.25 : 1;
      if (rng.chance(Math.min(0.97, base * weight(sp) * refuge))) {
        this.extinguish(state, sp, cause);
        clades.set(sp.clade, left - 1);
      }
    }
    const share = 1 - bio.living.length / before;
    if (share > 0.25) bio.massExtinctions.push({ time: state.time, cause, lostShare: share });
    return share;
  }

  // ---------------------------------------------------------------- census

  private census(state: WorldState): void {
    const bio = state.bio;
    const R = this.R;
    const D = bio.density;
    bio.richness.fill(0);
    for (const id of bio.living.slice()) {
      const sp = bio.species.get(id)!;
      const base = sp.slot * R;
      let pop = 0, range = 0;
      for (let r = 0; r < R; r++) {
        const d = D[base + r];
        if (d > 0) {
          pop += d * this.habitatKm2(sp, r);
          range++;
          bio.richness[r]++;
        }
      }
      sp.pop = pop;
      sp.range = range;
      if (pop > sp.peakPop) sp.peakPop = pop;
      if (sp.sapient && state.civ.settlements.length > 0) continue;
      if (pop < 50 || range === 0) {
        let human = 0;
        for (let r = 0; r < R; r++) human += bio.human[r];
        const cause = human > 0 && sp.massKg > 30 && sp.habitat === 0 ? '人の狩猟' : '生息地の喪失と競争';
        for (let r = 0; r < R; r++) if (D[base + r] > 0) bio.richness[r]--;
        this.extinguish(state, sp, cause);
      }
    }
    const rich = state.fields.richness;
    let changed = false;
    for (let i = 0; i < state.mesh.count; i++) {
      const v = bio.richness[this.cellRegion[i]];
      if (rich[i] !== v) { rich[i] = v; changed = true; }
    }
    if (changed) touch(state, 'richness');
  }

  // ---------------------------------------------------------------- queries

  /** Species living in a cell's region, densest first. */
  speciesAt(state: WorldState, cell: number): { id: number; density: number }[] {
    const bio = state.bio;
    const r = this.cellRegion[cell];
    const out: { id: number; density: number }[] = [];
    for (const id of bio.living) {
      const sp = bio.species.get(id)!;
      const d = bio.density[sp.slot * this.R + r];
      if (d > 0) out.push({ id, density: d });
    }
    return out.sort((a, b) => b.density - a.density);
  }

  /** Density of one species per fine cell (for the range layer). */
  rangeOf(state: WorldState, id: number, out: Float32Array): Float32Array {
    out.fill(0);
    const sp = state.bio.species.get(id);
    if (!sp || sp.slot < 0) return out;
    for (let i = 0; i < out.length; i++) out[i] = state.bio.density[sp.slot * this.R + this.cellRegion[i]];
    return out;
  }
}

const STAGE_TEXT = [
  '',
  '温かい海の熱水噴出孔のそばで、最初の自己複製する分子の膜が生まれた（原始生命）。',
  'シアノバクテリアが光合成を始め、大気に酸素が溜まり始めた。',
  '細胞の中に細胞が棲みつき、核とミトコンドリアをもつ真核生物が生まれた。',
  '細胞が群れて分業し、多細胞生物が現れた。',
  '海で動物が爆発的に多様化した（カンブリア爆発）。',
  '植物が陸に上がり、大陸が緑に覆われ始めた。',
  '節足動物と両生類が陸に上がった。',
];
