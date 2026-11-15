import { compileExpr, ExprScope, type Evaluator } from '../../rules/expr';
import { BIOME_VARIABLES, type RulePack } from '../../rules/schema';
import { hopDistance, smoothField, type Topology } from '../../world/topology';
import { touch, type WorldState } from '../../world/state';
import { anomalyAt } from './global';

/**
 * Regional climate: temperature from latitude, altitude and the seasonal cycle,
 * shifted by the global energy-balance anomaly (global.ts); moisture from
 * latitude bands (Hadley/Ferrel/polar cells), distance to the sea along the
 * prevailing wind, and rain shadows; warmer air carries more rain.
 */

const DEG = Math.PI / 180;

/** Recompute everything that depends only on terrain (call when elevation changes). */
export function computeClimateStatic(state: WorldState, rules: RulePack, scratch = new ClimateScratch(state.mesh.count)): void {
  const { mesh, fields } = state;
  const C = rules.climate;
  const n = mesh.count;
  const e = fields.elevation;
  const sea = state.seaLevel;
  const isOcean = (i: number) => e[i] < sea;

  // ---- continentality from distance to the sea
  const hops = hopDistance(mesh, isOcean, undefined, scratch.a);
  for (let i = 0; i < n; i++) {
    const km = Number.isFinite(hops[i]) ? hops[i] * mesh.spacingKm : 1e4;
    fields.continentality[i] = isOcean(i) ? 0 : 1 - Math.exp(-km / C.oceanInfluenceKm);
  }

  // ---- baseline annual mean temperature (before the global anomaly) and seasonal amplitude
  const tiltScale = Math.min(2.5, Math.sin(state.climate.tiltDeg * DEG) / Math.sin(23.44 * DEG));
  for (let i = 0; i < n; i++) {
    const lat = mesh.lat[i];
    const absLat = Math.abs(lat);
    const t0 = C.poleTempC + (C.equatorTempC - C.poleTempC) * Math.cos(lat);
    const alt = Math.max(0, e[i] - sea);
    scratch.base[i] = t0 - (C.lapseRateCPerKm * alt) / 1000;
    const cont = fields.continentality[i];
    fields.seasonAmp[i] = 0.5 * C.maxSeasonalSwingC * tiltScale * Math.pow(Math.sin(absLat), 0.8) * (0.15 + 0.85 * cont);
  }

  // ---- moisture: latitude band × oceanic influence along the wind × rain shadow
  const reachKm = 2000;
  const steps = Math.max(2, Math.ceil(reachKm / mesh.spacingKm));
  const upwind = upwindTable(mesh);
  const m = fields.moisture;
  for (let i = 0; i < n; i++) {
    if (isOcean(i)) {
      m[i] = 1;
      continue;
    }
    const band = latitudeBand(Math.abs(mesh.lat[i]) / DEG);

    // Walk upwind: trade winds and polar easterlies come from the east, westerlies from the west.
    let c = i;
    let maxUp = -Infinity;
    let upwindOcean = 0;
    for (let s = 1; s <= steps; s++) {
      c = upwind[c];
      if (isOcean(c)) {
        upwindOcean = Math.exp(-(s * mesh.spacingKm) / C.oceanInfluenceKm);
        break;
      }
      if (e[c] > maxUp) maxUp = e[c];
    }
    const near = 0.75 * (1 - fields.continentality[i]);
    const influence = Math.max(near, upwindOcean);
    const barrier = maxUp - Math.max(e[i], sea) - C.rainShadowStartM;
    const shadow = barrier > 0 ? Math.min(0.75, barrier / 3000) : 0;
    m[i] = Math.min(1, Math.max(0, band * (0.2 + 0.8 * influence) * (1 - shadow)));
  }
  smoothField(mesh, m, 2, 0.5, scratch.b);
  for (let i = 0; i < n; i++) if (isOcean(i)) m[i] = 1;
  scratch.moist.set(m);

  touch(state, 'continentality', 'seasonAmp', 'moisture');
  applyTemperature(state, rules, scratch);
}

/**
 * Write temperatures (baseline + global anomaly) and what follows from them:
 * rain (≈ 7 % more per °C of warming, Clausius–Clapeyron), biomes and the
 * land ice that locks up sea water.
 */
export function applyTemperature(state: WorldState, rules: RulePack, scratch: ClimateScratch): void {
  const { mesh, fields } = state;
  const n = mesh.count;
  const e = fields.elevation;
  const sea = state.seaLevel;
  const g = state.climate;
  const wet = Math.max(0.6, Math.min(1.4, 1 + 0.03 * g.meanAnomaly));
  const mt = state.mods.temp, mm = state.mods.moist;
  let ice = 0, land = 0;
  for (let i = 0; i < n; i++) {
    const t = scratch.base[i] + anomalyAt(g, mesh.lat[i]) + mt[i];
    fields.tempMean[i] = t;
    if (e[i] >= sea) {
      fields.moisture[i] = Math.max(0, Math.min(1, scratch.moist[i] * wet + mm[i]));
      land++;
      if (t < -8) ice++;
    }
  }
  // Ice sheets ≈ 2 km thick (as water: ×0.9), counted in ocean-volume units.
  g.iceVolume = ice * rules.carbon.iceSheetM;
  if (g.iceVolume0 < 0) g.iceVolume0 = g.iceVolume;
  g.iceShare = land > 0 ? ice / land : 0;
  touch(state, 'tempMean', 'moisture');
  classifyBiomes(state, rules);
}

const upwindCache = new WeakMap<Topology, Int32Array>();

/**
 * For each cell, the neighbour the prevailing wind comes from: trade winds
 * (< 30°) and polar easterlies (≥ 60°) blow from the east, westerlies from the
 * west. Depends only on geometry, so it is computed once per grid.
 */
export function upwindTable(mesh: Topology): Int32Array {
  let t = upwindCache.get(mesh);
  if (t) return t;
  t = new Int32Array(mesh.count);
  const pos = mesh.pos;
  for (let c = 0; c < mesh.count; c++) {
    const absLatDeg = Math.abs(mesh.lat[c]) / DEG;
    const sign = absLatDeg < 30 || absLatDeg >= 60 ? 1 : -1;
    const x = pos[c * 3], z = pos[c * 3 + 2];
    // east = r × ŷ = (-z, 0, x)
    const dx = -z * sign, dz = x * sign;
    let best = mesh.nbr[mesh.nbrStart[c]];
    let bestDot = -Infinity;
    for (let k = mesh.nbrStart[c]; k < mesh.nbrStart[c + 1]; k++) {
      const j = mesh.nbr[k];
      const d = (pos[j * 3] - x) * dx + (pos[j * 3 + 2] - z) * dz;
      if (d > bestDot) { bestDot = d; best = j; }
    }
    t[c] = best;
  }
  upwindCache.set(mesh, t);
  return t;
}

/** Relative precipitation by latitude: wet ITCZ, dry subtropics, wet mid-latitudes, dry poles. */
export function latitudeBand(absLatDeg: number): number {
  if (absLatDeg < 30) return 0.3 + 0.7 * (0.5 + 0.5 * Math.cos((absLatDeg / 30) * Math.PI));
  if (absLatDeg < 60) return 0.3 + 0.5 * (0.5 - 0.5 * Math.cos(((absLatDeg - 30) / 30) * Math.PI));
  return 0.15 + 0.65 * (0.5 + 0.5 * Math.cos(((absLatDeg - 60) / 30) * Math.PI));
}

/** Seasonal temperature. Coarse lenses (≥ half a year per tick) show annual means. */
export function updateSeasons(state: WorldState, rules: RulePack, dtYears: number): void {
  const f = state.fields;
  if (dtYears >= 0.5) {
    f.temperature.set(f.tempMean);
  } else {
    const s = Math.sin(2 * Math.PI * yearPhase(state.time));
    const n = state.mesh.count;
    const lat = state.mesh.lat;
    for (let i = 0; i < n; i++) f.temperature[i] = f.tempMean[i] + f.seasonAmp[i] * s * (lat[i] >= 0 ? 1 : -1);
  }
  void rules;
  touch(state, 'temperature');
}

/** 0 = northern spring equinox, 0.25 = northern summer solstice. */
export function yearPhase(timeYears: number): number {
  return timeYears - Math.floor(timeYears);
}

/** Latitude where the sun is overhead at noon, radians. */
export function subsolarLatitude(rules: RulePack, timeYears: number, dtYears: number): number {
  if (dtYears >= 0.5) return 0;
  return rules.climate.axialTiltDeg * DEG * Math.sin(2 * Math.PI * yearPhase(timeYears));
}

// ------------------------------------------------------------------ biomes

const biomeCache = new WeakMap<RulePack, { scope: ExprScope; evals: Evaluator[] }>();

function compiledBiomes(rules: RulePack) {
  let c = biomeCache.get(rules);
  if (!c) {
    const scope = new ExprScope(BIOME_VARIABLES);
    c = { scope, evals: rules.biomes.map((b) => compileExpr(b.when, scope).eval) };
    biomeCache.set(rules, c);
  }
  return c;
}

export function classifyBiomes(state: WorldState, rules: RulePack): void {
  const { scope, evals } = compiledBiomes(rules);
  const env = scope.createEnv();
  const sTemp = scope.slot('temp'), sMoist = scope.slot('moisture'), sElev = scope.slot('elevation');
  const sDepth = scope.slot('depth'), sLat = scope.slot('lat'), sAbs = scope.slot('absLat'), sOcean = scope.slot('ocean');
  const { mesh, fields } = state;
  const sea = state.seaLevel;
  for (let i = 0; i < mesh.count; i++) {
    const h = fields.elevation[i] - sea;
    const latDeg = mesh.lat[i] / DEG;
    env[sTemp] = fields.tempMean[i];
    env[sMoist] = fields.moisture[i];
    env[sElev] = h > 0 ? h : 0;
    env[sDepth] = h < 0 ? -h : 0;
    env[sLat] = latDeg;
    env[sAbs] = Math.abs(latDeg);
    env[sOcean] = h < 0 ? 1 : 0;
    let id = 255;
    for (let b = 0; b < evals.length; b++) {
      if (evals[b](env) !== 0) { id = b; break; }
    }
    fields.biome[i] = id;
  }
  touch(state, 'biome');
}

export class ClimateScratch {
  readonly a: Float32Array;
  readonly b: Float32Array;
  /** Baseline temperature (rule pack profile + altitude) and moisture before the global anomaly. */
  readonly base: Float32Array;
  readonly moist: Float32Array;
  constructor(n: number) {
    this.a = new Float32Array(n);
    this.b = new Float32Array(n);
    this.base = new Float32Array(n);
    this.moist = new Float32Array(n);
  }
}
