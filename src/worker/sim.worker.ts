/// <reference lib="webworker" />
import { expose, transfer } from 'comlink';
import type { LensId } from '../core/lens';
import { act, injectScenario, playerSummary } from '../core/play/actions';
import { normalizeSeed } from '../core/rng';
import { parseRulePack } from '../core/rules/schema';
import { Simulation, type Keyframe } from '../core/sim';
import { co2 } from '../core/systems/climate/global';
import { subsolarLatitude } from '../core/systems/climate/climate';
import { elementAffinity } from '../core/systems/magic/cast';
import { planSpell } from '../core/systems/magic/spell';
import { CONTINENTAL_KM } from '../core/systems/terrain/isostasy';
import { hashWorld, livePlateCount, type FieldName, type WorldFields } from '../core/world/state';
import type { CellInfo, FieldVersions, InitResult, LabRun, MeshPayload, Query, SimApi, Snapshot, WorldInfo } from './protocol';
import { cellExtras, faunaAt, links, settlementDetail, skyInfo, speciesDetail, summary, techTree, towns, worldBible, worldJson } from './queries';

function landShare(e: Float32Array, sea: number): number {
  let land = 0;
  for (let i = 0; i < e.length; i++) if (e[i] >= sea) land++;
  return land / e.length;
}

let sim: Simulation | null = null;
const keyframes: Keyframe[] = [];
/** Each keyframe is a full copy of the world (several MB). */
const MAX_KEYFRAMES = 12;

function need(): Simulation {
  if (!sim) throw new Error('simulation not initialised');
  return sim;
}

function collectBuffers(obj: object, out: Transferable[] = []): Transferable[] {
  for (const v of Object.values(obj)) {
    if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
  }
  return out;
}

function inspectCell(s: Simulation, cell: number): CellInfo | undefined {
  const st = s.state;
  const m = st.mesh;
  if (!(cell >= 0 && cell < m.count)) return undefined;
  const f = st.fields;
  const p = f.plate[cell];
  // |v| = |ω| · |pole × r|, converted from planet radii per year to cm/yr
  const px = st.plates.pole[p * 3], py = st.plates.pole[p * 3 + 1], pz = st.plates.pole[p * 3 + 2];
  const x = m.pos[cell * 3], y = m.pos[cell * 3 + 1], z = m.pos[cell * 3 + 2];
  const cross = Math.hypot(py * z - pz * y, pz * x - px * z, px * y - py * x);
  const speed = Math.abs(st.plates.omega[p]) * cross * m.radiusKm * 1e5;
  return {
    cell,
    latDeg: (m.lat[cell] * 180) / Math.PI,
    lonDeg: (m.lon[cell] * 180) / Math.PI,
    heightM: f.elevation[cell] - st.seaLevel,
    temperature: f.temperature[cell],
    tempMean: f.tempMean[cell],
    seasonAmp: f.seasonAmp[cell],
    moisture: f.moisture[cell],
    continentality: f.continentality[cell],
    biome: f.biome[cell],
    plate: p,
    plateSpeedCmPerYr: speed,
    crustKm: f.crustThickness[cell],
    crustAgeMyr: f.crustAge[cell],
    continentalCrust: f.crustThickness[cell] >= CONTINENTAL_KM,
    stress: f.stress[cell],
    flow: f.flow[cell],
    ...cellExtras(s, cell),
  };
}

function makeSnapshot(s: Simulation, want: FieldName[], known: FieldVersions, q: Query): Snapshot {
  const st = s.state;
  const fields: Partial<WorldFields> = {};
  const versions: FieldVersions = {};
  for (const name of want) {
    const v = st.versions[name];
    versions[name] = v;
    if (known[name] !== v) {
      // Copy: the worker keeps its arrays, the copy's buffer is transferred.
      (fields as Record<string, ArrayBufferView>)[name] = st.fields[name].slice();
    }
  }
  const after = q.chronicleAfter;
  const chron = st.chronicle;
  let from = chron.length;
  while (from > 0 && chron[from - 1].seq > after) from--;
  return {
    time: st.time,
    tick: st.tick,
    lens: s.lens,
    dtYears: s.dt,
    seaLevel: st.seaLevel,
    subsolarLat: subsolarLatitude(s.rules, st.time, s.dt),
    tickMs: s.lastTickMs,
    plateCount: livePlateCount(st),
    landShare: landShare(st.fields.elevation, st.seaLevel),
    fields,
    versions,
    cell: q.inspect === undefined ? undefined : inspectCell(s, q.inspect),
    summary: summary(s, keyframes.length),
    // At most the latest 300 new entries per snapshot.
    chronicle: chron.slice(Math.max(from, chron.length - 300)),
    towns: towns(s),
    links: links(s),
  };
}

function send<T extends object>(value: T, ...parts: object[]): T {
  const buffers: Transferable[] = [];
  for (const p of parts) collectBuffers(p, buffers);
  return transfer(value, buffers);
}

function worldInfo(s: Simulation, genMs: number): WorldInfo {
  const p = s.rules;
  const sys = s.state.system;
  return {
    genMs,
    seed: s.state.seed,
    packName: p.meta.name,
    biomes: p.biomes.map((b) => ({ id: b.id, name: b.name, color: b.color, surface: b.surface })),
    lapseRateCPerKm: p.climate.lapseRateCPerKm,
    magic: p.magic.enabled,
    starName: sys.starName,
    planets: sys.bodies.map((b) => ({ id: b.id, name: b.name, kind: b.kind, a: b.orbit.a, color: b.color, home: b.home, moon: b.parent >= 0 })),
  };
}

const api: SimApi = {
  async init(packData, seed, want) {
    const parsed = parseRulePack(packData);
    if (!parsed.ok) return { ok: false, errors: parsed.errors } satisfies InitResult;
    const t0 = performance.now();
    sim = new Simulation(parsed.pack, normalizeSeed(seed));
    keyframes.length = 0;
    const genMs = performance.now() - t0;
    const m = sim.state.mesh;
    const mesh: MeshPayload = {
      level: m.level,
      count: m.count,
      radiusKm: m.radiusKm,
      spacingKm: m.spacingKm,
      pos: m.pos.slice(),
      lat: m.lat.slice(),
      lon: m.lon.slice(),
      nbrStart: m.nbrStart.slice(),
      nbr: m.nbr.slice(),
      faces: m.faces.slice(),
      faceCenter: m.faceCenter.slice(),
      ringStart: m.ringStart.slice(),
      ring: m.ring.slice(),
    };
    const snapshot = makeSnapshot(sim, want, {}, { chronicleAfter: -1 });
    return send<InitResult>({ ok: true, mesh, world: worldInfo(sim, genMs), snapshot }, mesh, snapshot.fields);
  },

  async step(ticks, want, known, q) {
    const s = need();
    // Coarse ticks are expensive: never block the worker for more than ~1 s.
    const n = Math.max(0, Math.min(10_000, Math.floor(ticks)));
    const t0 = performance.now();
    for (let k = 0; k < n; k++) {
      s.step(1);
      if (performance.now() - t0 > 1000) break;
    }
    // Automatic keyframes at milestones of history.
    const st = s.state;
    const last = keyframes[keyframes.length - 1];
    const span = Math.max(1, s.dt * 400);
    if (!last || st.time - last.time > span) addKeyframe(s, '自動');
    const snap = makeSnapshot(s, want, known, q);
    return send(snap, snap.fields);
  },

  async setLens(lens: LensId) {
    need().lens = lens;
  },

  async snapshot(want, known, q) {
    const snap = makeSnapshot(need(), want, known, q);
    snap.hash = hashWorld(need().state);
    return send(snap, snap.fields);
  },

  async hash() {
    return hashWorld(need().state);
  },

  async species(id) {
    return speciesDetail(need(), id);
  },

  async faunaAt(cell) {
    return faunaAt(need(), cell);
  },

  async settlement(id) {
    return settlementDetail(need(), id);
  },

  async techTree() {
    return techTree(need());
  },

  async sky(lonDeg) {
    return skyInfo(need(), lonDeg);
  },

  async range(id) {
    const s = need();
    const out = new Float32Array(s.state.mesh.count);
    s.ecology.rangeOf(s.state, id, out);
    return transfer(out, [out.buffer]);
  },

  async planSpell(nodes) {
    const s = need();
    const cell = s.state.civ.settlements[0]?.cell ?? 0;
    const p = planSpell(nodes, { skill: 0.6, potency: s.rules.magic.potency, elements: s.rules.magic.elements, affinity: (el) => elementAffinity(s.state, cell, el) });
    return { ok: p.ok, errors: p.errors, cost: p.cost, stability: p.stability, radius: p.radius, years: p.years, summary: p.summary };
  },

  async keyframe(label) {
    addKeyframe(need(), label || '手動');
    return listKeyframes();
  },

  async keyframes() {
    return listKeyframes();
  },

  async restore(index) {
    const k = keyframes[index];
    if (!k) return;
    const s = need();
    s.restore(k);
    // Later keyframes belong to the abandoned timeline's future; keep them as branches.
  },

  async scenario(kind, cell) {
    const s = need();
    addKeyframe(s, `${kind} の直前`);
    return injectScenario(s, kind, cell);
  },

  async player() {
    return playerSummary(need());
  },

  async act(action) {
    const s = need();
    const r = act(s, action);
    return { ...r, player: playerSummary(s) };
  },

  async exportWorld() {
    return worldJson(need());
  },

  async worldBible() {
    return worldBible(need());
  },

  async labRun(packData, seed, ticks, scenario) {
    const parsed = parseRulePack(packData);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const lab = new Simulation(parsed.pack, seed >>> 0);
    lab.lens = 'auto';
    const run: LabRun = { seed, series: [], firstSapience: -1, firstCity: -1, finalEra: -1, extinctions: 0, massExtinctions: 0, maxPop: 0 };
    const every = Math.max(1, Math.floor(ticks / 120));
    let injected = false;
    const t0 = performance.now();
    for (let k = 0; k < ticks; k++) {
      lab.step(1);
      const st = lab.state;
      if (scenario && !injected && st.civ.era >= 7) {
        injectScenario(lab, scenario, -1);
        injected = true;
      }
      if (run.firstSapience < 0 && st.bio.sapientId >= 0) run.firstSapience = st.time;
      if (run.firstCity < 0 && st.civ.settlements.some((x) => x.pop > 1e4)) run.firstCity = st.time;
      run.maxPop = Math.max(run.maxPop, st.civ.totalPop);
      if (k % every === 0 || k === ticks - 1) {
        run.series.push({ time: st.time, species: st.bio.living.length, dT: st.climate.meanAnomaly, co2: co2(st.climate), pop: st.civ.totalPop, era: st.civ.era });
      }
      if (performance.now() - t0 > 120_000) break;
    }
    run.finalEra = lab.state.civ.era;
    run.extinctions = lab.state.bio.extinctCount;
    run.massExtinctions = lab.state.bio.massExtinctions.length;
    return run;
  },
};

function addKeyframe(s: Simulation, label: string): void {
  keyframes.push(s.keyframe(label));
  // Keep the first (genesis) and thin out the middle when full.
  if (keyframes.length > MAX_KEYFRAMES) keyframes.splice(1 + Math.floor((keyframes.length - 2) / 2), 1);
}

function listKeyframes() {
  return keyframes.map((k, index) => ({ index, label: k.label, time: k.time, tick: k.tick }));
}

expose(api);
