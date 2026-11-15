import { languageDistance, makeName, phonologyFrom, randomLanguage, LANG_DIM } from '../../culture/names';
import { hashCombine } from '../../hash';
import { deriveSeed, Rng } from '../../rng';
import type { RulePack } from '../../rules/schema';
import { distanceKm } from '../../world/topology';
import { chronicle, touch, type WorldState } from '../../world/state';
import { transferCost, updateBodyClimates } from '../../universe/system';
import { birthChart, constellations, skyEvents, solsticeSunriseAzimuth, arcaneFactor } from '../astrology/astrology';
import type { Ecology } from '../biosphere/ecology';
import { nppMiami } from '../biosphere/ecology';
import { castSpell } from '../magic/cast';
import { defaultRoutine, inventSpell, planSpell, runRoutine } from '../magic/spell';
import type { Artifact, Person, Polity, Settlement } from './civState';
import {
  BUILDINGS, DEITIES, DEP, DOCTRINES, ERAS, F, G, GOODS, GOV, GOVS, NB, NFX, NG, NT, TECH, TECHS, V, type Role,
} from './data';

/**
 * Civilisation (milestones 6–7.5, 9.5, 10, 12.5): everything advances on its
 * own once a species becomes sapient.
 *
 * Settlements grow on the food their land yields (net primary production ×
 * farming technology), produce and trade goods at market prices, research
 * and adopt technologies (S-curves, diffusion along trade routes, loss when a
 * population collapses), choose and construct buildings, found daughter
 * settlements, and band into polities whose government evolves. Polities make
 * war over land, religion and borders; conquered towns change hands and razed
 * ones become ruins with buried artifacts. Languages drift and split,
 * religions are born of famines, plagues and omens in the sky, pathogens jump
 * from animals and ride the trade network. Industry burns fossil fuel and
 * warms the climate; the space age reaches the other worlds of the system.
 */

const TECH_FX: [number, number][][] = TECHS.map((t) => Object.entries(t.fx).map(([k, v]) => [F[k as keyof typeof F], v as number]));
const BLD_FX: [number, number][][] = BUILDINGS.map((b) => Object.entries(b.fx).map(([k, v]) => [F[k as keyof typeof F], v as number]));
const MIN_POP_FOR_ERA = [0, 0, 1500, 3000, 5000, 8000, 15000, 40000, 100000, 250000, 500000];
const COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9'];

interface Trigger {
  s: Settlement;
  cause: 'famine' | 'plague' | 'sky' | 'volcano' | 'prosperity' | 'war';
}

function techKnown(s: Settlement, id: string, at = 0.3): boolean {
  return s.tech[TECH[id].index] >= at;
}

export class Civilization {
  private readonly eco: Ecology;
  private readonly n: number;
  private readonly cellArea: number;
  private readonly queue: Int32Array;
  private readonly dist: Int32Array;
  private readonly cellProd: Float32Array;
  private readonly forest: Float32Array;
  private prodKey = '';
  /** Per settlement id: catchment productivity sum, forest share, cells (in BFS order). */
  private readonly catch = new Map<number, { prod: number; forest: number; cells: number[] }>();
  private borders = new Set<number>();
  private dirty = true;
  private signs: string[] = [];
  private signSeed = -1;
  private triggers: Trigger[] = [];
  private manaSrc: Float32Array | null = null;
  private manaSrcAt = -1e9;
  private manaNext: Float32Array | null = null;

  constructor(state: WorldState, eco: Ecology) {
    this.eco = eco;
    this.n = state.mesh.count;
    this.cellArea = (4 * Math.PI * state.mesh.radiusKm ** 2) / this.n;
    this.queue = new Int32Array(this.n);
    this.dist = new Int32Array(this.n);
    this.cellProd = new Float32Array(this.n);
    this.forest = new Float32Array(this.n);
  }

  /** Mark territory for recomputation (after loading a keyframe, or external changes). */
  invalidate(): void {
    this.dirty = true;
    this.prodKey = '';
  }

  step(state: WorldState, rules: RulePack, dt: number): void {
    const civ = state.civ;
    if (dt <= 0) return;
    // Mana is part of nature: it flows whether or not anyone lives to use it.
    if (rules.magic.enabled && !(civ.started >= 0 && civ.settlements.length)) this.manaField(state, rules, dt);
    if (!rules.civilization.enabled) return;
    if (civ.started < 0) {
      if (state.bio.sapientId < 0) return;
      this.seed(state, rules);
      if (civ.started < 0) return;
    }
    if (!civ.settlements.length && !civ.colonies.length) return;
    // Coarse lenses: civilisation advances at most 500 years per tick in steps of ≤ 10 years.
    const years = Math.min(dt, 500);
    const sub = Math.max(1, Math.ceil(years / 10));
    const h = years / sub;
    const rng = new Rng(deriveSeed(state.seed, 'civilization', state.tick));
    for (let k = 0; k < sub; k++) this.substep(state, rules, h, rng, k === sub - 1);
  }

  // ================================================================ start

  private seed(state: WorldState, rules: RulePack): void {
    const civ = state.civ;
    const bio = state.bio;
    const sp = bio.species.get(bio.sapientId);
    if (!sp) return;
    this.updateProd(state);
    const rng = new Rng(deriveSeed(state.seed, 'civ-origin', 0));
    const R = this.eco.R;
    // The cradle: the best land in the regions where the species lives.
    const cand: { c: number; score: number }[] = [];
    for (let c = 0; c < this.n; c++) {
      if (!this.isLand(state, c)) continue;
      const r = this.eco.cellRegion[c];
      if (sp.slot >= 0 && bio.density[sp.slot * R + r] <= 0) continue;
      cand.push({ c, score: this.cellProd[c] * (1 + 0.3 * this.coastBonus(state, c)) + rng.next() * 0.05 });
    }
    if (!cand.length) for (let c = 0; c < this.n; c++) if (this.isLand(state, c)) cand.push({ c, score: this.cellProd[c] });
    cand.sort((a, b) => b.score - a.score);
    const chosen: number[] = [];
    for (const { c } of cand) {
      if (chosen.length >= 5) break;
      if (chosen.every((o) => distanceKm(state.mesh, o, c) > 900)) chosen.push(c);
    }
    if (!chosen.length) return;
    civ.started = state.time;
    const proto = randomLanguage(rng);
    const langSeed = rng.u32();
    civ.languages.push({ id: 0, name: makeName(phonologyFrom(proto, langSeed), rng) + '祖語', parent: -1, founded: state.time, vec: Array.from(proto), seed: langSeed, speakers: 0 });
    civ.firstTech = new Array(NT).fill(-1);
    for (const c of chosen) {
      const lang = proto.slice();
      for (let d = 0; d < LANG_DIM; d++) lang[d] = Math.min(1, Math.max(0, lang[d] + 0.03 * rng.normal()));
      const pol = this.newPolity(state, rng, lang, 0, -1);
      const s = this.newSettlement(state, rng, c, pol.id, 600 + rng.int(900), lang, 0);
      // Everyone starts with fire and stone tools; the rest must be found.
      s.tech[TECH.fire.index] = 1;
      s.tech[TECH.stone_tools.index] = 1;
      pol.capital = s.id;
    }
    chronicle(state, 'civ', `${sp.name}の最初の集団が${chosen.length}か所に住み着いた。火と打製石器を使い、狩りと採集で暮らしている。`, { species: sp.id });
    this.dirty = true;
    void rules;
  }

  private newPolity(state: WorldState, rng: Rng, lang: Float32Array, gov: number, parent: number): Polity {
    const civ = state.civ;
    const base = makeName(phonologyFrom(lang, civ.languages[0]?.seed ?? 1), rng);
    const pol: Polity = {
      id: civ.nextId++,
      base,
      name: base + GOVS[gov].suffix,
      color: COLORS[civ.polities.length % COLORS.length],
      capital: -1,
      founded: state.time,
      fell: -1,
      gov,
      values: new Float32Array(5).map(() => 0.3 + 0.4 * rng.next()),
      religion: -1,
      langId: 0,
      treasury: 0,
      opinion: {},
      ruler: -1,
      pop: 0,
      settlements: 0,
      territory: 0,
      strength: 0,
      era: 0,
      parent,
    };
    civ.polities.push(pol);
    return pol;
  }

  private newSettlement(state: WorldState, rng: Rng, cell: number, polity: number, pop: number, lang: Float32Array, langId: number, parent?: Settlement): Settlement {
    const civ = state.civ;
    const ph = phonologyFrom(lang, civ.languages[langId]?.seed ?? 1);
    const s: Settlement = {
      id: civ.nextId++,
      name: makeName(ph, rng),
      cell,
      region: this.eco.cellRegion[cell],
      polity,
      founded: state.time,
      pop,
      peakPop: pop,
      K: pop,
      urban: 0.02,
      wealth: 0,
      stock: new Float32Array(NG),
      price: new Float32Array(GOODS.map((g) => g.base)),
      supply: new Float32Array(NG),
      demand: new Float32Array(NG),
      tech: parent ? parent.tech.slice() : new Float32Array(NT),
      research: -1,
      progress: 0,
      buildings: new Uint16Array(NB),
      build: -1,
      buildProgress: 0,
      lang: lang.slice(),
      langId,
      values: parent ? parent.values.slice() : new Float32Array(5).map(() => 0.3 + 0.4 * rng.next()),
      religion: parent ? parent.religion : -1,
      devotion: parent ? parent.devotion * 0.8 : 0,
      plague: -1,
      plagueLeft: 0,
      plagueAttack: 0,
      immune: 0,
      deposits: 0,
      coastal: this.coastBonus(state, cell) > 0,
      river: state.fields.flow[cell] > 25,
      loyalty: 1,
      catchment: 1,
      farmCells: 0,
      foodImport: 0,
      lastFamine: -1e9,
      buffs: { food: 0, health: 0, defense: 0, morale: 0 },
      megaAzimuth: NaN,
      aligned: false,
      golems: 0,
      fx: new Float32Array(NFX),
    };
    // Daughter settlements carry most of the knowledge, a little less widely adopted.
    if (parent) for (let i = 0; i < NT; i++) s.tech[i] = Math.min(s.tech[i], Math.max(0, s.tech[i] * 0.9));
    civ.settlements.push(s);
    this.dirty = true;
    return s;
  }

  private isLand(state: WorldState, c: number): boolean {
    return state.fields.elevation[c] >= state.seaLevel;
  }

  private coastBonus(state: WorldState, c: number): number {
    const m = state.mesh;
    for (let k = m.nbrStart[c]; k < m.nbrStart[c + 1]; k++) if (!this.isLand(state, m.nbr[k])) return 1;
    return 0;
  }

  // ================================================================ substep

  private substep(state: WorldState, rules: RulePack, h: number, rng: Rng, last: boolean): void {
    const civ = state.civ;
    this.triggers = [];
    if (civ.depositsAt < 0 || state.time - civ.depositsAt > 1e5) this.computeDeposits(state, rules);
    this.updateProd(state);
    for (const s of civ.settlements) this.computeFx(s, rules);
    if (this.dirty || state.time - civ.territoryAt >= 10) this.territory(state);
    if (state.time - civ.linksAt >= 20 || civ.links.some((l) => !this.byId(state, l.a) || !this.byId(state, l.b))) this.tradeLinks(state);
    this.population(state, rules, h);
    this.economy(state, h);
    this.research(state, rules, h, rng);
    this.construction(state, rules, h, rng);
    this.founding(state, rules, h, rng);
    this.polities(state, rules, h, rng);
    this.diplomacy(state, rules, h, rng);
    this.culture(state, h, rng);
    this.plague(state, rules, h, rng);
    if (rules.magic.enabled) this.magic(state, rules, h, rng);
    if (rules.astrology.enabled) this.sky(state, rules, h, rng);
    this.disasters(state, h, rng);
    this.religion(state, h, rng);
    if (rules.civilization.spaceAge) this.space(state, h, rng);
    this.archaeology(state, h, rng);
    this.persons(state, rng);
    this.emissions(state, rules);
    this.bookkeeping(state, rng);
    if (last) this.quests(state, rules, rng);
  }

  private byId(state: WorldState, id: number): Settlement | undefined {
    let s = this.index.get(id);
    if (s && state.civ.settlements[this.indexPos.get(id) ?? -1] === s) return s;
    this.reindex(state);
    s = this.index.get(id);
    return s;
  }

  private index = new Map<number, Settlement>();
  private indexPos = new Map<number, number>();
  private reindex(state: WorldState): void {
    this.index.clear();
    this.indexPos.clear();
    state.civ.settlements.forEach((s, i) => { this.index.set(s.id, s); this.indexPos.set(s.id, i); });
  }

  // ================================================================ land

  private computeDeposits(state: WorldState, rules: RulePack): void {
    const civ = state.civ;
    const f = state.fields;
    const seed = state.seed;
    const near = new Uint8Array(this.n);
    for (const hs of state.hotspots) {
      near[hs] = 1;
      for (let k = state.mesh.nbrStart[hs]; k < state.mesh.nbrStart[hs + 1]; k++) near[state.mesh.nbr[k]] = 1;
    }
    const u = (i: number, k: number) => (hashCombine(hashCombine(seed ^ 0xde9051, i), k) >>> 0) / 4294967296;
    for (let i = 0; i < this.n; i++) {
      const T = f.crustThickness[i];
      const h = f.elevation[i] - state.seaLevel;
      const stress = Math.abs(f.stress[i]);
      let bits = 0;
      if (T >= 18) {
        const orogen = T > 38 || stress > 0.3;
        if (u(i, 1) < (orogen ? 0.22 : 0.025)) bits |= DEP.copper;
        if (u(i, 2) < (orogen && T > 42 ? 0.1 : 0.004)) bits |= DEP.tin;
        if (u(i, 3) < 0.12) bits |= DEP.iron;
        if (h >= 0 && h < 900 && f.moisture[i] > 0.35 && u(i, 4) < 0.13) bits |= DEP.coal;
        if (T < 36 && h < 600 && u(i, 5) < 0.07) bits |= DEP.oil;
        if (f.crustAge[i] > 800 && u(i, 6) < 0.05) bits |= DEP.uranium;
        if (orogen && u(i, 7) < 0.05) bits |= DEP.gold;
      } else if (h > -250 && h < 0 && u(i, 5) < 0.06) bits |= DEP.oil;
      if (rules.magic.enabled && (stress > 0.05 || near[i]) && u(i, 8) < 0.2) bits |= DEP.mana;
      civ.deposits[i] = bits;
    }
    civ.depositsAt = state.time;
  }

  private updateProd(state: WorldState): void {
    const key = `${state.versions.tempMean}:${state.versions.elevation}:${state.seaLevel}`;
    if (key === this.prodKey) return;
    this.prodKey = key;
    const f = state.fields;
    for (let c = 0; c < this.n; c++) {
      const h = f.elevation[c] - state.seaLevel;
      if (h < 0) { this.cellProd[c] = 0; this.forest[c] = 0; continue; }
      const t = f.tempMean[c];
      let p = nppMiami(t, f.moisture[c]) / 1000;
      if (h > 3000) p *= 0.2;
      else if (h > 1500) p *= 0.6;
      if (f.flow[c] > 25) p *= 1.25;
      this.cellProd[c] = p * Math.max(0.05, state.bio.vegetation);
      this.forest[c] = Math.max(0, Math.min(1, (f.moisture[c] - 0.32) * 2.2)) * (t > -6 ? 1 : 0) * state.bio.vegetation;
    }
    this.dirty = true;
  }

  private computeFx(s: Settlement, rules: RulePack): void {
    const fx = s.fx;
    fx.fill(0);
    for (let i = 0; i < NT; i++) {
      const a = s.tech[i];
      if (a <= 0) continue;
      if (TECHS[i].magic && !rules.magic.enabled) continue;
      for (const [k, v] of TECH_FX[i]) fx[k] += v * a;
    }
  }

  /** Effects of a settlement's buildings (multipliers), summed. */
  private bfx(s: Settlement, k: number): number {
    let v = 0;
    for (let b = 0; b < NB; b++) {
      const c = s.buildings[b];
      if (!c) continue;
      for (const [kk, vv] of BLD_FX[b]) if (kk === k) v += vv * c;
    }
    return v;
  }

  /**
   * Who controls which land: a multi-source breadth-first search from every
   * settlement, each reaching as far as its size and administration allow.
   * Also writes land use, population density and the territory layer.
   */
  private territory(state: WorldState): void {
    const civ = state.civ;
    const m = state.mesh;
    const f = state.fields;
    const owner = civ.owner;
    owner.fill(-1);
    this.dist.fill(-1);
    const list = [...civ.settlements].sort((a, b) => b.pop - a.pop);
    const radius = new Map<number, number>();
    let head = 0, tail = 0;
    for (const s of list) {
      if (!this.isLand(state, s.cell)) continue;
      if (owner[s.cell] >= 0) continue;
      owner[s.cell] = s.id;
      this.dist[s.cell] = 0;
      this.queue[tail++] = s.cell;
      // A town works the land within a day or two of walking (one or two cells);
      // big cities reach a little further. Beyond that, land is free for daughter towns.
      radius.set(s.id, Math.max(1, Math.min(4, 1 + Math.floor(Math.sqrt(s.pop / 60000)) + (s.fx[F.admin] > 4 ? 1 : 0))));
    }
    while (head < tail) {
      const c = this.queue[head++];
      const o = owner[c];
      const d = this.dist[c];
      if (d + 1 > (radius.get(o) ?? 1)) continue;
      for (let k = m.nbrStart[c]; k < m.nbrStart[c + 1]; k++) {
        const q = m.nbr[k];
        if (owner[q] >= 0 || !this.isLand(state, q)) continue;
        owner[q] = o;
        this.dist[q] = d + 1;
        this.queue[tail++] = q;
      }
    }
    // Catchments in BFS order (nearest cells first).
    this.catch.clear();
    for (const s of civ.settlements) this.catch.set(s.id, { prod: 0, forest: 0, cells: [] });
    for (let i = 0; i < tail; i++) {
      const c = this.queue[i];
      const e = this.catch.get(owner[c]);
      if (!e) continue;
      e.cells.push(c);
      e.prod += this.cellProd[c];
      e.forest += this.forest[c];
    }
    const polOf = new Map<number, number>();
    for (const s of civ.settlements) polOf.set(s.id, s.polity);
    // Land use and people.
    const ruinCells = new Set(civ.ruins.map((r) => r.cell));
    f.landUse.fill(0);
    for (const c of ruinCells) f.landUse[c] = 3;
    f.population.fill(0);
    f.territory.fill(-1);
    for (const s of civ.settlements) {
      const e = this.catch.get(s.id)!;
      s.catchment = Math.max(1, e.cells.length);
      let dep = 0;
      let river = false;
      for (const c of e.cells) {
        dep |= civ.deposits[c];
        if (f.flow[c] > 25) river = true;
        f.territory[c] = polOf.get(s.id) ?? -1;
      }
      s.deposits = dep;
      s.river = river;
      s.coastal = this.coastBonus(state, s.cell) > 0;
      const agri = Math.min(1, s.fx[F.food] / 8);
      const farmWanted = agri > 0.05 ? Math.min(e.cells.length - 1, Math.max(1, Math.round(agri * (e.cells.length - 1) * Math.min(1, s.pop / Math.max(1, s.K)) * 0.8))) : 0;
      s.farmCells = farmWanted;
      const urbanPop = s.pop * s.urban;
      const rural = s.pop - urbanPop;
      for (let i = 0; i < e.cells.length; i++) {
        const c = e.cells[i];
        if (i === 0) {
          f.landUse[c] = 2;
          f.population[c] = urbanPop / this.cellArea + (farmWanted ? 0 : rural / e.cells.length / this.cellArea);
        } else if (i <= farmWanted) {
          f.landUse[c] = 1;
          f.population[c] = (rural * 0.85) / farmWanted / this.cellArea;
        } else {
          f.population[c] = (rural * (farmWanted ? 0.15 : 1)) / Math.max(1, e.cells.length - 1 - farmWanted) / this.cellArea;
        }
      }
    }
    // Borders between polities, for diplomacy.
    this.borders.clear();
    for (let c = 0; c < this.n; c++) {
      const a = f.territory[c];
      if (a < 0) continue;
      for (let k = m.nbrStart[c]; k < m.nbrStart[c + 1]; k++) {
        const b = f.territory[m.nbr[k]];
        if (b >= 0 && b !== a) this.borders.add(a < b ? a * 100000 + b : b * 100000 + a);
      }
    }
    // Feedback to the biosphere: people and farms per region.
    const bio = state.bio;
    const R = this.eco.R;
    const people = new Float64Array(R), farms = new Float64Array(R), land = new Float64Array(R);
    for (let c = 0; c < this.n; c++) {
      if (!this.isLand(state, c)) continue;
      const r = this.eco.cellRegion[c];
      land[r]++;
      people[r] += f.population[c] * this.cellArea;
      if (f.landUse[c] === 1 || f.landUse[c] === 2) farms[r]++;
    }
    for (let r = 0; r < R; r++) {
      bio.human[r] = land[r] ? people[r] / (land[r] * this.cellArea) : 0;
      bio.farmed[r] = land[r] ? farms[r] / land[r] : 0;
    }
    touch(state, 'territory', 'landUse', 'population');
    civ.territoryAt = state.time;
    this.dirty = false;
  }

  private tradeLinks(state: WorldState): void {
    const civ = state.civ;
    const old = new Map(civ.links.map((l) => [l.a * 1e7 + l.b, l.volume]));
    civ.links = [];
    const S = civ.settlements;
    for (let i = 0; i < S.length; i++) {
      const a = S[i];
      const rangeLand = 250 + 180 * a.fx[F.trade];
      const sail = a.fx[F.sail];
      const rangeSea = a.coastal && sail >= 0.8 ? 400 + 900 * sail : 0;
      const near: { j: number; km: number; sea: boolean }[] = [];
      for (let j = 0; j < S.length; j++) {
        if (j === i) continue;
        const b = S[j];
        const km = distanceKm(state.mesh, a.cell, b.cell);
        const sameLand = this.eco.cellRegion[a.cell] === this.eco.cellRegion[b.cell] || km < rangeLand;
        if (sameLand && km <= rangeLand) near.push({ j, km, sea: false });
        else if (rangeSea && b.coastal && km <= rangeSea) near.push({ j, km, sea: true });
      }
      near.sort((x, y) => x.km - y.km);
      for (const { j, km, sea } of near.slice(0, 4)) {
        const b = S[j];
        const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
        if (civ.links.some((l) => l.a === lo && l.b === hi)) continue;
        civ.links.push({ a: lo, b: hi, km, sea, volume: old.get(lo * 1e7 + hi) ?? 0 });
      }
    }
    civ.linksAt = state.time;
  }

  // ================================================================ people

  private population(state: WorldState, rules: RulePack, h: number): void {
    const civ = state.civ;
    for (const s of civ.settlements) {
      const e = this.catch.get(s.id);
      const prod = e ? e.prod : this.cellProd[s.cell];
      const fx = s.fx;
      const farming = 0.1 + 0.3 * fx[F.food];
      const tradeFood = Math.min(1, fx[F.trade] / 12);
      s.urban = Math.max(0.02, Math.min(0.85, 0.03 + fx[F.urban] + this.bfx(s, F.urban)));
      const K = this.cellArea * prod * farming * (1 + this.bfx(s, F.food) + Math.max(-0.5, s.buffs.food)) * (1 + 0.8 * tradeFood * s.urban) + s.foodImport;
      s.K = Math.max(50, K);
      const health = fx[F.health] + this.bfx(s, F.health) + s.buffs.health;
      const modern = Math.max(0, Math.min(1, (health - 1) / 2)) * Math.min(1, s.urban / 0.5);
      const births = 0.042 - 0.026 * modern;
      const deaths = Math.max(0.006, 0.0412 - 0.011 * Math.min(3, health));
      const r = (births - deaths) * rules.civilization.growthRate;
      if (s.pop < s.K) {
        if (r > 0) s.pop += s.pop * r * (1 - s.pop / s.K) * h;
        else s.pop *= Math.exp(r * h);
      } else {
        const loss = (s.pop - s.K) * (1 - Math.exp(-0.4 * h));
        s.pop -= loss;
        civ.deathsFamine += loss;
        if (loss > 0.08 * s.pop && state.time - s.lastFamine > 40) {
          s.lastFamine = state.time;
          if (loss > 3000) chronicle(state, 'disaster', `${s.name}で飢饉、約${fmt(loss)}人が亡くなった。`, { cell: s.cell, polity: s.polity });
          this.triggers.push({ s, cause: 'famine' });
        }
      }
      if (s.pop > s.peakPop) s.peakPop = s.pop;
      // Boons fade.
      const fade = Math.exp(-h / 3);
      s.buffs.food *= fade; s.buffs.health *= fade; s.buffs.defense *= fade; s.buffs.morale *= fade;
    }
  }

  private economy(state: WorldState, h: number): void {
    const civ = state.civ;
    for (const s of civ.settlements) {
      const P = s.pop;
      const fx = s.fx;
      const a = (id: string) => s.tech[TECH[id].index];
      const has = (bit: number) => (s.deposits & bit) !== 0;
      const prodMul = 1 + 0.3 * fx[F.prod] + this.bfx(s, F.prod) + 0.2 * s.golems;
      const e = this.catch.get(s.id);
      const forestShare = e ? e.forest / Math.max(1, e.cells.length) : 0.3;
      const energy = P * fx[F.energy];
      const fossil = Math.max(0, Math.min(1, fx[F.fossil] - fx[F.renew] - this.bfx(s, F.renew)));
      const oilShare = a('combustion');
      const S = s.supply, D = s.demand;
      S.fill(0);
      D.fill(0);
      S[G.food] = Math.min(P, s.K - s.foodImport);
      D[G.food] = P;
      S[G.wood] = P * 0.12 * forestShare * prodMul;
      D[G.wood] = P * 0.05 + (s.build >= 0 ? P * 0.01 : 0);
      S[G.stone] = P * (a('masonry') > 0 || a('mudbrick') > 0 ? 0.03 : 0.004) * prodMul;
      D[G.stone] = s.build >= 0 ? P * 0.02 : P * 0.003;
      if (has(DEP.copper)) S[G.copper] = P * 0.006 * a('copper') * prodMul;
      D[G.copper] = P * 0.004 * a('copper');
      if (has(DEP.tin)) S[G.tin] = P * 0.002 * a('bronze') * prodMul;
      D[G.tin] = P * 0.002 * a('bronze');
      if (has(DEP.iron)) S[G.iron] = P * 0.008 * a('iron') * prodMul;
      D[G.iron] = P * 0.006 * a('iron');
      if (has(DEP.coal)) S[G.coal] = P * 0.03 * Math.max(a('blast_furnace'), a('steam')) * prodMul;
      D[G.coal] = energy * fossil * (1 - 0.6 * oilShare) * 0.01;
      if (has(DEP.oil)) S[G.oil] = P * 0.03 * oilShare * prodMul;
      D[G.oil] = energy * fossil * 0.6 * oilShare * 0.01;
      const metal = Math.max(a('copper'), a('iron'));
      S[G.tools] = P * 0.004 * prodMul * metal + P * 0.001 * a('stone_tools');
      D[G.tools] = P * 0.003 * (1 + civEra(s) / 3);
      S[G.cloth] = P * 0.05 * a('weaving') * prodMul;
      D[G.cloth] = P * 0.04 * a('weaving');
      S[G.luxury] = (has(DEP.gold) ? P * 0.002 : 0) + P * 0.001 * a('pottery');
      D[G.luxury] = P * 0.001 * (1 + Math.min(5, s.wealth / Math.max(1, P)));
      if (has(DEP.mana)) S[G.mana] = P * 0.002 * a('mana_mining') * (1 + s.buildings[BUILDING_INDEX.mana_mine]);
      D[G.mana] = P * 0.0015 * fx[F.magic];
      for (let g = 0; g < NG; g++) {
        s.stock[g] = Math.max(0, Math.min(Math.max(1, D[g] * 3), s.stock[g] + (S[g] - D[g]) * h));
        const ratio = (D[g] + 1e-6) / (S[g] + s.stock[g] / 3 + 1e-6);
        const target = GOODS[g].base * Math.pow(Math.max(0.05, Math.min(20, ratio)), 0.6);
        s.price[g] += (target - s.price[g]) * (1 - Math.exp(-h));
      }
      s.foodImport = 0;
      const upkeep = s.buildings.reduce((sum, c, b) => sum + c * BUILDINGS[b].cost * 0.002, 0);
      s.wealth += h * (P * 0.002 * (1 + 0.2 * fx[F.trade]) - upkeep);
      const pol = this.polity(state, s.polity);
      if (pol) pol.treasury += h * P * 0.0002;
    }
    // Trade: goods flow down price gradients when the gap pays for the transport.
    for (const l of civ.links) {
      const A = this.byId(state, l.a), B = this.byId(state, l.b);
      if (!A || !B) continue;
      if (this.atWar(state, A.polity, B.polity)) { l.volume *= 0.5; continue; }
      const tradeFx = (A.fx[F.trade] + B.fx[F.trade]) / 2;
      const ld = languageDistance(A.lang, B.lang);
      const costFactor = (l.km / (400 * (1 + tradeFx / 2))) * (l.sea ? 0.5 : 1) * (1 + 2 * ld) * (A.polity === B.polity ? 0.7 : 1);
      let vol = 0;
      for (let g = 0; g < NG; g++) {
        const cost = GOODS[g].base * costFactor;
        const diff = B.price[g] - A.price[g];
        if (Math.abs(diff) <= cost) continue;
        const [from, to] = diff > 0 ? [A, B] : [B, A];
        const avail = from.stock[g] * 0.3;
        const want = Math.max(0, to.demand[g] - to.supply[g]) * h + to.demand[g] * 0.05;
        const q = Math.min(avail, want);
        if (q <= 0) continue;
        from.stock[g] -= q;
        to.stock[g] += q;
        const value = (q * (from.price[g] + to.price[g])) / 2;
        from.wealth += value * 0.1;
        to.wealth -= value * 0.1;
        vol += value;
        if (g === G.food) to.foodImport += q / h;
      }
      l.volume += (vol / h - l.volume) * Math.min(1, h / 5);
    }
  }

  // ================================================================ knowledge

  private research(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    const glacial = state.climate.iceShare > 0.22;
    const linkCount = new Map<number, number>();
    for (const l of civ.links) {
      linkCount.set(l.a, (linkCount.get(l.a) ?? 0) + 1);
      linkCount.set(l.b, (linkCount.get(l.b) ?? 0) + 1);
    }
    for (const s of civ.settlements) {
      const fx = s.fx;
      const rp = Math.pow(s.pop / 1000, 0.75) * (0.15 + fx[F.literacy] + this.bfx(s, F.literacy)) * (1 + 0.5 * fx[F.research] + this.bfx(s, F.research))
        * (0.5 + s.values[V.science]) * rules.civilization.researchRate * (1 + 0.1 * (linkCount.get(s.id) ?? 0));
      if (s.research < 0 || s.tech[s.research] > 0) s.research = this.pickResearch(state, rules, s, rng);
      if (s.research >= 0) {
        const t = TECHS[s.research];
        s.progress += rp * h * (t.id === 'agriculture' && glacial ? 0.25 : 1);
        if (s.progress >= t.cost) this.learn(state, s, t.index, rng, 'invent');
      }
      // Adoption spreads through society along an S-curve.
      const k = 0.04 + 0.03 * (fx[F.literacy] + Math.min(2, fx[F.admin] / 2));
      const minPop = MIN_POP_FOR_ERA;
      for (let i = 0; i < NT; i++) {
        const a = s.tech[i];
        if (a <= 0) continue;
        if (a < 1) s.tech[i] = Math.min(1, a + k * a * (1 - a) * h + 0.001 * h);
        // Knowledge needs enough people to keep it alive.
        if (s.pop < minPop[TECHS[i].era] * 0.5) {
          s.tech[i] -= 0.03 * h;
          if (s.tech[i] <= 0.01) {
            s.tech[i] = 0;
            if (!civ.settlements.some((o) => o.tech[i] > 0)) chronicle(state, 'tech', `「${TECHS[i].name}」の技術は${s.name}の衰退とともに失われた。`, { cell: s.cell, polity: s.polity });
          }
        }
      }
    }
    // Diffusion along trade routes and from the capital.
    for (const l of civ.links) {
      const A = this.byId(state, l.a), B = this.byId(state, l.b);
      if (!A || !B) continue;
      const tradeFx = (A.fx[F.trade] + B.fx[F.trade]) / 2;
      const p = 1 - Math.exp((-h * 0.04 * (1 + 0.15 * tradeFx)) / (1 + 3 * languageDistance(A.lang, B.lang)));
      if (rng.chance(p)) this.diffuse(state, A, B, rng);
      if (rng.chance(p)) this.diffuse(state, B, A, rng);
    }
    for (const s of civ.settlements) {
      const pol = this.polity(state, s.polity);
      if (!pol || pol.capital === s.id) continue;
      const cap = this.byId(state, pol.capital);
      if (cap && rng.chance(1 - Math.exp(-0.05 * h))) this.diffuse(state, cap, s, rng);
    }
  }

  private available(state: WorldState, rules: RulePack, s: Settlement, i: number, reach: number): boolean {
    const t = TECHS[i];
    if (s.tech[i] > 0) return false;
    if (t.magic && !rules.magic.enabled) return false;
    if (t.field === '宇宙' && !rules.civilization.spaceAge) return false;
    for (const r of t.reqIdx) if (s.tech[r] < 0.3) return false;
    if (t.res && (reach & t.res) !== t.res) return false;
    if (t.id === 'husbandry' && !this.domesticable(state, s)) return false;
    return true;
  }

  /** Deposits a settlement can reach: its own and its trade partners'. */
  private reach(state: WorldState, s: Settlement): number {
    let bits = s.deposits;
    for (const l of state.civ.links) {
      if (l.a === s.id) bits |= this.byId(state, l.b)?.deposits ?? 0;
      else if (l.b === s.id) bits |= this.byId(state, l.a)?.deposits ?? 0;
    }
    return bits;
  }

  private domesticable(state: WorldState, s: Settlement): boolean {
    const bio = state.bio;
    for (const id of bio.living) {
      const sp = bio.species.get(id)!;
      if (sp.domesticable && bio.density[sp.slot * this.eco.R + s.region] > 0) return true;
    }
    return false;
  }

  private pickResearch(state: WorldState, rules: RulePack, s: Settlement, rng: Rng): number {
    const reach = this.reach(state, s);
    const pressure = s.pop / Math.max(1, s.K);
    const atWar = state.civ.wars.some((w) => w.a === s.polity || w.b === s.polity);
    const v = s.values;
    let total = 0;
    const cand: [number, number][] = [];
    for (let i = 0; i < NT; i++) {
      if (!this.available(state, rules, s, i, reach)) continue;
      const t = TECHS[i];
      let w = 1 / t.cost;
      switch (t.field) {
        case '軍事': w *= 0.4 + v[V.aggression] + (atWar ? 1.5 : 0); break;
        case '統治': case '輸送': w *= 0.5 + v[V.commerce]; break;
        case '科学': case '記録': case '計算': case '通信': w *= 0.5 + v[V.science]; break;
        case '農業': w *= 0.8 + 0.4 * v[V.tradition] + (pressure > 0.85 ? 1.5 : 0); break;
        case '医療': w *= 0.6 + (s.plague >= 0 || s.immune > 0.2 ? 2 : 0); break;
        case '宇宙': w *= 0.6 + v[V.science]; break;
        case '魔法': w *= 0.5 + v[V.piety]; break;
        default: w *= 1;
      }
      cand.push([i, w]);
      total += w;
    }
    if (!cand.length) return -1;
    let x = rng.next() * total;
    for (const [i, w] of cand) {
      x -= w;
      if (x <= 0) return i;
    }
    return cand[cand.length - 1][0];
  }

  private learn(state: WorldState, s: Settlement, i: number, rng: Rng, how: 'invent' | 'diffuse' | 'decipher'): void {
    const civ = state.civ;
    const t = TECHS[i];
    s.tech[i] = Math.max(s.tech[i], 0.05);
    if (s.research === i) { s.research = -1; s.progress = 0; }
    if (how === 'invent' && civ.firstTech[i] < 0) {
      civ.firstTech[i] = state.time;
      const pol = this.polity(state, s.polity);
      if (t.era > civ.era) {
        civ.era = t.era;
        chronicle(state, 'tech', `世界は${ERAS[t.era]}時代に入った。`, { cell: s.cell, polity: s.polity });
      }
      let who = '';
      if (t.era >= 2) {
        const p = this.person(state, 'inventor', s, rng, `「${t.name}」を発明した`);
        who = `${p.name}が`;
      }
      chronicle(state, 'tech', `${pol ? pol.name + 'の' : ''}${s.name}で${who}「${t.name}」が発明された（${ERAS[t.era]}・${t.field}）。`, { cell: s.cell, polity: s.polity });
    }
  }

  private diffuse(state: WorldState, from: Settlement, to: Settlement, rng: Rng): void {
    const reach = this.reach(state, to);
    for (let attempt = 0; attempt < 6; attempt++) {
      const i = rng.int(NT);
      if (from.tech[i] < 0.5 || to.tech[i] > 0) continue;
      const t = TECHS[i];
      if (t.reqIdx.some((r) => to.tech[r] < 0.3)) continue;
      if (t.res && (reach & t.res) !== t.res) continue;
      this.learn(state, to, i, rng, 'diffuse');
      return;
    }
  }

  // ================================================================ building

  private construction(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    for (const s of civ.settlements) {
      if (s.build < 0) s.build = this.pickBuilding(state, rules, s, rng);
      if (s.build < 0) continue;
      const bd = BUILDINGS[s.build];
      let labor = Math.pow(s.pop / 1000, 0.7) * 0.15 * (1 + 0.3 * s.fx[F.prod] + this.bfx(s, F.prod)) * (1 + 0.2 * s.golems);
      const stoneNeed = labor * h * 0.4;
      if (s.stock[G.stone] < stoneNeed) labor *= 0.5;
      s.stock[G.stone] = Math.max(0, s.stock[G.stone] - stoneNeed);
      s.buildProgress += labor * h;
      if (s.buildProgress >= bd.cost) {
        s.buildings[s.build]++;
        s.buildProgress = 0;
        const done = s.build;
        s.build = -1;
        this.completed(state, s, done, rng);
      }
      // Neglect: a shrinking town loses buildings.
      if (s.pop < s.peakPop * 0.35 && rng.chance(1 - Math.exp(-0.01 * h))) {
        const have = [];
        for (let b = 0; b < NB; b++) if (s.buildings[b] > 0) have.push(b);
        if (have.length) s.buildings[rng.pick(have)]--;
      }
    }
  }

  private pickBuilding(state: WorldState, rules: RulePack, s: Settlement, rng: Rng): number {
    const pol = this.polity(state, s.polity);
    const atWar = state.civ.wars.some((w) => w.a === s.polity || w.b === s.polity);
    const pressure = s.pop / Math.max(1, s.K);
    const v = s.values;
    const W: Record<string, number> = {
      food: pressure > 0.85 ? 6 : 1.5,
      research: 1 + 3 * v[V.science],
      culture: 1 + 2 * v[V.tradition],
      piety: 1 + 3 * v[V.piety],
      defense: atWar ? 6 : 0.5 + 2 * v[V.aggression],
      trade: 1 + 3 * v[V.commerce],
      health: s.plague >= 0 || s.immune > 0.2 ? 5 : 1.5,
      prod: 1.5, urban: 2, admin: 1.5, space: 3, astro: 1 + 2 * v[V.piety] + v[V.science], mana: 2, literacy: 2,
      military: 1 + 2 * v[V.aggression] + (atWar ? 3 : 0), magic: 2, renew: 2,
    };
    let best = -1, bestScore = 0;
    for (let b = 0; b < NB; b++) {
      const bd = BUILDINGS[b];
      if (bd.magic && !rules.magic.enabled) continue;
      if (bd.techIdx >= 0 && s.tech[bd.techIdx] < 0.3) continue;
      const max = bd.id === 'factory' || bd.id === 'skyscraper' ? Math.min(bd.max, 1 + Math.floor(s.pop / 2e5)) : bd.max;
      if (s.buildings[b] >= max) continue;
      if (bd.coastal && !s.coastal) continue;
      if (bd.river && !s.river) continue;
      if (bd.capital && (!pol || pol.capital !== s.id)) continue;
      if (bd.deposit && !(s.deposits & bd.deposit)) continue;
      if (bd.religious && s.religion < 0) continue;
      if (bd.id === 'spaceport' && !rules.civilization.spaceAge) continue;
      if (bd.cost > Math.pow(s.pop / 1000, 0.7) * 0.15 * 400) continue; // more than ~400 years of work
      let score = 0.2;
      for (const [k, val] of Object.entries(bd.fx)) score += (val as number) * (W[k] ?? 1);
      score = (score / Math.sqrt(bd.cost)) * (1 + 0.3 * rng.next());
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  private completed(state: WorldState, s: Settlement, b: number, rng: Rng): void {
    const bd = BUILDINGS[b];
    if (bd.mega) {
      // Orient it on the solstice sunrise; astronomers aim better.
      const az = solsticeSunriseAzimuth(state.mesh.lat[s.cell], state.climate.tiltDeg);
      const err = techKnown(s, 'astronomy') ? 0.3 : 2.5;
      s.megaAzimuth = Number.isFinite(az) ? az + err * rng.normal() : NaN;
    }
    const notable = bd.mega || bd.cost >= 150;
    if (notable) chronicle(state, 'civ', `${s.name}に${bd.name}が完成した${bd.mega && Number.isFinite(s.megaAzimuth) ? `（夏至の日の出、方位 ${s.megaAzimuth.toFixed(1)}° に向けて）` : ''}。`, { cell: s.cell, polity: s.polity });
  }

  // ================================================================ expansion

  private founding(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    if (civ.settlements.length >= rules.civilization.maxSettlements) return;
    for (const s of [...civ.settlements]) {
      if (civ.settlements.length >= rules.civilization.maxSettlements) break;
      // Crowding sends families out to found daughter villages; farmers need more people to spare.
      const agri = s.fx[F.food] > 3;
      // Big towns also send settlers out before the land is full (new fields are far away).
      const pressure = s.pop / Math.max(1, s.K);
      const big = s.pop > 15000 * (1 + civEra(s));
      if (s.pop < (agri ? 5000 : 900) || (pressure < 0.35 && !big)) continue;
      if (!rng.chance(1 - Math.exp(-0.05 * Math.max(pressure, big ? 0.6 : 0) * h))) continue;
      const site = this.findSite(state, s);
      if (!site) continue;
      const pol = this.polity(state, s.polity);
      const hops = site.hops;
      const adminHops = 3 + Math.floor(s.fx[F.admin]);
      let polity = s.polity;
      if (!pol || pol.gov === GOV.band || hops > adminHops) {
        const alive = civ.polities.filter((p) => p.fell < 0).length;
        if (alive < 70) {
          const fresh = this.newPolity(state, rng, s.lang, pol && pol.gov >= GOV.chiefdom ? GOV.chiefdom : GOV.band, s.polity);
          fresh.values.set(s.values);
          fresh.langId = s.langId;
          polity = fresh.id;
        }
      }
      const pop = s.pop * 0.15;
      s.pop -= pop;
      const ns = this.newSettlement(state, rng, site.cell, polity, pop, s.lang, s.langId, s);
      const np = this.polity(state, polity);
      if (np && np.capital < 0) np.capital = ns.id;
      if (site.sea) chronicle(state, 'civ', `${s.name}の人々が海を渡り、新天地に${ns.name}を築いた。`, { cell: ns.cell, polity });
    }
  }

  /** Best unclaimed land within reach (overland, or by sea with sailing). */
  private findSite(state: WorldState, s: Settlement): { cell: number; hops: number; sea: boolean } | null {
    const m = state.mesh;
    const civ = state.civ;
    const sail = s.fx[F.sail];
    const maxSea = sail >= 2.5 ? 30 : sail >= 0.8 ? 3 : 0;
    // Past the town's own fields (up to four cells) and a little beyond.
    const maxHops = 7 + Math.floor(s.fx[F.trade] / 2) + maxSea;
    const seen = new Map<number, number>([[s.cell, 0]]);
    const seaRun = new Map<number, number>([[s.cell, 0]]);
    const crossed = new Map<number, boolean>([[s.cell, false]]);
    let frontier = [s.cell];
    let best: { cell: number; hops: number; sea: boolean } | null = null;
    let bestScore = 0;
    for (let d = 1; d <= maxHops && frontier.length; d++) {
      const next: number[] = [];
      for (const c of frontier) {
        for (let k = m.nbrStart[c]; k < m.nbrStart[c + 1]; k++) {
          const q = m.nbr[k];
          if (seen.has(q)) continue;
          const land = this.isLand(state, q);
          const run = land ? 0 : (seaRun.get(c) ?? 0) + 1;
          if (!land && run > maxSea) continue;
          seen.set(q, d);
          seaRun.set(q, run);
          crossed.set(q, (crossed.get(c) ?? false) || !land);
          next.push(q);
          if (!land || d < 2) continue;
          if (civ.owner[q] >= 0) continue;
          let free = true;
          for (let kk = m.nbrStart[q]; kk < m.nbrStart[q + 1]; kk++) if (civ.owner[m.nbr[kk]] >= 0) free = false;
          if (!free) continue;
          const score = this.cellProd[q] * (1 + 0.3 * this.coastBonus(state, q)) * (state.fields.flow[q] > 25 ? 1.3 : 1) - 0.02 * d;
          if (score > bestScore) {
            bestScore = score;
            best = { cell: q, hops: d, sea: crossed.get(q) ?? false };
          }
        }
      }
      frontier = next;
    }
    return bestScore > 0.15 ? best : null;
  }

  // ================================================================ polities

  polity(state: WorldState, id: number): Polity | undefined {
    return state.civ.polities.find((p) => p.id === id);
  }

  private atWar(state: WorldState, a: number, b: number): boolean {
    return state.civ.wars.some((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));
  }

  private polities(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    const live = civ.polities.filter((p) => p.fell < 0);
    for (const p of live) {
      p.pop = 0; p.settlements = 0; p.strength = 0; p.era = 0;
      p.values.fill(0);
    }
    const best = new Map<number, Settlement>();
    const relCount = new Map<number, Map<number, number>>();
    for (const s of civ.settlements) {
      const p = this.polity(state, s.polity);
      if (!p) continue;
      p.pop += s.pop;
      p.settlements++;
      p.strength += Math.pow(s.pop, 0.75) * (1 + s.fx[F.military] + this.bfx(s, F.military));
      for (let k = 0; k < 5; k++) p.values[k] += s.values[k] * s.pop;
      p.era = Math.max(p.era, civEra(s));
      const cur = best.get(p.id);
      if (!cur || s.pop > cur.pop) best.set(p.id, s);
      if (s.religion >= 0) {
        let m = relCount.get(p.id);
        if (!m) relCount.set(p.id, (m = new Map()));
        m.set(s.religion, (m.get(s.religion) ?? 0) + s.pop);
      }
    }
    for (const p of live) {
      if (p.settlements === 0) {
        p.fell = state.time;
        if (p.gov >= GOV.chiefdom) chronicle(state, 'war', `${p.name}は滅亡した（建国から${fmtYears(state.time - p.founded)}）。`, { polity: p.id });
        continue;
      }
      for (let k = 0; k < 5; k++) p.values[k] /= Math.max(1, p.pop);
      const cap = best.get(p.id)!;
      if (p.capital !== cap.id) {
        const oldCap = this.byId(state, p.capital);
        if (!oldCap || oldCap.polity !== p.id || cap.pop > oldCap.pop * 1.5) p.capital = cap.id;
      }
      const capital = this.byId(state, p.capital) ?? cap;
      p.langId = capital.langId;
      const rc = relCount.get(p.id);
      if (rc) p.religion = [...rc.entries()].sort((a, b) => b[1] - a[1])[0][0];
      // Government evolves with knowledge and size.
      const knows = (id: string) => techKnown(capital, id);
      let next = p.gov;
      if (p.gov === GOV.band && knows('agriculture') && p.pop >= 8000) next = GOV.chiefdom;
      else if (p.gov === GOV.chiefdom && (knows('writing') || knows('bronze') || knows('law')) && p.pop >= 50000 && p.settlements >= 2) next = GOV.kingdom;
      else if (p.gov === GOV.kingdom && knows('bureaucracy') && p.settlements >= 6) next = GOV.empire;
      else if ((p.gov === GOV.kingdom || p.gov === GOV.empire) && p.values[V.piety] > 0.72 && p.religion >= 0 && rng.chance(0.002 * h)) next = GOV.theocracy;
      else if (p.gov === GOV.kingdom && p.values[V.commerce] > 0.62 && (knows('philosophy') || knows('banking')) && rng.chance(0.002 * h)) next = GOV.republic;
      else if (p.gov >= GOV.kingdom && p.gov !== GOV.democracy && p.gov !== GOV.federation && knows('printing') && capital.fx[F.literacy] > 0.5 && p.era >= 6 && rng.chance(0.004 * h)) next = GOV.democracy;
      else if (p.gov >= GOV.kingdom && p.gov !== GOV.federation && p.era >= 8 && p.settlements >= 10 && rng.chance(0.003 * h)) next = GOV.federation;
      if (next !== p.gov) {
        const was = p.name;
        p.gov = next;
        p.name = p.base + GOVS[next].suffix;
        const ruler = this.person(state, 'ruler', capital, rng, `${p.name}を${next === GOV.democracy ? '革命で' : ''}興した`);
        p.ruler = ruler.id;
        chronicle(state, 'civ', next === GOV.democracy ? `${was}で革命が起き、${p.name}が成立した。` : `${was}は${GOVS[next].name}へ移行し、${p.name}となった（${ruler.name}）。`, { polity: p.id, cell: capital.cell });
      }
      // Rulers age and die; the line goes on.
      const r = civ.persons.find((x) => x.id === p.ruler);
      if (!r || (r.died < 0 && state.time > r.born + r.lifespan)) {
        if (r && r.died < 0) r.died = state.time;
        if (p.gov >= GOV.chiefdom) p.ruler = this.person(state, 'ruler', capital, rng, `${p.name}の${GOVS[p.gov].id === 'democracy' || GOVS[p.gov].id === 'republic' ? '指導者' : '君主'}となった`).id;
      }
    }
    // Secession of far-flung, disaffected provinces.
    for (const s of civ.settlements) {
      const p = this.polity(state, s.polity);
      if (!p || p.capital === s.id || p.gov < GOV.chiefdom) continue;
      const cap = this.byId(state, p.capital);
      if (!cap) continue;
      const km = distanceKm(state.mesh, s.cell, cap.cell);
      const range = 400 + 350 * cap.fx[F.admin];
      const target = 1 - (0.5 * km) / range - 2 * languageDistance(s.lang, cap.lang) - (s.religion !== cap.religion ? 0.2 : 0) + s.buffs.morale;
      s.loyalty += (Math.max(0, Math.min(1, target)) - s.loyalty) * Math.min(1, 0.05 * h);
      if (s.loyalty < 0.15 && rng.chance(1 - Math.exp(-0.01 * h)) && civ.polities.filter((x) => x.fell < 0).length < 80) {
        const np = this.newPolity(state, rng, s.lang, Math.max(GOV.chiefdom, Math.min(GOV.kingdom, p.gov)), p.id);
        np.values.set(s.values);
        np.langId = s.langId;
        s.polity = np.id;
        s.loyalty = 0.9;
        np.capital = s.id;
        const leader = this.person(state, 'ruler', s, rng, `${p.name}から独立した`);
        np.ruler = leader.id;
        chronicle(state, 'war', `${s.name}が${p.name}から独立し、${np.name}を建てた（${leader.name}）。`, { cell: s.cell, polity: np.id });
        this.dirty = true;
      }
    }
    void rules;
  }

  private diplomacy(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    const pairs = new Set<number>(this.borders);
    for (const l of civ.links) {
      const A = this.byId(state, l.a), B = this.byId(state, l.b);
      if (A && B && A.polity !== B.polity) pairs.add(A.polity < B.polity ? A.polity * 100000 + B.polity : B.polity * 100000 + A.polity);
    }
    for (const key of pairs) {
      const a = this.polity(state, Math.floor(key / 100000)), b = this.polity(state, key % 100000);
      if (!a || !b || a.fell >= 0 || b.fell >= 0) continue;
      if (this.atWar(state, a.id, b.id)) continue;
      const trade = civ.links.reduce((sum, l) => {
        const A = this.byId(state, l.a), B = this.byId(state, l.b);
        return A && B && ((A.polity === a.id && B.polity === b.id) || (A.polity === b.id && B.polity === a.id)) ? sum + l.volume : sum;
      }, 0);
      const pressure = (p: Polity) => {
        let pop = 0, K = 0;
        for (const s of civ.settlements) if (s.polity === p.id) { pop += s.pop; K += s.K; }
        return K > 0 ? pop / K : 0;
      };
      const relDiff = a.religion >= 0 && b.religion >= 0 && a.religion !== b.religion ? 1 : 0;
      const target = 15 * Math.min(1, Math.log10(1 + trade) / 4) - 35 * relDiff - 40 * ((a.values[V.aggression] + b.values[V.aggression]) / 2) * rules.civilization.aggression
        - 20 * Math.max(0, pressure(a) - 0.8) + (a.langId === b.langId ? 10 : 0) + 10;
      const op = a.opinion[b.id] ?? 0;
      const next = op + (target - op) * Math.min(1, 0.05 * h) + 3 * rng.normal();
      a.opinion[b.id] = next;
      b.opinion[a.id] = next;
      if (a.gov === GOV.band && b.gov === GOV.band) continue;
      const [att, def] = a.strength * (0.5 + a.values[V.aggression]) >= b.strength * (0.5 + b.values[V.aggression]) ? [a, b] : [b, a];
      if (next < -35 && att.strength > 0.8 * def.strength && rng.chance(1 - Math.exp(-0.03 * h * att.values[V.aggression] * rules.civilization.aggression))) {
        const cause = relDiff ? '宗教の対立' : pressure(att) > 0.9 ? '土地と食料をめぐる争い' : '国境紛争';
        civ.wars.push({ a: att.id, b: def.id, started: state.time, cause, wearA: 0, wearB: 0, battles: 0 });
        chronicle(state, 'war', `${att.name}が${def.name}に宣戦した（${cause}）。`, { polity: att.id });
        for (const s of civ.settlements) if (s.polity === att.id) this.triggers.push({ s, cause: 'war' });
      }
    }
    // Wars: battles, conquests, peace.
    for (const w of [...civ.wars]) {
      const a = this.polity(state, w.a), b = this.polity(state, w.b);
      const end = (text: string) => {
        civ.wars.splice(civ.wars.indexOf(w), 1);
        if (a && b) { a.opinion[b.id] = -10; b.opinion[a.id] = -10; }
        if (text) chronicle(state, 'war', text, { polity: w.a });
      };
      if (!a || !b || a.fell >= 0 || b.fell >= 0) { end(''); continue; }
      w.wearA += 0.02 * h;
      w.wearB += 0.02 * h;
      if (rng.chance(1 - Math.exp(-h))) {
        w.battles++;
        const targets = civ.settlements.filter((s) => s.polity === b.id);
        const ac = this.byId(state, a.capital);
        if (!targets.length || !ac) { end(''); continue; }
        targets.sort((x, y) => distanceKm(state.mesh, x.cell, ac.cell) - distanceKm(state.mesh, y.cell, ac.cell));
        const t = targets[0];
        const defense = 1 + t.fx[F.defense] + this.bfx(t, F.defense) + t.buffs.defense;
        const p = a.strength / (a.strength + b.strength * defense * 0.6 + 1e-9);
        const dead = t.pop * rng.range(0.01, 0.05);
        t.pop -= dead;
        civ.deathsWar += dead * 1.6;
        if (rng.chance(p)) {
          t.polity = a.id;
          t.loyalty = 0.3;
          t.pop *= 0.85;
          for (let k = 0; k < NB; k++) if (t.buildings[k] && rng.chance(0.2)) t.buildings[k]--;
          w.wearB += 0.25;
          const gen = this.person(state, 'general', ac, rng, `${t.name}を攻め落とした`);
          const raze = t.pop < 20000 && rng.chance(0.1 + 0.15 * a.values[V.aggression] + (w.cause === '宗教の対立' ? 0.1 : 0));
          if (raze) {
            chronicle(state, 'war', `${a.name}の${gen.name}が${t.name}を攻め落とし、街を焼き払った。`, { cell: t.cell, polity: a.id });
            this.ruin(state, t, rng, '戦火');
          } else {
            chronicle(state, 'war', `${a.name}の${gen.name}が${b.name}の${t.name}を征服した。`, { cell: t.cell, polity: a.id });
          }
          this.dirty = true;
          if (!civ.settlements.some((s) => s.polity === b.id)) {
            end(`${b.name}は${a.name}に併合された。`);
            continue;
          }
        } else {
          w.wearA += 0.15;
        }
      }
      if (w.wearA > 1.2 || w.wearB > 1.2) end(`${a.name}と${b.name}が和平を結んだ（${w.battles}度の戦い）。`);
    }
  }

  // ================================================================ culture

  private culture(state: WorldState, h: number, rng: Rng): void {
    const civ = state.civ;
    const sq = Math.sqrt(h);
    for (const s of civ.settlements) {
      const lit = Math.min(1, s.fx[F.literacy]);
      for (let d = 0; d < LANG_DIM; d++) s.lang[d] += 0.004 * sq * (1 - 0.6 * lit) * rng.normal();
      const p = this.polity(state, s.polity);
      const cap = p ? this.byId(state, p.capital) : undefined;
      if (cap && cap !== s) for (let d = 0; d < LANG_DIM; d++) s.lang[d] += (cap.lang[d] - s.lang[d]) * Math.min(1, 0.004 * h * (1 + s.fx[F.admin]));
      for (let d = 0; d < LANG_DIM; d++) s.lang[d] = Math.max(0, Math.min(1, s.lang[d]));
      for (let k = 0; k < 5; k++) {
        s.values[k] += 0.003 * sq * rng.normal();
        if (p) s.values[k] += (p.values[k] - s.values[k]) * Math.min(1, 0.01 * h);
      }
      if (civ.wars.some((w) => w.a === s.polity || w.b === s.polity)) s.values[V.aggression] += 0.004 * h;
      if (s.religion >= 0) {
        const rel = civ.religions.find((r) => r.id === s.religion);
        if (rel) {
          const dv = DOCTRINES[rel.doctrine].dv;
          for (let k = 0; k < 5; k++) s.values[k] += dv[k] * 0.02 * h * s.devotion;
        }
      }
      for (let k = 0; k < 5; k++) s.values[k] = Math.max(0.02, Math.min(0.98, s.values[k]));
      // Language identity: drift far enough from your language and you speak a new one.
      const L = civ.languages.find((l) => l.id === s.langId);
      if (L && languageDistance(s.lang, L.vec) > 0.16) {
        let joined = false;
        for (const o of civ.languages) {
          if (o.speakers > 0 && languageDistance(s.lang, o.vec) < 0.08) { s.langId = o.id; joined = true; break; }
        }
        if (!joined) {
          const seed = rng.u32();
          const id = civ.nextId++;
          const name = makeName(phonologyFrom(s.lang, seed), rng) + '語';
          civ.languages.push({ id, name, parent: L.id, founded: state.time, vec: Array.from(s.lang), seed, speakers: s.pop });
          s.langId = id;
          if (s.pop > 3000) chronicle(state, 'civ', `${s.name}の言葉が${L.name}から分かれ、${name}となった。`, { cell: s.cell, polity: s.polity });
        }
      }
    }
    // Language prototypes follow their speakers.
    for (const L of civ.languages) {
      let w = 0;
      const acc = new Array(LANG_DIM).fill(0);
      for (const s of civ.settlements) if (s.langId === L.id) { w += s.pop; for (let d = 0; d < LANG_DIM; d++) acc[d] += s.lang[d] * s.pop; }
      L.speakers = w;
      if (w > 0) L.vec = acc.map((v) => v / w);
    }
  }

  private religion(state: WorldState, h: number, rng: Rng): void {
    const civ = state.civ;
    // New faiths are born of crises and omens.
    for (const tr of this.triggers) {
      const s = tr.s;
      if (!civ.settlements.includes(s) || s.pop < 3000) continue;
      if (!(s.religion < 0 || s.devotion < 0.35 || rng.chance(0.08))) continue;
      if (!rng.chance(tr.cause === 'war' ? 0.03 : 0.3)) continue;
      const deity = tr.cause === 'sky' ? 0 : tr.cause === 'famine' ? rng.pick([3, 7]) : tr.cause === 'plague' ? rng.pick([3, 4]) : tr.cause === 'volcano' ? 6 : tr.cause === 'prosperity' ? rng.pick([1, 7]) : rng.pick([2, 5, 4]);
      const prophet = this.person(state, 'prophet', s, rng, '新しい教えを説いた');
      const id = civ.nextId++;
      const word = DEITIES[deity].word;
      const name = rng.chance(0.5) ? `${prophet.name.slice(0, 3)}教` : `${word}の${makeName(phonologyFrom(s.lang, 7), rng).slice(0, 4)}教`;
      const causeText = { famine: '飢饉', plague: '疫病', sky: '天の異変', volcano: '噴火', prosperity: '繁栄', war: '戦乱' }[tr.cause];
      civ.religions.push({ id, name, founded: state.time, origin: s.name, deity, doctrine: rng.int(DOCTRINES.length), color: COLORS[(civ.religions.length * 7 + 3) % COLORS.length], followers: s.pop, prophet: prophet.id, cause: causeText });
      s.religion = id;
      s.devotion = 0.6;
      const rel = civ.religions[civ.religions.length - 1];
      chronicle(state, 'religion', `${causeText}の後、${s.name}で${prophet.name}が${DEITIES[deity].name}の「${name}」を開いた（教え：${DOCTRINES[rel.doctrine].name}）。`, { cell: s.cell, polity: s.polity });
    }
    // Spreading the word along trade routes and through the state.
    for (const l of civ.links) {
      const A = this.byId(state, l.a), B = this.byId(state, l.b);
      if (!A || !B) continue;
      for (const [x, y] of [[A, B], [B, A]] as const) {
        if (x.religion < 0 || y.religion === x.religion) continue;
        const rel = civ.religions.find((r) => r.id === x.religion);
        const missionary = rel && DOCTRINES[rel.doctrine].name === '布教' ? 2 : 1;
        if (rng.chance(1 - Math.exp(-0.01 * h * (0.5 + x.devotion) * missionary * (1 - 0.5 * y.devotion)))) {
          y.religion = x.religion;
          y.devotion = 0.4;
        }
      }
    }
    for (const s of civ.settlements) {
      const p = this.polity(state, s.polity);
      if (p && p.religion >= 0 && s.religion !== p.religion && rng.chance(1 - Math.exp(-0.01 * h))) { s.religion = p.religion; s.devotion = 0.3; }
      const temples = s.buildings[BUILDING_INDEX.temple] + s.buildings[BUILDING_INDEX.cathedral] + s.buildings[BUILDING_INDEX.shrine];
      s.devotion += (s.values[V.piety] * 0.6 + 0.08 * temples - s.devotion) * Math.min(1, 0.02 * h);
    }
    for (const r of civ.religions) r.followers = 0;
    for (const s of civ.settlements) {
      const r = civ.religions.find((x) => x.id === s.religion);
      if (r) r.followers += s.pop;
    }
  }

  private plague(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    let world = 0;
    for (const s of civ.settlements) world += s.pop;
    for (const s of civ.settlements) {
      // Medicine: nursing and herbs a little, germ theory and antibiotics a lot.
      let healthRed = Math.min(0.97, 0.22 * (s.fx[F.health] + this.bfx(s, F.health) + s.buffs.health));
      if (techKnown(s, 'germ_theory', 0.3)) healthRed = Math.max(healthRed, 0.75);
      if (techKnown(s, 'antibiotics', 0.3)) healthRed = Math.max(healthRed, 0.9);
      if (s.plague < 0) {
        s.plagueToll = 0;
        // Spillovers grow with people living close to animals; surveillance and
        // public health stop most before they become epidemics. A world of a
        // billion sees a new epidemic every few years, an ancient one every few
        // decades.
        const animals = s.tech[TECH.husbandry.index] > 0.3 ? 3 : 1;
        const dense = s.urban > 0.15 ? 2 : 1;
        const p = rules.civilization.plagueRate * 8e-7 * (s.pop / 1e4) * animals * dense * (1 - 0.6 * healthRed) * h;
        if (s.pop > 5000 && rng.chance(p)) {
          const bio = state.bio;
          const hosts = bio.living.map((id) => bio.species.get(id)!).filter((sp) => sp.habitat === 0 && sp.clade === 'mammal' && bio.density[sp.slot * this.eco.R + s.region] > 0);
          const host = hosts.length ? rng.pick(hosts).name : '野生動物';
          const id = civ.nextId++;
          const name = makeName(phonologyFrom(s.lang, 99), rng).slice(0, 4) + rng.pick(['熱', '病', '疫', '咳病', '斑病']);
          const r0 = 1.4 + 4 * rng.next();
          // Most new diseases kill under a few percent; a rare few (smallpox, plague) far more.
          civ.pathogens.push({ id, name, born: state.time, r0, lethality: 0.004 + 0.3 * rng.next() ** 3, origin: s.name, deaths: 0, cases: 0, host });
          this.infect(s, id, r0);
          chronicle(state, 'disaster', `${host}から人へ新しい病「${name}」が移り、${s.name}で流行が始まった。`, { cell: s.cell, polity: s.polity });
        }
        continue;
      }
      const path = civ.pathogens.find((x) => x.id === s.plague);
      if (!path) { s.plague = -1; continue; }
      const frac = Math.min(1, h / Math.max(0.1, s.plagueLeft));
      // Vaccines and public health cut the share who catch it.
      const shield = techKnown(s, 'vaccine', 0.3) ? 0.25 : techKnown(s, 'sanitation', 0.3) ? 0.7 : 1;
      const cases = s.pop * s.plagueAttack * frac * shield;
      const dead = cases * path.lethality * (1 - healthRed);
      s.plagueToll = dead / Math.max(1, s.pop) / Math.max(1e-3, h);
      s.pop -= dead;
      path.deaths += dead;
      path.cases += cases;
      civ.deathsPlague += dead;
      s.plagueLeft -= h;
      const before = path.deaths - dead;
      for (const th of [1e5, 1e6, 1e7, 1e8]) {
        if (before < th && path.deaths >= th) {
          const share = (path.deaths / Math.max(1, world)) * 100;
          chronicle(state, 'disaster', `「${path.name}」の大流行で累計${fmt(th)}人以上が亡くなった（世界人口の${share >= 0.1 ? `約${share.toFixed(1)}%` : '0.1%未満'}）。`, { cell: s.cell });
        }
      }
      if (dead > s.pop * 0.05) this.triggers.push({ s, cause: 'plague' });
      if (s.plagueLeft <= 0) {
        s.immune = Math.max(s.immune, s.plagueAttack);
        s.plague = -1;
        s.plagueToll = 0;
      }
    }
    // Spread along trade routes; quarantine (medicine) slows it.
    for (const l of civ.links) {
      const A = this.byId(state, l.a), B = this.byId(state, l.b);
      if (!A || !B) continue;
      for (const [x, y] of [[A, B], [B, A]] as const) {
        if (x.plague < 0 || y.plague >= 0 || y.immune > 0.5) continue;
        const path = civ.pathogens.find((p) => p.id === x.plague);
        if (!path) continue;
        const quarantine = Math.max(x.fx[F.health], y.fx[F.health]) > 1 ? 0.4 : 1;
        const p = 1 - Math.exp(-h * path.r0 * 0.2 * (l.volume > 0 ? 1 + Math.log10(1 + l.volume) : 0.3) * quarantine);
        if (rng.chance(p)) {
          if (rng.chance(0.1)) {
            const id = civ.nextId++;
            const r0 = path.r0 * Math.exp(0.1 * rng.normal());
            // Variants spread better but tend to grow milder (a dead host spreads nothing).
            const base = path.name.replace(/・\d+型$/, '');
            const kin = civ.pathogens.reduce((n, q) => n + (q.name === base || q.name.startsWith(base + '・') ? 1 : 0), 0);
            civ.pathogens.push({ ...path, id, name: `${base}・${kin + 1}型`, r0, lethality: Math.min(0.4, path.lethality * Math.exp(0.2 * rng.normal() - 0.15)), born: state.time, deaths: 0, cases: 0, origin: y.name });
            this.infect(y, id, r0);
          } else this.infect(y, path.id, path.r0);
        }
      }
    }
    for (const s of civ.settlements) s.immune *= Math.exp(-h / 40);
  }

  infect(s: Settlement, id: number, r0: number): void {
    const S = Math.max(0, 1 - s.immune);
    let A = 0.5;
    for (let k = 0; k < 30; k++) A = S * (1 - Math.exp(-r0 * A));
    s.plague = id;
    s.plagueAttack = Math.max(0.01, A);
    s.plagueLeft = 1 + Math.min(2, r0 / 3);
  }

  // ================================================================ magic

  /**
   * The mana field: wells up at plate boundaries, hotspots and old forests,
   * decays and seeps to neighbours. A natural law, so it runs from genesis
   * (before anyone lives to use it). dm/dt = S − d·m is integrated exactly, so
   * deep-time steps of millions of years land on the equilibrium S/d.
   */
  manaField(state: WorldState, rules: RulePack, h: number): void {
    const f = state.fields;
    const M = rules.magic;
    const m = state.mesh;
    if (!this.manaSrc || Math.abs(state.time - this.manaSrcAt) > 1000) {
      this.updateProd(state);
      const src = (this.manaSrc ??= new Float32Array(this.n));
      src.fill(0);
      for (let c = 0; c < this.n; c++) {
        let v = Math.abs(f.stress[c]) > 0.02 ? 1 : 0;
        if (this.isLand(state, c) && this.forest[c] > 0.6 && f.landUse[c] === 0) v += 0.5;
        src[c] = v;
      }
      for (const hs of state.hotspots) src[hs] += 2;
      this.manaSrcAt = state.time;
    }
    const src = this.manaSrc;
    const arcane = rules.astrology.arcane ? state.magic.arcane : 1;
    const civ = state.civ;
    const aligned = new Set(civ.settlements.filter((s) => s.aligned).map((s) => s.cell));
    const keep = Math.exp(-M.decayPerYear * h);
    const gain = M.decayPerYear > 0 ? (1 - keep) / M.decayPerYear : h;
    for (let c = 0; c < this.n; c++) {
      const boost = aligned.has(c) ? 5 : 0;
      f.mana[c] = f.mana[c] * keep + (src[c] + boost) * M.sourceRate * arcane * gain;
    }
    // Mana seeps to neighbours.
    const next = (this.manaNext ??= new Float32Array(this.n));
    for (let c = 0; c < this.n; c++) {
      let s = 0;
      const a = m.nbrStart[c], b = m.nbrStart[c + 1];
      for (let k = a; k < b; k++) s += f.mana[m.nbr[k]];
      next[c] = 0.8 * f.mana[c] + 0.2 * (s / (b - a));
    }
    f.mana.set(next);
    touch(state, 'mana');
  }

  private magic(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    const f = state.fields;
    const M = rules.magic;
    this.manaField(state, rules, h);
    // Settlements draw on the field; mages compose spells for their needs.
    for (const s of civ.settlements) {
      const level = s.fx[F.magic] + this.bfx(s, F.magic);
      if (level <= 0) continue;
      const demand = level * 0.05 * h;
      const use = Math.min(f.mana[s.cell] * 0.5, demand);
      f.mana[s.cell] -= use;
      const power = demand > 0 ? use / demand : 0;
      s.buffs.food += 0.02 * power * level;
      s.buffs.health += 0.02 * power * level;
      if (level > 0.5 && rng.chance(1 - Math.exp(-0.01 * h))) {
        const pressure = s.pop / Math.max(1, s.K);
        const need = s.plague >= 0 ? 'heal' : pressure > 0.9 ? (state.fields.moisture[s.cell] < 0.35 ? 'rain' : 'harvest') : civ.wars.some((w) => w.b === s.polity) ? 'ward' : state.fields.tempMean[s.cell] < 0 ? 'warm' : 'harvest';
        const spell = inventSpell(need, M.elements, rng);
        const name = `${s.name}の${spell.name}`;
        if (!civ.spells.some((x) => x.name === name)) {
          const plan = planSpell(spell.nodes, { skill: Math.min(1, level / 2), potency: M.potency, elements: M.elements });
          if (plan.ok) {
            civ.spells.push({ name, nodes: spell.nodes, by: s.name, time: state.time });
            const mage = this.person(state, 'mage', s, rng, `呪文「${spell.name}」を編み出した`);
            chronicle(state, 'magic', `${s.name}の魔術師${mage.name}が呪文「${spell.name}」を編み出した：${plan.summary}`, { cell: s.cell, polity: s.polity });
          }
        }
        castSpell(state, rules, this.eco, spell.nodes, s.cell, Math.min(1, level / 2), rng, `${s.name}の魔術師`, s.stock[G.mana] * 50);
      }
    }
    this.golems(state, rules, h, rng);
  }

  private golems(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    for (const s of civ.settlements) {
      if (!s.buildings[BUILDING_INDEX.golem_workshop]) continue;
      const mine = civ.golems.filter((g) => g.settlement === s.id && g.state !== 'rampant');
      if (mine.length < 3 && s.stock[G.mana] > 0.5 && rng.chance(1 - Math.exp(-0.05 * h))) {
        const material = (s.deposits & DEP.mana) ? 'crystal' : techKnown(s, 'iron') ? 'iron' : rng.chance(0.5) ? 'stone' : 'clay';
        const cap = { clay: 2, stone: 4, iron: 6, crystal: 12 }[material];
        civ.golems.push({ id: civ.nextId++, settlement: s.id, material, routine: defaultRoutine(rng), durability: cap * 10, mana: cap, manaCap: cap, state: 'working', built: state.time, output: '' });
        s.stock[G.mana] -= 0.5;
      }
    }
    for (const g of [...civ.golems]) {
      const s = this.byId(state, g.settlement);
      if (!s) {
        if (g.state !== 'rampant') civ.golems.splice(civ.golems.indexOf(g), 1);
        continue;
      }
      if (g.state === 'rampant') {
        s.pop *= Math.exp(-0.01 * h);
        if (rng.chance(1 - Math.exp(-0.2 * h * (1 + s.fx[F.military] + s.buffs.defense)))) {
          civ.golems.splice(civ.golems.indexOf(g), 1);
          chronicle(state, 'magic', `${s.name}の人々が暴走ゴーレムを打ち倒した。`, { cell: s.cell });
        }
        continue;
      }
      // Upkeep: crystals first, then the local field.
      const upkeep = 0.2 * h;
      const fromStock = Math.min(s.stock[G.mana], upkeep);
      s.stock[G.mana] -= fromStock;
      const fromField = Math.min(state.fields.mana[s.cell], (upkeep - fromStock) * 0.05);
      state.fields.mana[s.cell] -= fromField;
      g.mana = Math.min(g.manaCap, g.mana + fromStock + fromField * 20 - upkeep * 0.5);
      g.durability -= 0.1 * h;
      if (g.mana <= 0) {
        g.state = 'idle';
        if (rng.chance(1 - Math.exp(-0.02 * h))) {
          g.state = 'rampant';
          chronicle(state, 'magic', `マナの尽きた${s.name}のゴーレムが暴走を始めた。`, { cell: s.cell });
        }
        continue;
      }
      if (g.durability <= 0) { civ.golems.splice(civ.golems.indexOf(g), 1); continue; }
      g.state = 'working';
      const atWar = civ.wars.some((w) => w.a === s.polity || w.b === s.polity);
      const res = runRoutine(g.routine, (what) => {
        switch (what) {
          case 'enemy': return atWar ? 1 : 0;
          case 'crop': return s.K / Math.max(1, s.pop);
          case 'ore': return s.deposits & (DEP.copper | DEP.iron | DEP.mana) ? 1 : 0;
          case 'stock': return s.stock[G.tools] / Math.max(1e-6, s.demand[G.tools]);
          case 'mana': return g.mana / g.manaCap;
        }
        return 0;
      });
      const k = { clay: 0.5, stone: 1, iron: 1.5, crystal: 2.5 }[g.material];
      switch (res.act) {
        case 'guard': s.buffs.defense += 0.03 * k; break;
        case 'farm': s.buffs.food += 0.02 * k; break;
        case 'mine': s.stock[G.iron] += 50 * k * h; s.stock[G.mana] += 0.05 * k * h; break;
        case 'trade': s.wealth += 100 * k * h; break;
        case 'haul': s.stock[G.food] += 200 * k * h; break;
        case 'build': s.buildProgress += 0.5 * k * h; break;
      }
      g.output = res.act ?? '';
    }
    for (const s of civ.settlements) s.golems = civ.golems.filter((g) => g.settlement === s.id && g.state === 'working').length;
    void rules;
  }

  // ================================================================ sky

  private sky(state: WorldState, rules: RulePack, h: number, rng: Rng): void {
    const civ = state.civ;
    const sys = state.system;
    if (rules.astrology.arcane) state.magic.arcane = arcaneFactor(sys, state.time, rules.astrology.orbDeg);
    // Monuments drift out of alignment as the axial tilt changes.
    for (const s of civ.settlements) {
      if (!Number.isFinite(s.megaAzimuth)) continue;
      const az = solsticeSunriseAzimuth(state.mesh.lat[s.cell], state.climate.tiltDeg);
      const was = s.aligned;
      s.aligned = Number.isFinite(az) && Math.abs(az - s.megaAzimuth) < 0.8;
      if (s.aligned) s.buffs.morale += 0.02 * h;
      if (was && !s.aligned && s.pop > 1000) chronicle(state, 'sky', `地軸の傾きが変わり、${s.name}の巨石建造物はもう夏至の日の出と揃わなくなった。`, { cell: s.cell });
    }
    if (!civ.settlements.length) return;
    const events = skyEvents(sys, state.seed, state.time, state.time + h, 6);
    for (const ev of events) {
      if (ev.kind === 'conjunction' && rng.chance(0.7)) continue;
      const observers = civ.settlements.filter(() => rng.chance(0.3)).slice(0, 4);
      if (!observers.length) continue;
      const astronomers = observers.filter((s) => techKnown(s, 'astronomy'));
      if (astronomers.length && rng.chance(0.4)) {
        chronicle(state, 'sky', `${astronomers[0].name}の天文学者が予言した通り、${ev.text}。`, { cell: astronomers[0].cell });
      } else if (rng.chance(0.25)) {
        chronicle(state, 'sky', `${observers[0].name}の人々は${ev.text}のを見て恐れおののいた。`, { cell: observers[0].cell });
      }
      for (const s of observers) {
        if (!techKnown(s, 'astronomy')) {
          s.buffs.morale -= 0.05;
          this.triggers.push({ s, cause: 'sky' });
        }
      }
    }
  }

  // ================================================================ hazards

  private disasters(state: WorldState, h: number, rng: Rng): void {
    const civ = state.civ;
    const f = state.fields;
    const m = state.mesh;
    for (const s of [...civ.settlements]) {
      // The sea rose over the town: move to the nearest dry cell or perish.
      if (!this.isLand(state, s.cell)) {
        const e = this.catch.get(s.id);
        const dry = e?.cells.find((c) => this.isLand(state, c));
        if (dry !== undefined) {
          chronicle(state, 'climate', `海面上昇で${s.name}の旧市街が水没し、人々は内陸へ移った。`, { cell: s.cell });
          s.cell = dry;
          s.region = this.eco.cellRegion[dry];
          this.dirty = true;
        } else {
          chronicle(state, 'climate', `${s.name}は海に沈んだ。`, { cell: s.cell });
          this.ruin(state, s, rng, '水没');
          continue;
        }
      }
      let stress = Math.abs(f.stress[s.cell]);
      for (let k = m.nbrStart[s.cell]; k < m.nbrStart[s.cell + 1]; k++) stress = Math.max(stress, Math.abs(f.stress[m.nbr[k]]));
      if (stress > 0.05 && rng.chance(1 - Math.exp(-h * 0.004 * Math.min(1, stress * 2)))) {
        const resist = techKnown(s, 'engineering') ? 0.5 : 1;
        const dead = s.pop * rng.range(0.005, 0.05) * resist;
        s.pop -= dead;
        if (dead > 2000) chronicle(state, 'disaster', `${s.name}を大地震が襲い、約${fmt(dead)}人が亡くなった。`, { cell: s.cell, polity: s.polity });
        for (let b = 0; b < NB; b++) if (s.buildings[b] && rng.chance(0.08 * resist)) s.buildings[b]--;
      }
      const volcanic = state.hotspots.some((hs) => distanceKm(m, hs, s.cell) < 300) || (stress > 0.4 && f.crustThickness[s.cell] < 40);
      if (volcanic && rng.chance(1 - Math.exp(-h * 0.0006))) {
        const dead = s.pop * rng.range(0.02, 0.15);
        s.pop -= dead;
        state.climate.aerosolCooling += 0.3;
        chronicle(state, 'disaster', `${s.name}近くの火山が大噴火し、約${fmt(dead)}人が亡くなった。`, { cell: s.cell, polity: s.polity });
        this.triggers.push({ s, cause: 'volcano' });
      }
      if (s.wealth > s.pop * 2 && s.values[V.piety] > 0.6 && rng.chance(0.002 * h)) this.triggers.push({ s, cause: 'prosperity' });
    }
    // Asteroid impacts reported by the biosphere this tick.
    for (const ev of state.events) {
      if (ev.kind !== 'impact' || ev.time !== state.time || ev.handled) continue;
      ev.handled = true;
      for (const s of [...civ.settlements]) {
        const km = distanceKm(m, ev.cell, s.cell);
        const kill = km < 1500 ? 0.9 : km < 5000 ? 0.4 * ev.magnitude : 0.15 * ev.magnitude;
        s.pop *= 1 - kill;
        if (s.pop < 30) this.ruin(state, s, rng, '天体衝突');
      }
    }
  }

  // ================================================================ space

  private space(state: WorldState, h: number, rng: Rng): void {
    const civ = state.civ;
    const sys = state.system;
    const best = civ.settlements.reduce<Settlement | null>((b, s) => (!b || s.fx[F.space] > b.fx[F.space] ? s : b), null);
    if (!best) return;
    const milestone = (id: string, text: string) => {
      if (civ.spaceMilestones.includes(id) || !techKnown(best, id, 0.2)) return false;
      civ.spaceMilestones.push(id);
      const pol = this.polity(state, best.polity);
      chronicle(state, 'space', `${pol ? pol.name : best.name}：${text}`, { cell: best.cell, polity: best.polity });
      return true;
    };
    milestone('rocketry', '初めてのロケットが宇宙空間に達した。');
    milestone('satellite', '最初の人工衛星が軌道に乗った。');
    milestone('spaceflight', '最初の宇宙飛行士が星を一周して帰還した。');
    milestone('space_station', '軌道上に宇宙ステーションが組み上がった。');
    if (milestone('lunar_base', `${sys.moons.length ? sys.bodies[sys.moons[0]].name : '小惑星'}に最初の基地が築かれた。`) && sys.moons.length) {
      civ.colonies.push({ id: civ.nextId++, body: sys.moons[0], name: `${sys.bodies[sys.moons[0]].name}基地`, pop: 40, founded: state.time, polity: best.polity, terraform: 0 });
    }
    if (techKnown(best, 'colonization', 0.2) && best.buildings[BUILDING_INDEX.spaceport] && rng.chance(1 - Math.exp(-0.01 * h))) {
      const targets = sys.bodies.filter((b) => !b.home && b.kind !== 'gas' && b.kind !== 'icegiant' && b.habitability > 0.02 && !civ.colonies.some((c) => c.body === b.id));
      if (targets.length) {
        // Launch in the best transfer window.
        targets.sort((a, b) => transferCost(sys, a.id, state.time) / a.habitability - transferCost(sys, b.id, state.time) / b.habitability);
        const tg = targets[0];
        civ.colonies.push({ id: civ.nextId++, body: tg.id, name: `新${tg.name}`, pop: 200, founded: state.time, polity: best.polity, terraform: 0 });
        chronicle(state, 'space', `${this.polity(state, best.polity)?.name ?? best.name}の入植船が${tg.name}に到着し、植民地「新${tg.name}」が生まれた（移動コスト ${transferCost(sys, tg.id, state.time).toFixed(1)}）。`, { polity: best.polity });
      }
    }
    milestone('starship', '恒星間船が完成し、乗員を乗せて隣の星へ旅立った。');
    const terraform = techKnown(best, 'terraforming', 0.2);
    const support = techKnown(best, 'life_support', 0.2);
    for (const c of [...civ.colonies]) {
      const body = sys.bodies[c.body];
      if (terraform) c.terraform = Math.min(1, c.terraform + 0.001 * h);
      const habit = Math.min(1, body.habitability + c.terraform);
      const cap = 2e4 + 5e7 * habit * habit;
      const r = support ? 0.025 : -0.02;
      c.pop += c.pop * r * (1 - c.pop / cap) * h;
      if (c.pop < 5) {
        chronicle(state, 'space', `${c.name}の植民地は生命維持に失敗して放棄された。`, { polity: c.polity });
        civ.colonies.splice(civ.colonies.indexOf(c), 1);
      }
    }
    if (civ.colonies.length) updateBodyClimates(sys, state.time);
  }

  // ================================================================ ruins & artifacts

  private ruin(state: WorldState, s: Settlement, rng: Rng, why: string): void {
    const civ = state.civ;
    const i = civ.settlements.indexOf(s);
    if (i < 0) return;
    civ.settlements.splice(i, 1);
    const pol = this.polity(state, s.polity);
    const era = civEra(s);
    const rampant = civ.golems.find((g) => g.settlement === s.id && g.state === 'rampant');
    const apex = this.apexPredator(state, s);
    civ.ruins.push({
      cell: s.cell, name: s.name, time: state.time, pop: s.peakPop, era, polity: pol?.name ?? '',
      buildings: Array.from(s.buildings), guardian: rampant ? `暴走した${{ clay: '土', stone: '石', iron: '鉄', crystal: '魔晶' }[rampant.material]}のゴーレム` : apex ? `${apex}の群れ` : '',
    });
    if (civ.ruins.length > 600) civ.ruins.shift();
    civ.golems = civ.golems.filter((g) => g.settlement !== s.id || g.state === 'rampant');
    // What it knew is buried with it.
    const known = TECHS.filter((t) => s.tech[t.index] > 0.3).sort((a, b) => b.era - a.era);
    const make = (kind: Artifact['kind'], text: string, tech = -1, spell: Artifact['spell'] = null) =>
      civ.artifacts.push({ id: civ.nextId++, kind, cell: s.cell, depth: 0.5, time: state.time, from: s.name, langId: s.langId, tech, spell, text, found: false, decipherAt: -1, progress: 0 });
    const deed = [...state.chronicle].reverse().find((c) => c.cell === s.cell && c.kind !== 'sky');
    make('inscription', deed ? deed.text : `${s.name}の人々の祈りの言葉`);
    if (known.length && known[0].era >= 2) make('blueprint', `「${known[0].name}」の作り方を記した${era >= 5 ? '書物' : '粘土板'}`, known[0].index);
    const spell = civ.spells.find((x) => x.by === s.name);
    if (spell) make('grimoire', `呪文「${spell.name}」の魔導書`, -1, spell.nodes);
    if (rng.chance(0.4)) make('relic', `${s.name}の王の宝飾品`);
    if (civ.artifacts.length > 1500) civ.artifacts.splice(0, civ.artifacts.length - 1500);
    if (s.peakPop > 5000) chronicle(state, 'civ', `${s.name}は${why}で廃墟となった。`, { cell: s.cell, polity: s.polity });
    this.dirty = true;
  }

  private apexPredator(state: WorldState, s: Settlement): string | null {
    const bio = state.bio;
    let best: { name: string; m: number } | null = null;
    for (const id of bio.living) {
      const sp = bio.species.get(id)!;
      if (sp.diet === 2 && sp.habitat === 0 && bio.density[sp.slot * this.eco.R + s.region] > 0 && (!best || sp.massKg > best.m)) best = { name: sp.name, m: sp.massKg };
    }
    return best && best.m > 20 ? best.name : null;
  }

  private archaeology(state: WorldState, h: number, rng: Rng): void {
    const civ = state.civ;
    const f = state.fields;
    for (const a of civ.artifacts) {
      if (a.found) continue;
      // Sediment buries, steep and high ground erodes.
      const h0 = f.elevation[a.cell] - state.seaLevel;
      a.depth = Math.max(0, a.depth + h * (0.0008 * f.moisture[a.cell] - (h0 > 1500 ? 0.0006 : 0)));
    }
    for (const a of civ.artifacts) {
      if (!a.found || a.decipherAt < 0 || a.progress >= 1) continue;
      const s = this.byId(state, a.decipherAt);
      if (!s) { a.decipherAt = -1; continue; }
      const L = civ.languages.find((l) => l.id === a.langId);
      const ld = L ? languageDistance(L.vec, s.lang) : 0.5;
      a.progress += (h / (5 + 150 * ld)) * (1 + s.fx[F.literacy]);
      if (a.progress >= 1) {
        a.progress = 1;
        if (a.tech >= 0 && s.tech[a.tech] <= 0) {
          s.tech[a.tech] = 0.1;
          chronicle(state, 'tech', `${s.name}の学者が${a.from}の遺物を解読し、失われた技術「${TECHS[a.tech].name}」が復興した。`, { cell: s.cell });
        } else if (a.spell) {
          civ.spells.push({ name: `${a.from}の古呪文`, nodes: a.spell, by: s.name, time: state.time });
          chronicle(state, 'magic', `${s.name}で古い魔導書が解読され、${a.from}の呪文がよみがえった。`, { cell: s.cell });
        } else {
          chronicle(state, 'civ', `${a.from}の碑文が解読された：「${a.text}」`, { cell: s.cell });
        }
      }
    }
    // Scientific archaeology digs up what lies near the surface.
    for (const s of civ.settlements) {
      if (!techKnown(s, 'scientific_method') || !rng.chance(1 - Math.exp(-0.002 * h))) continue;
      const e = this.catch.get(s.id);
      if (!e) continue;
      const cells = new Set(e.cells);
      const a = civ.artifacts.find((x) => !x.found && x.depth < 5 && cells.has(x.cell));
      if (a) {
        a.found = true;
        a.decipherAt = s.id;
        chronicle(state, 'civ', `${s.name}の考古学者が${a.from}の遺跡から${ARTIFACT_NAMES[a.kind]}を発掘した。`, { cell: a.cell });
      }
    }
  }

  // ================================================================ people of note

  person(state: WorldState, role: Role, s: Settlement, rng: Rng, deed: string): Person {
    const civ = state.civ;
    const name = makeName(phonologyFrom(s.lang, civ.languages.find((l) => l.id === s.langId)?.seed ?? 1), rng);
    const age = role === 'player' ? 16 : rng.range(20, 50);
    const born = state.time - age;
    const health = s.fx[F.health];
    const lifespan = 40 + 12 * Math.min(3, health) + 10 * rng.normal();
    const chart = birthChart(state.system, born, (state.mesh.lon[s.cell] * 180) / Math.PI, this.zodiac(state));
    const p: Person = {
      id: civ.nextId++, name, born, died: -1, lifespan: Math.max(25, lifespan), role, settlement: s.id, polity: s.polity,
      chart: chart.text, traits: chart.traits, deeds: [deed],
    };
    civ.persons.push(p);
    if (civ.persons.length > 2500) {
      const i = civ.persons.findIndex((x) => x.role !== 'player' && x.died >= 0);
      civ.persons.splice(i >= 0 ? i : 0, 1);
    }
    return p;
  }

  /** The zodiac names of the first literate culture (computed once). */
  zodiac(state: WorldState): string[] {
    const seed = state.civ.languages[0]?.seed ?? state.seed;
    if (this.signSeed !== seed) {
      this.signs = constellations(state.system, seed).filter((c) => c.zodiac).map((c) => c.name);
      this.signSeed = seed;
    }
    return this.signs;
  }

  private persons(state: WorldState, rng: Rng): void {
    const civ = state.civ;
    for (const p of civ.persons) {
      if (p.died < 0 && state.time > p.born + p.lifespan) {
        p.died = state.time;
        if (p.role === 'player') chronicle(state, 'civ', `${p.name}（あなたの前世）が${fmtYears(state.time - p.born)}の生涯を終えた。${p.deeds.slice(-3).join('、')}。`);
      }
    }
    void rng;
  }

  // ================================================================ climate & bookkeeping

  private emissions(state: WorldState, rules: RulePack): void {
    let e = 0;
    for (const s of state.civ.settlements) {
      const fossil = Math.max(0, Math.min(1, s.fx[F.fossil] - s.fx[F.renew] - this.bfx(s, F.renew)));
      let emitting = 0;
      for (let b = 0; b < NB; b++) if (BUILDINGS[b].emits) emitting += s.buildings[b] * BUILDINGS[b].emits!;
      e += s.pop * (s.fx[F.energy] / 7) * fossil * rules.civilization.emissionPerCapitaPpm * (1 + 0.02 * emitting);
    }
    state.climate.emissionRate = e;
  }

  private bookkeeping(state: WorldState, rng: Rng): void {
    const civ = state.civ;
    for (const s of [...civ.settlements]) {
      if (s.pop < 30) {
        this.ruin(state, s, rng, '人口の流出');
        continue;
      }
    }
    let total = 0;
    for (const s of civ.settlements) total += s.pop;
    for (const c of civ.colonies) total += c.pop;
    civ.totalPop = total;
    if (!civ.settlements.length && civ.started >= 0 && state.bio.sapientId >= 0) {
      const sp = state.bio.species.get(state.bio.sapientId);
      if (sp && !civ.colonies.length) {
        chronicle(state, 'civ', `最後の集落が消え、${sp.name}の文明は途絶えた。`);
        this.eco.extinguish(state, sp, '文明の崩壊');
      }
    }
  }

  // ================================================================ quests

  private quests(state: WorldState, rules: RulePack, rng: Rng): void {
    const civ = state.civ;
    const bio = state.bio;
    const open = civ.quests.filter((q) => q.status === 'open');
    // Check open ones.
    for (const q of open) {
      if (q.kind === 'protect') {
        const sp = bio.species.get(q.target);
        if (!sp || sp.died >= 0) q.status = 'failed';
        else if (sp.pop > q.baseline * 3) q.status = 'done';
      } else if (q.kind === 'cull') {
        const sp = bio.species.get(q.target);
        if (!sp || sp.died >= 0 || sp.pop < q.baseline * 0.4) q.status = 'done';
      } else if (q.kind === 'epidemic' || q.kind === 'famine') {
        const s = this.byId(state, q.target);
        if (!s) q.status = 'failed';
        else if (q.kind === 'epidemic' ? s.plague < 0 : s.pop <= s.K) q.status = 'done';
      } else if (q.kind === 'mana') {
        if (state.fields.mana[q.cell] > q.baseline * 3) q.status = 'done';
      } else if (q.kind === 'excavate') {
        const a = civ.artifacts.find((x) => x.id === q.target);
        if (!a || a.found) q.status = 'done';
      }
    }
    if (open.length >= 6 || !rng.chance(0.2)) return;
    const add = (q: Omit<typeof civ.quests[number], 'id' | 'created' | 'status'>) => {
      if (civ.quests.some((x) => x.status === 'open' && x.kind === q.kind && x.target === q.target)) return;
      civ.quests.push({ ...q, id: civ.nextId++, created: state.time, status: 'open' });
      if (civ.quests.length > 80) civ.quests.shift();
    };
    for (const id of bio.living) {
      const sp = bio.species.get(id)!;
      if (sp.habitat === 0 && !sp.sapient && sp.peakPop > 1e5 && sp.pop < sp.peakPop * 0.05 && sp.pop < 5e5) {
        add({ kind: 'protect', title: `${sp.name}を守れ`, text: `${sp.name}は最盛期の${((sp.pop / sp.peakPop) * 100).toFixed(1)}%まで減った。生息地を守るか、生命の呪文で数を回復させよう（3倍に戻れば達成）。`, target: sp.id, cell: -1, baseline: sp.pop });
        break;
      }
    }
    const sick = civ.settlements.find((s) => s.plague >= 0 && s.pop > 1e4);
    if (sick) add({ kind: 'epidemic', title: `${sick.name}の疫病を止めよ`, text: `${sick.name}で「${civ.pathogens.find((p) => p.id === sick.plague)?.name}」が流行している。癒やしの呪文や医療の研究で流行を終わらせよう。`, target: sick.id, cell: sick.cell, baseline: sick.pop });
    const hungry = civ.settlements.find((s) => s.pop > s.K * 1.05 && s.pop > 1e4);
    if (hungry) add({ kind: 'famine', title: `${hungry.name}の飢えを救え`, text: `${hungry.name}は土地の養える数を超えている。食料を運ぶか、実りの呪文、灌漑や農業の技術で救おう。`, target: hungry.id, cell: hungry.cell, baseline: hungry.pop });
    const hidden = civ.artifacts.find((a) => !a.found && a.depth < 3);
    if (hidden) add({ kind: 'excavate', title: `${hidden.from}の遺跡を発掘せよ`, text: `地表近くに${hidden.from}の${ARTIFACT_NAMES[hidden.kind]}が眠っている（深さ ${hidden.depth.toFixed(1)} m）。現地に行って発掘しよう。`, target: hidden.id, cell: hidden.cell, baseline: 0 });
    if (rules.magic.enabled) {
      for (const s of civ.settlements) {
        if (state.fields.mana[s.cell] < 0.02 && s.fx[F.magic] > 0.5) {
          add({ kind: 'mana', title: `${s.name}の魔力枯渇を癒やせ`, text: `${s.name}の周りのマナが枯れかけている。マナを動かす呪文や、星辰の整列で回復させよう。`, target: s.id, cell: s.cell, baseline: Math.max(0.005, state.fields.mana[s.cell]) });
          break;
        }
      }
    }
  }
}

// ================================================================ helpers

export const BUILDING_INDEX = Object.fromEntries(BUILDINGS.map((b) => [b.id, b.index])) as Record<string, number>;
export const ARTIFACT_NAMES = { inscription: '碑文', blueprint: '設計図', grimoire: '魔導書', relic: '宝物' } as const;

/** Highest era among a settlement's well-adopted technologies. */
export function civEra(s: Settlement): number {
  let e = 0;
  for (let i = 0; i < NT; i++) if (s.tech[i] >= 0.3 && TECHS[i].era > e && !TECHS[i].magic) e = TECHS[i].era;
  return e;
}

export function fmt(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}億`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)}万`;
  return Math.round(n).toLocaleString('ja-JP');
}

function fmtYears(y: number): string {
  return y >= 1e4 ? `${(y / 1e4).toFixed(1)}万年` : `${Math.round(y)}年`;
}

