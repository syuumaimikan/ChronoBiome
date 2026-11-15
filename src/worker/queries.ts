import { formatYears } from '../core/lens';
import type { Simulation } from '../core/sim';
import { aspects, birthChart, constellations, ephemeris, moonPhase, skyEvents, arcaneFactor } from '../core/systems/astrology/astrology';
import { LIFE_STAGES } from '../core/systems/biosphere/bioState';
import { CLADE_NAMES, describe, DIET_NAMES, formatMass, renderPlan, type Species } from '../core/systems/biosphere/species';
import { co2 } from '../core/systems/climate/global';
import { BUILDINGS, DEITIES, DEPOSIT_NAMES, DOCTRINES, ERAS, GOODS, GOVS, NB, NT, ROLE_NAMES, TECHS, VALUES } from '../core/systems/society/data';
import type { Settlement } from '../core/systems/society/civState';
import { ARTIFACT_NAMES, civEra, fmt } from '../core/systems/society/civ';
import { heliocentric, luminosity, starStage } from '../core/universe/system';
import type { CellInfo, SettlementDetail, SkyInfo, SpeciesBrief, SpeciesDetail, TechNode, TownBrief, WorldSummary } from './protocol';

/**
 * Read-only views of the simulation for the UI: summaries, species and
 * settlement details, the technology tree, the sky. Everything is plain data
 * (structured-cloneable) so it can cross the worker boundary.
 */

export function brief(sim: Simulation, sp: Species, region = -1): SpeciesBrief {
  const bio = sim.state.bio;
  const R = sim.ecology.R;
  return {
    id: sp.id,
    name: sp.name,
    sci: sp.sci,
    clade: CLADE_NAMES[sp.clade],
    plan: renderPlan(sp),
    massKg: sp.massKg,
    diet: sp.diet,
    habitat: sp.habitat,
    flight: sp.flight,
    hue: sp.hue,
    shade: sp.shade,
    pattern: sp.pattern,
    horn: sp.horn,
    tail: sp.tail,
    density: region >= 0 && sp.slot >= 0 ? bio.density[sp.slot * R + region] : 0,
    sapient: sp.sapient,
  };
}

/** Outbreaks killing more than this share of a town per year are shown as epidemics (seasonal flu ≈ 0.01 %). */
const PLAGUE_NOTABLE = 2e-4;
const REGIME = (dT: number, ice: number) => (ice > 0.6 ? '全球凍結' : ice > 0.22 ? '氷期' : dT > 6 ? '温室期' : dT > 2 ? '温暖期' : dT < -2 ? '寒冷期' : '安定');

export function summary(sim: Simulation, keyframes: number): WorldSummary {
  const s = sim.state;
  const bio = s.bio;
  const civ = s.civ;
  const g = s.climate;
  const clades = new Map<string, number>();
  for (const id of bio.living) {
    const c = CLADE_NAMES[bio.species.get(id)!.clade];
    clades.set(c, (clades.get(c) ?? 0) + 1);
  }
  const sapient = bio.sapientId >= 0 ? bio.species.get(bio.sapientId) : undefined;
  const alive = civ.polities.filter((p) => p.fell < 0);
  const stage = starStage(s.system, s.time);
  let techs = 0;
  for (const t of civ.firstTech) if (t >= 0) techs++;
  return {
    star: { name: s.system.starName, stage: stage === 'main' ? '主系列星' : stage === 'subgiant' ? '準巨星（膨張中）' : '赤色巨星', luminosity: luminosity(s.system, s.time) },
    climate: { co2: co2(g), dT: g.meanAnomaly, iceShare: g.iceShare, regime: REGIME(g.meanAnomaly, g.iceShare), emission: g.emissionRate },
    life: {
      stage: bio.stage,
      stageName: LIFE_STAGES[bio.stage].name,
      species: bio.living.length,
      extinct: bio.extinctCount,
      oxygen: bio.oxygen,
      vegetation: bio.vegetation,
      sapient: sapient ? sapient.name : null,
      massExtinctions: bio.massExtinctions.length,
      clades: [...clades.entries()].sort((a, b) => b[1] - a[1]),
    },
    civ: {
      started: civ.started >= 0,
      era: civ.era,
      eraName: civ.era >= 0 ? ERAS[civ.era] : '—',
      pop: civ.totalPop,
      settlements: civ.settlements.length,
      polities: alive.length,
      wars: civ.wars.length,
      religions: civ.religions.filter((r) => r.followers > 0).length,
      languages: civ.languages.filter((l) => l.speakers > 0).length,
      techs,
      colonies: civ.colonies.length,
      ruins: civ.ruins.length,
      spells: civ.spells.length,
      quests: civ.quests.filter((q) => q.status === 'open').length,
      deaths: { war: civ.deathsWar, plague: civ.deathsPlague, famine: civ.deathsFamine },
      topPolities: alive
        .sort((a, b) => b.pop - a.pop)
        .slice(0, 8)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, pop: p.pop, settlements: p.settlements, gov: GOVS[p.gov].name })),
    },
    lastSeq: s.chronicle[s.chronicle.length - 1]?.seq ?? -1,
    keyframes,
  };
}

export function towns(sim: Simulation): TownBrief[] {
  const civ = sim.state.civ;
  const out: TownBrief[] = [];
  const pol = new Map(civ.polities.map((p) => [p.id, p]));
  for (const t of civ.settlements) {
    const p = pol.get(t.polity);
    const b: [number, number][] = [];
    for (let i = 0; i < NB; i++) if (t.buildings[i] > 0) b.push([i, t.buildings[i]]);
    out.push({
      id: t.id, name: t.name, cell: t.cell, pop: t.pop, polity: t.polity, color: p?.color ?? '#cccccc', era: civEra(t),
      capital: p?.capital === t.id, buildings: b, coastal: t.coastal, plague: t.plague >= 0 && (t.plagueToll ?? 0) > PLAGUE_NOTABLE, aligned: t.aligned,
    });
  }
  return out;
}

export function links(sim: Simulation): [number, number, number, number][] {
  const civ = sim.state.civ;
  const cell = new Map(civ.settlements.map((s) => [s.id, s.cell]));
  const out: [number, number, number, number][] = [];
  for (const l of civ.links) {
    const a = cell.get(l.a), b = cell.get(l.b);
    if (a !== undefined && b !== undefined) out.push([a, b, l.volume, l.sea ? 1 : 0]);
  }
  return out;
}

export function cellExtras(sim: Simulation, cell: number): Pick<CellInfo, 'landUse' | 'people' | 'mana' | 'richness' | 'life' | 'town' | 'ruin'> {
  const s = sim.state;
  const f = s.fields;
  const civ = s.civ;
  const region = sim.ecology.cellRegion[cell];
  const life = sim.ecology
    .speciesAt(s, cell)
    .slice(0, 14)
    .map((x) => brief(sim, s.bio.species.get(x.id)!, region));
  const ownerId = civ.owner[cell];
  let town: CellInfo['town'];
  if (ownerId >= 0) {
    const t = civ.settlements.find((x) => x.id === ownerId);
    if (t) {
      const p = civ.polities.find((x) => x.id === t.polity);
      town = { id: t.id, name: t.name, pop: t.pop, polity: p?.name ?? '', color: p?.color ?? '#ccc' };
    }
  }
  const r = civ.ruins.find((x) => x.cell === cell);
  return {
    landUse: f.landUse[cell],
    people: f.population[cell],
    mana: f.mana[cell],
    richness: f.richness[cell],
    life,
    town,
    ruin: r ? { name: r.name, time: r.time, era: ERAS[r.era] ?? '' } : undefined,
  };
}

export function speciesDetail(sim: Simulation, id: number): SpeciesDetail | null {
  const s = sim.state;
  const bio = s.bio;
  const sp = bio.species.get(id);
  if (!sp) return null;
  const lineage: SpeciesDetail['lineage'] = [];
  let p = bio.species.get(sp.parent);
  for (let guard = 0; p && guard < 40; guard++) {
    lineage.push({ id: p.id, name: p.name, clade: CLADE_NAMES[p.clade], born: p.born, died: p.died });
    p = bio.species.get(p.parent);
  }
  // Descendants (the record may have been pruned of old dead ends).
  const children = new Map<number, number[]>();
  for (const x of bio.species.values()) {
    if (!children.has(x.parent)) children.set(x.parent, []);
    children.get(x.parent)!.push(x.id);
  }
  let descendants = 0, living = 0;
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    descendants++;
    if (bio.species.get(c)!.died < 0) living++;
    stack.push(...(children.get(c) ?? []));
  }
  // Food web in its core region: what it may eat, what may eat it.
  const prey: string[] = [], predators: string[] = [];
  if (sp.slot >= 0) {
    const R = sim.ecology.R;
    let core = -1, best = 0;
    for (let r = 0; r < R; r++) {
      const d = bio.density[sp.slot * R + r];
      if (d > best) { best = d; core = r; }
    }
    if (core >= 0) {
      for (const oid of bio.living) {
        const o = bio.species.get(oid)!;
        if (o === sp || o.habitat !== sp.habitat || bio.density[o.slot * R + core] <= 0) continue;
        const ratio = o.massKg / sp.massKg;
        if (sp.diet >= 1 && ratio < 0.5 && ratio > 0.002 && o.diet <= 1 && prey.length < 5) prey.push(o.name);
        if (o.diet >= 1 && ratio > 1.5 && ratio < 500 && predators.length < 5) predators.push(o.name);
      }
    }
  }
  const known = s.civ.player?.journal.observed[id] ?? 0;
  let rangeKm2 = 0;
  if (sp.slot >= 0) {
    const R = sim.ecology.R;
    for (let r = 0; r < R; r++) if (bio.density[sp.slot * R + r] > 0) rangeKm2 += sim.ecology.habitatKm2(sp, r);
  }
  return {
    ...brief(sim, sp),
    description: describe(sp),
    born: sp.born,
    died: sp.died,
    cause: sp.cause,
    pop: sp.pop,
    peakPop: sp.peakPop,
    range: sp.range,
    rangeKm2,
    tempOpt: sp.tempOpt,
    tempTol: sp.tempTol,
    moistOpt: sp.moistOpt,
    intelligence: sp.intelligence,
    social: sp.social,
    dispersal: sp.dispersal,
    endotherm: sp.endotherm,
    domesticable: sp.domesticable,
    lineage,
    descendants,
    livingDescendants: living,
    known,
    prey,
    predators,
  };
}

/** Land species of the region around a cell and its neighbours, for the surface view. */
export function faunaAt(sim: Simulation, cell: number): SpeciesBrief[] {
  const s = sim.state;
  const eco = sim.ecology;
  const region = eco.cellRegion[cell];
  const seen = new Map<number, SpeciesBrief>();
  const regions = [region];
  const rm = eco.regions;
  for (let k = rm.nbrStart[region]; k < rm.nbrStart[region + 1]; k++) regions.push(rm.nbr[k]);
  for (const r of regions) {
    for (const id of s.bio.living) {
      const sp = s.bio.species.get(id)!;
      const d = s.bio.density[sp.slot * eco.R + r];
      if (d <= 0) continue;
      const b = seen.get(id);
      if (!b) seen.set(id, brief(sim, sp, r));
      else if (r === region) b.density = d;
    }
  }
  return [...seen.values()].sort((a, b) => b.density * b.massKg ** 0.5 - a.density * a.massKg ** 0.5).slice(0, 24);
}

export function settlementDetail(sim: Simulation, id: number): SettlementDetail | null {
  const st = sim.state;
  const civ = st.civ;
  const s = civ.settlements.find((x) => x.id === id);
  if (!s) return null;
  const pol = civ.polities.find((p) => p.id === s.polity);
  const cap = pol ? civ.settlements.find((x) => x.id === pol.capital) : undefined;
  const ruler = pol ? civ.persons.find((x) => x.id === pol.ruler) : undefined;
  const rel = civ.religions.find((r) => r.id === s.religion);
  const prel = pol ? civ.religions.find((r) => r.id === pol.religion) : undefined;
  const lang = civ.languages.find((l) => l.id === s.langId);
  const techs = TECHS.map((t, i) => ({ name: t.name, era: ERAS[t.era], field: t.field, adoption: s.tech[i], e: t.era }))
    .filter((t) => t.adoption > 0)
    .sort((a, b) => b.e - a.e || b.adoption - a.adoption)
    .map(({ e, ...t }) => (void e, t));
  const partners: string[] = [];
  for (const l of civ.links) {
    const o = l.a === s.id ? l.b : l.b === s.id ? l.a : -1;
    if (o < 0) continue;
    const t = civ.settlements.find((x) => x.id === o);
    if (t) partners.push(`${t.name}${l.sea ? '（海路）' : ''}`);
  }
  const deposits = DEPOSIT_NAMES.filter(([bit]) => (s.deposits & bit) !== 0).map(([, n]) => n);
  const toll = s.plagueToll ?? 0;
  const plague = s.plague >= 0 ? `${civ.pathogens.find((p) => p.id === s.plague)?.name ?? '疫病'}（${toll > PLAGUE_NOTABLE ? `年に人口の ${(toll * 100).toPrecision(2)}% が死亡` : '軽い流行'}）` : null;
  const people = civ.persons.filter((p) => p.settlement === s.id).slice(-6).reverse()
    .map((p) => ({ name: p.name, role: ROLE_NAMES[p.role], born: p.born, deeds: p.deeds.slice(-3) }));
  const bcost = s.build >= 0 ? BUILDINGS[s.build].cost : 0;
  return {
    id: s.id,
    name: s.name,
    cell: s.cell,
    founded: s.founded,
    pop: s.pop,
    K: s.K,
    urban: s.urban,
    wealth: s.wealth,
    polity: {
      id: pol?.id ?? -1,
      name: pol?.name ?? '—',
      gov: pol ? GOVS[pol.gov].name : '—',
      color: pol?.color ?? '#ccc',
      capital: cap?.name ?? '—',
      ruler: ruler ? `${ruler.name}（${ROLE_NAMES[ruler.role]}）` : '—',
      founded: pol?.founded ?? s.founded,
      religion: prel ? prel.name : '—',
    },
    era: ERAS[civEra(s)],
    language: lang?.name ?? '—',
    religion: rel ? `${rel.name}（${DEITIES[rel.deity]?.name ?? ''}・${DOCTRINES[rel.doctrine]?.name ?? ''}）` : '固有の信仰',
    values: VALUES.map((name, i) => ({ name, v: s.values[i] })),
    goods: GOODS.map((g, i) => ({ name: g.name, stock: s.stock[i], price: s.price[i], supply: s.supply[i], demand: s.demand[i] })).filter((g) => g.stock > 0.01 || g.demand > 0.01),
    techs,
    researching: s.research >= 0 ? { name: TECHS[s.research].name, progress: s.progress, cost: TECHS[s.research].cost } : null,
    building: s.build >= 0 ? { name: BUILDINGS[s.build].name, progress: s.buildProgress, cost: bcost } : null,
    buildings: BUILDINGS.map((b, i) => ({ name: b.name, count: s.buildings[i] })).filter((b) => b.count > 0),
    plague,
    famine: st.time - s.lastFamine < 30,
    deposits,
    partners: partners.slice(0, 12),
    golems: s.golems,
    people,
  };
}

export function techTree(sim: Simulation): TechNode[] {
  const civ = sim.state.civ;
  const n = civ.settlements.length;
  return TECHS.map((t, i) => {
    let know = 0, best = 0;
    for (const s of civ.settlements) {
      if (s.tech[i] > 0) know++;
      best = Math.max(best, s.tech[i]);
    }
    return { id: t.id, name: t.name, era: t.era, field: t.field, req: t.req, cost: t.cost, magic: t.magic, first: civ.firstTech[i] ?? -1, share: n ? know / n : 0, best };
  });
}

/** Zodiac names of the largest living culture (or a neutral default). */
function cultureSeed(sim: Simulation): number {
  const civ = sim.state.civ;
  let big: Settlement | undefined;
  for (const s of civ.settlements) if (!big || s.pop > big.pop) big = s;
  const lang = big ? civ.languages.find((l) => l.id === big!.langId) : undefined;
  return lang?.seed ?? sim.state.seed;
}

export function skyInfo(sim: Simulation, lonDeg: number): SkyInfo {
  const st = sim.state;
  const sys = st.system;
  const t = st.time;
  const eph = ephemeris(sys, t);
  const cons = constellations(sys, cultureSeed(sim));
  const zodiac = cons.filter((c) => c.zodiac).sort((a, b) => a.lon - b.lon).map((c) => c.name);
  const asp = aspects(eph, sim.rules.astrology.orbDeg);
  const name = (id: number) => (id < 0 ? sys.starName : sys.bodies[id]?.name ?? '?');
  const events = skyEvents(sys, st.seed, t, t + 1.5, 16).map((e) => ({ time: e.time, kind: e.kind, text: e.text }));
  const chart = birthChart(sys, t, lonDeg, zodiac, sim.rules.astrology.orbDeg);
  const orrery: SkyInfo['orrery'] = [];
  for (const b of sys.bodies) {
    if (b.parent >= 0) continue;
    const p = heliocentric(sys, b.id, t);
    orrery.push({ id: b.id, name: b.name, x: p[0], y: p[1], a: b.orbit.a, color: b.color, kind: b.kind, habitability: b.habitability, tempC: b.tempC });
  }
  return {
    time: t,
    moonPhase: moonPhase(sys, t),
    bodies: eph.map((b) => ({ id: b.id, name: b.name, lon: b.lon, lat: b.lat, kind: b.kind, color: b.color })),
    stars: sys.stars.map((s) => ({ lon: s.lon, lat: s.lat, mag: s.mag })),
    constellations: cons.map((c) => ({ name: c.name, lines: c.lines, lon: c.lon, lat: c.lat, zodiac: c.zodiac })),
    zodiac,
    aspects: asp.map((a) => ({ a: name(a.a), b: name(a.b), name: a.name })),
    events,
    chart: chart.text,
    arcane: arcaneFactor(sys, t, sim.rules.astrology.orbDeg),
    orrery,
  };
}

// ---------------------------------------------------------------- export

/** The whole world as structured JSON (schema-versioned) for games and tools. */
export function worldJson(sim: Simulation): string {
  const s = sim.state;
  const bio = s.bio;
  const civ = s.civ;
  const species = [...bio.species.values()].map((sp) => ({
    id: sp.id, parent: sp.parent, name: sp.name, sci: sp.sci, clade: sp.clade, habitat: sp.habitat ? 'sea' : 'land', diet: DIET_NAMES[sp.diet],
    massKg: +sp.massKg.toPrecision(3), born: Math.round(sp.born), died: Math.round(sp.died), cause: sp.cause, pop: Math.round(sp.pop), sapient: sp.sapient,
  }));
  const polName = new Map(civ.polities.map((p) => [p.id, p.name]));
  const data = {
    schema: 'chronobiome.world/1',
    seed: s.seed,
    rulePack: sim.rules.meta.name,
    time: s.time,
    star: { name: s.system.starName, mass: s.system.starMass, luminosity: luminosity(s.system, s.time) },
    planets: s.system.bodies.map((b) => ({ id: b.id, name: b.name, kind: b.kind, a: b.orbit.a, period: b.orbit.period, tempC: Math.round(b.tempC), habitability: +b.habitability.toFixed(2), parent: b.parent })),
    climate: { co2: co2(s.climate), meanAnomaly: s.climate.meanAnomaly, iceShare: s.climate.iceShare, seaLevel: s.seaLevel },
    life: { stage: LIFE_STAGES[bio.stage].name, stageTimes: bio.stageTimes, oxygen: bio.oxygen, massExtinctions: bio.massExtinctions },
    species,
    polities: civ.polities.map((p) => ({ id: p.id, name: p.name, gov: GOVS[p.gov].name, founded: p.founded, fell: p.fell, pop: Math.round(p.pop), color: p.color, parent: p.parent })),
    settlements: civ.settlements.map((t) => ({
      id: t.id, name: t.name, cell: t.cell, lat: (s.mesh.lat[t.cell] * 180) / Math.PI, lon: (s.mesh.lon[t.cell] * 180) / Math.PI, pop: Math.round(t.pop),
      polity: polName.get(t.polity), founded: t.founded, era: ERAS[civEra(t)],
      prices: Object.fromEntries(GOODS.map((g, i) => [g.id, +t.price[i].toFixed(2)])),
      buildings: BUILDINGS.filter((_, i) => t.buildings[i] > 0).map((b) => b.name),
    })),
    religions: civ.religions.map((r) => ({ name: r.name, founded: r.founded, deity: DEITIES[r.deity]?.name, doctrine: DOCTRINES[r.doctrine]?.name, followers: Math.round(r.followers), cause: r.cause })),
    languages: civ.languages.map((l) => ({ id: l.id, name: l.name, parent: l.parent, founded: l.founded, speakers: Math.round(l.speakers) })),
    technologies: TECHS.map((t, i) => ({ id: t.id, name: t.name, era: ERAS[t.era], firstInvented: civ.firstTech[i] ?? -1 })).filter((t) => t.firstInvented >= 0),
    wars: civ.wars.map((w) => ({ a: polName.get(w.a), b: polName.get(w.b), started: w.started, cause: w.cause, battles: w.battles })),
    ruins: civ.ruins.map((r) => ({ name: r.name, cell: r.cell, time: r.time, era: ERAS[r.era], polity: r.polity, guardian: r.guardian })),
    artifacts: civ.artifacts.map((a) => ({ kind: ARTIFACT_NAMES[a.kind], cell: a.cell, depth: +a.depth.toFixed(1), from: a.from, text: a.text, found: a.found, tech: a.tech >= 0 ? TECHS[a.tech]?.name : null })),
    spells: civ.spells,
    persons: civ.persons.map((p) => ({ name: p.name, role: ROLE_NAMES[p.role], born: p.born, died: p.died, chart: p.chart, deeds: p.deeds })),
    colonies: civ.colonies.map((c) => ({ name: c.name, body: s.system.bodies[c.body]?.name, pop: Math.round(c.pop), founded: c.founded })),
    chronicle: s.chronicle.map((c) => ({ time: c.time, kind: c.kind, text: c.text })),
  };
  return JSON.stringify(data, null, 1);
}

/** A setting bible in Markdown: geography, nature, peoples, history. */
export function worldBible(sim: Simulation): string {
  const s = sim.state;
  const bio = s.bio;
  const civ = s.civ;
  const L: string[] = [];
  const y = (t: number) => formatYears(t);
  L.push(`# ${s.system.starName}系 第${s.system.homeId + 1}惑星 — 世界設定資料`, '');
  L.push(`> シード ${s.seed} ・ ルール「${sim.rules.meta.name}」 ・ 世界の始まりから ${y(s.time)}`, '');
  L.push('## 天体', '');
  L.push(`主星 **${s.system.starName}**（太陽質量の ${s.system.starMass.toFixed(2)} 倍、現在の明るさ ${luminosity(s.system, s.time).toFixed(2)}）。`);
  for (const b of s.system.bodies) {
    if (b.home) continue;
    L.push(`- **${b.name}**（${b.kind === 'moon' ? '衛星' : '惑星'}、${b.parent >= 0 ? '' : `${b.orbit.a.toFixed(2)} AU、公転 ${b.orbit.period.toFixed(1)} 年、`}平均 ${Math.round(b.tempC)}℃）`);
  }
  L.push('', '## 気候', '');
  L.push(`大気の CO2 は ${co2(s.climate).toFixed(0)} ppm、平均気温は基準から ${s.climate.meanAnomaly >= 0 ? '+' : ''}${s.climate.meanAnomaly.toFixed(1)}℃、陸の ${(s.climate.iceShare * 100).toFixed(0)}% が氷に覆われ、海面は ${s.seaLevel.toFixed(0)} m。`);
  L.push('', '## 生命の歴史', '');
  for (let k = 1; k < LIFE_STAGES.length; k++) if (bio.stageTimes[k] >= 0 && k <= bio.stage) L.push(`- ${y(bio.stageTimes[k])}：${LIFE_STAGES[k].name}`);
  for (const m of bio.massExtinctions) L.push(`- ${y(m.time)}：大量絶滅（${m.cause}、種の ${(m.lostShare * 100).toFixed(0)}%）`);
  L.push('', `現生種 ${bio.living.length}、これまでに絶滅した種 ${bio.extinctCount}。`, '');
  L.push('### 主な生き物', '');
  const living = bio.living.map((id) => bio.species.get(id)!).filter((x) => x.habitat === 0).sort((a, b) => b.massKg * Math.sqrt(b.pop) - a.massKg * Math.sqrt(a.pop)).slice(0, 15);
  for (const sp of living) L.push(`- **${sp.name}**（*${sp.sci}*）— ${describe(sp)}、推定 ${fmt(sp.pop)} 個体、${formatMass(sp.massKg)}`);
  if (civ.started >= 0) {
    L.push('', '## 国家と都市', '');
    for (const p of civ.polities.filter((x) => x.fell < 0).sort((a, b) => b.pop - a.pop).slice(0, 12)) {
      const cap = civ.settlements.find((x) => x.id === p.capital);
      const rel = civ.religions.find((r) => r.id === p.religion);
      L.push(`### ${p.name}`, '', `${GOVS[p.gov].name}。首都 ${cap?.name ?? '—'}、人口 ${fmt(p.pop)}、${p.settlements} の集落。${rel ? `国教は${rel.name}。` : ''}建国 ${y(p.founded)}。`, '');
    }
    L.push('## 宗教', '');
    for (const r of civ.religions.filter((x) => x.followers > 0)) L.push(`- **${r.name}** — ${DEITIES[r.deity]?.name}、教義「${DOCTRINES[r.doctrine]?.name}」。${r.cause}。信者 ${fmt(r.followers)}。`);
    L.push('', '## 言語', '');
    for (const l of civ.languages.filter((x) => x.speakers > 0)) L.push(`- ${l.name}（話者 ${fmt(l.speakers)}、${y(l.founded)}に分岐）`);
    L.push('', '## 技術', '');
    for (let e = 0; e < ERAS.length; e++) {
      const got = TECHS.map((t, i) => ({ t, at: civ.firstTech[i] ?? -1 })).filter((x) => x.t.era === e && x.at >= 0);
      if (got.length) L.push(`- **${ERAS[e]}**：${got.map((x) => x.t.name).join('、')}`);
    }
    if (civ.ruins.length) {
      L.push('', '## 遺跡', '');
      for (const r of civ.ruins.slice(-15)) L.push(`- **${r.name}遺跡**（${r.polity}、${ERAS[r.era]}、${y(r.time)}に滅亡）${r.guardian ? `— 守護者: ${r.guardian}` : ''}`);
    }
    if (civ.spells.length) {
      L.push('', '## 伝わる呪文', '');
      for (const sp of civ.spells.slice(-12)) L.push(`- **${sp.name}**（${sp.by}、${y(sp.time)}）`);
    }
    const famous = civ.persons.filter((p) => p.deeds.length).slice(-15);
    if (famous.length) {
      L.push('', '## 歴史上の人物', '');
      for (const p of famous) L.push(`- **${p.name}**（${ROLE_NAMES[p.role]}、${p.chart}）— ${p.deeds.join('、')}`);
    }
  }
  L.push('', '## 年代記（抜粋）', '');
  const major = s.chronicle.filter((c) => c.kind !== 'sky').slice(-80);
  for (const c of major) L.push(`- **${y(c.time)}** ${c.text}`);
  L.push('');
  return L.join('\n');
}

export { NT };
