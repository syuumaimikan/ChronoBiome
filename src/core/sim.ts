import { lensById, type LensId } from './lens';
import type { RulePack } from './rules/schema';
import { Ecology } from './systems/biosphere/ecology';
import { applyTemperature, ClimateScratch, computeClimateStatic, updateSeasons } from './systems/climate/climate';
import { co2, stepGlobalClimate } from './systems/climate/global';
import { Civilization } from './systems/society/civ';
import { erode, ErosionScratch, routeDrainage } from './systems/terrain/erosion';
import { generateInitialTerrain } from './systems/terrain/initial';
import { deriveElevation, solveSeaLevel } from './systems/terrain/isostasy';
import { runTectonics, TectonicsScratch, type TectonicEvents } from './systems/terrain/tectonics';
import { buildGeodesic, type GeodesicMesh } from './world/geodesic';
import { chronicle, createWorldState, type WorldState } from './world/state';

/**
 * A system advances one aspect of the world. `periodYears` is the least
 * simulated time between runs: slow processes accumulate time across ticks and
 * run less often with a larger dt, fast ones run every tick.
 */
export interface SimSystem {
  readonly id: string;
  readonly periodYears: number;
  run(sim: Simulation, dtYears: number): void;
}

const meshCache = new Map<string, GeodesicMesh>();

/** Geodesic meshes are pure functions of (level, radius): build each once. */
export function getMesh(level: number, radiusKm: number): GeodesicMesh {
  const key = `${level}:${radiusKm}`;
  let m = meshCache.get(key);
  if (!m) {
    m = buildGeodesic(level, radiusKm);
    meshCache.set(key, m);
  }
  return m;
}

/** A full copy of the simulation state that can be restored later (time travel, branches). */
export interface Keyframe {
  tick: number;
  time: number;
  lens: LensId;
  acc: number[];
  state: Omit<WorldState, 'mesh'>;
  label: string;
}

export class Simulation {
  readonly rules: RulePack;
  state: WorldState;
  readonly systems: SimSystem[];
  readonly terrain: TerrainSystem;
  readonly climate: ClimateSystem;
  readonly ecology: Ecology;
  readonly civilization: Civilization;
  private lensId: LensId = 'geologic';
  private readonly acc: Float64Array;
  /** Wall-clock ms of the most recent tick, for the performance budget. */
  lastTickMs = 0;

  constructor(rules: RulePack, seed: number) {
    this.rules = rules;
    const mesh = getMesh(rules.world.gridLevel, rules.world.radiusKm);
    this.state = createWorldState(mesh, seed >>> 0, rules.terrain.plateCount, {
      tiltDeg: rules.climate.axialTiltDeg,
      co2Ppm: rules.carbon.co2Ppm,
      maxSpecies: rules.life.maxSpecies,
    });
    generateInitialTerrain(this.state, rules);
    this.terrain = new TerrainSystem(mesh.count);
    this.climate = new ClimateSystem();
    // Climate first (rivers need rainfall), then drainage on the initial terrain.
    this.climate.run(this, this.dt);
    this.terrain.run(this, 0);
    this.ecology = new Ecology(this.state);
    this.civilization = new Civilization(this.state, this.ecology);
    this.systems = [
      this.terrain,
      this.climate,
      { id: 'biosphere', periodYears: 10, run: (sim, dt) => this.ecology.step(sim.state, sim.rules, dt) },
      { id: 'civilization', periodYears: 1 / 12, run: (sim, dt) => this.civilization.step(sim.state, sim.rules, dt) },
    ];
    this.acc = new Float64Array(this.systems.length);
  }

  get lens(): LensId {
    return this.lensId;
  }

  set lens(id: LensId) {
    lensById(id);
    this.lensId = id;
  }

  /** Simulated years per tick under the current lens. */
  get dt(): number {
    const l = lensById(this.lensId);
    return Number.isFinite(l.dtYears) ? l.dtYears : this.autoDt();
  }

  /** The automatic lens: coarse while nothing but rocks and microbes change, fine once history begins. */
  autoDt(): number {
    const s = this.state;
    if (!s) return 1e7;
    const civ = s.civ;
    if (civ.started >= 0 && (civ.settlements.length || civ.colonies.length)) {
      const era = civ.era;
      return era < 1 ? 200 : era < 2 ? 20 : era < 4 ? 10 : era < 6 ? 5 : era < 7 ? 2 : 1;
    }
    const bio = s.bio;
    if (bio.sapientId >= 0) return 200;
    if (bio.stage >= 5) return 1e6;
    return 1e7;
  }

  /** Advance `ticks` ticks. */
  step(ticks = 1): void {
    const t0 = performance.now();
    for (let t = 0; t < ticks; t++) {
      const dt = this.dt;
      this.state.time += dt;
      this.state.tick++;
      for (let s = 0; s < this.systems.length; s++) {
        const sys = this.systems[s];
        this.acc[s] += dt;
        if (this.acc[s] >= sys.periodYears) {
          sys.run(this, this.acc[s]);
          this.acc[s] = 0;
        }
      }
      // Keep only recent physical events.
      if (this.state.events.length > 50) this.state.events.splice(0, this.state.events.length - 50);
    }
    this.lastTickMs = ticks > 0 ? (performance.now() - t0) / ticks : 0;
  }

  keyframe(label = ''): Keyframe {
    const { mesh, ...rest } = this.state;
    void mesh;
    return { tick: this.state.tick, time: this.state.time, lens: this.lensId, acc: Array.from(this.acc), state: structuredClone(rest), label };
  }

  restore(k: Keyframe): void {
    const clone = structuredClone(k.state);
    this.state = { ...clone, mesh: this.state.mesh } as WorldState;
    this.acc.set(k.acc);
    this.lensId = k.lens;
    this.climate.invalidate();
    this.civilization.invalidate();
    this.ecology.invalidate();
  }
}

/**
 * Plate tectonics, isostasy, rivers and erosion, and the sea level that keeps
 * the ocean's water volume constant. Runs at most every 100,000 years.
 */
export class TerrainSystem implements SimSystem {
  readonly id = 'terrain';
  readonly periodYears = 1e5;
  private readonly tectonics: TectonicsScratch;
  private readonly erosion: ErosionScratch;
  /** Totals since the world began, for the chronicle and tests. */
  readonly totals: TectonicEvents = { moves: 0, rifts: 0, reorganisations: 0, platesDied: 0 };

  constructor(n: number) {
    this.tectonics = new TectonicsScratch(n);
    this.erosion = new ErosionScratch(n);
  }

  run(sim: Simulation, dtYears: number): void {
    const s = sim.state;
    if (dtYears > 0) {
      const ev = runTectonics(s, sim.rules, dtYears, this.tectonics);
      this.totals.moves += ev.moves;
      this.totals.rifts += ev.rifts;
      this.totals.reorganisations += ev.reorganisations;
      this.totals.platesDied += ev.platesDied;
      if (ev.rifts > 0 && s.time > 0) chronicle(s, 'geo', '大陸が裂け始め、新しい海が生まれつつある。');
      deriveElevation(s, sim.rules);
      solveSeaLevel(s);
    }
    routeDrainage(s, this.erosion);
    if (dtYears > 0) {
      erode(s, sim.rules, dtYears, this.erosion);
      deriveElevation(s, sim.rules);
      solveSeaLevel(s);
    }
  }
}

function landShare(s: WorldState): number {
  const e = s.fields.elevation;
  let land = 0;
  for (let i = 0; i < e.length; i++) if (e[i] >= s.seaLevel) land++;
  return land / e.length;
}

/**
 * Keeps climate consistent with terrain, advances the global energy balance
 * and carbon cycle, ice sheets and the sea level they set, spells' climate
 * modifiers, and the seasonal cycle.
 */
export class ClimateSystem implements SimSystem {
  readonly id = 'climate';
  readonly periodYears = 0;
  private terrainVersion = -1;
  private seaLevel = NaN;
  private scratch: ClimateScratch | null = null;
  private lastWasCoarse = false;
  private landShare0 = -1;
  private regime = '';
  private co2Mark = 0;
  private iceVolume = -1;

  invalidate(): void {
    this.terrainVersion = -1;
    this.seaLevel = NaN;
    this.iceVolume = -1;
  }

  run(sim: Simulation, dtYears: number): void {
    const s = sim.state;
    const rules = sim.rules;
    this.scratch ??= new ClimateScratch(s.mesh.count);
    const land = landShare(s);
    if (this.landShare0 < 0) this.landShare0 = land;
    const globalChanged = stepGlobalClimate(s.climate, s.system, rules.climate.axialTiltDeg, s.time, dtYears, land, this.landShare0);
    // Spells' climate modifiers fade.
    const mods = s.mods;
    if (mods.decay > 0) {
      const k = Math.exp(-mods.decay * Math.max(dtYears, 1e-3));
      let mx = 0;
      for (let i = 0; i < mods.temp.length; i++) {
        mods.temp[i] *= k;
        mods.moist[i] *= k;
        mx = Math.max(mx, Math.abs(mods.temp[i]), Math.abs(mods.moist[i]) * 20);
      }
      if (mx < 0.05) { mods.temp.fill(0); mods.moist.fill(0); mods.decay = 0; }
      mods.dirty = true;
    }
    if (mods.reliefDirty) {
      deriveElevation(s, rules);
      solveSeaLevel(s);
      mods.reliefDirty = false;
    }
    let changed = false;
    if (s.versions.elevation !== this.terrainVersion || !(Math.abs(s.seaLevel - this.seaLevel) < 2)) {
      computeClimateStatic(s, rules, this.scratch);
      this.terrainVersion = s.versions.elevation;
      this.seaLevel = s.seaLevel;
      changed = true;
    } else if (globalChanged || mods.dirty) {
      applyTemperature(s, rules, this.scratch);
      changed = true;
    }
    mods.dirty = false;
    // Ice sheets lock up sea water: the sea level follows.
    if (changed && Math.abs(s.climate.iceVolume - this.iceVolume) > 1) {
      this.iceVolume = s.climate.iceVolume;
      solveSeaLevel(s);
    }
    this.chronicle(s);
    // Under coarse lenses the temperature is the annual mean: only rewrite it when that mean changed.
    const coarse = dtYears >= 0.5;
    if (coarse && this.lastWasCoarse && !changed) return;
    updateSeasons(s, rules, dtYears);
    this.lastWasCoarse = coarse;
  }

  private chronicle(s: WorldState): void {
    const g = s.climate;
    if (s.time <= 0) return;
    const regime = g.iceShare > 0.6 ? 'snowball' : g.iceShare > 0.22 ? 'glacial' : g.meanAnomaly > 6 ? 'hothouse' : 'normal';
    if (this.regime && regime !== this.regime) {
      const text = {
        snowball: '氷床が赤道近くまで広がり、惑星はほぼ全球凍結した。',
        glacial: '氷期が始まった。大陸に氷床が広がり、海面が下がっていく。',
        hothouse: '温室期に入った。極の氷が消え、海面が高い。',
        normal: this.regime === 'glacial' || this.regime === 'snowball' ? '氷期が終わり、氷床が後退して海面が上がった。' : '温室期が終わり、気候が落ち着いた。',
      }[regime];
      chronicle(s, 'climate', `${text}（平均気温の変化 ${g.meanAnomaly >= 0 ? '+' : ''}${g.meanAnomaly.toFixed(1)}℃、CO2 ${co2(g).toFixed(0)} ppm、海面 ${s.seaLevel.toFixed(0)} m）`);
    }
    this.regime = regime;
    const c = co2(g);
    if (g.emittedTotal > 1) {
      const mark = Math.floor(c / 50) * 50;
      if (mark > this.co2Mark && mark >= 350) {
        if (this.co2Mark > 0) chronicle(s, 'climate', `化石燃料の燃焼で大気の CO2 が ${mark} ppm を超えた（気温 ${g.meanAnomaly >= 0 ? '+' : ''}${g.meanAnomaly.toFixed(1)}℃）。`);
        this.co2Mark = mark;
      }
    } else this.co2Mark = Math.max(this.co2Mark, Math.floor(c / 50) * 50);
  }
}
