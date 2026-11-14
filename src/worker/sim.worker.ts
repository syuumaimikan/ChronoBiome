/// <reference lib="webworker" />
import { expose, transfer } from 'comlink';
import { normalizeSeed } from '../core/rng';
import { parseRulePack } from '../core/rules/schema';
import { Simulation } from '../core/sim';
import { subsolarLatitude } from '../core/systems/climate/climate';
import { hashWorld, livePlateCount, type FieldName, type WorldFields } from '../core/world/state';
import { CONTINENTAL_KM } from '../core/systems/terrain/isostasy';

function landShare(e: Float32Array, sea: number): number {
  let land = 0;
  for (let i = 0; i < e.length; i++) if (e[i] >= sea) land++;
  return land / e.length;
}
import type { CellInfo, FieldVersions, InitResult, MeshPayload, SimApi, Snapshot } from './protocol';
import type { LensId } from '../core/lens';

let sim: Simulation | null = null;

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
  };
}

function makeSnapshot(s: Simulation, want: FieldName[], known: FieldVersions, inspect?: number): Snapshot {
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
    cell: inspect === undefined ? undefined : inspectCell(s, inspect),
  };
}

function send<T extends object>(value: T, ...parts: object[]): T {
  const buffers: Transferable[] = [];
  for (const p of parts) collectBuffers(p, buffers);
  return transfer(value, buffers);
}

const api: SimApi = {
  async init(packData, seed, want) {
    const parsed = parseRulePack(packData);
    if (!parsed.ok) return { ok: false, errors: parsed.errors } satisfies InitResult;
    const t0 = performance.now();
    sim = new Simulation(parsed.pack, normalizeSeed(seed));
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
    const snapshot = makeSnapshot(sim, want, {});
    const world = {
      genMs,
      seed: sim.state.seed,
      packName: parsed.pack.meta.name,
      biomes: parsed.pack.biomes.map((b) => ({ id: b.id, name: b.name, color: b.color, surface: b.surface })),
      lapseRateCPerKm: parsed.pack.climate.lapseRateCPerKm,
    };
    return send<InitResult>({ ok: true, mesh, world, snapshot }, mesh, snapshot.fields);
  },

  async step(ticks, want, known, inspect) {
    const s = need();
    s.step(Math.max(0, Math.min(10_000, Math.floor(ticks))));
    const snap = makeSnapshot(s, want, known, inspect);
    return send(snap, snap.fields);
  },

  async setLens(lens: LensId) {
    need().lens = lens;
  },

  async snapshot(want, known, inspect) {
    const snap = makeSnapshot(need(), want, known, inspect);
    snap.hash = hashWorld(need().state);
    return send(snap, snap.fields);
  },

  async hash() {
    return hashWorld(need().state);
  },
};

expose(api);
