import { lensById, type LensId } from './lens';
import type { RulePack } from './rules/schema';
import { ClimateScratch, computeClimateStatic, updateSeasons } from './systems/climate/climate';
import { erode, ErosionScratch, routeDrainage } from './systems/terrain/erosion';
import { generateInitialTerrain } from './systems/terrain/initial';
import { deriveElevation, solveSeaLevel } from './systems/terrain/isostasy';
import { runTectonics, TectonicsScratch, type TectonicEvents } from './systems/terrain/tectonics';
import { buildGeodesic, type GeodesicMesh } from './world/geodesic';
import { createWorldState, type WorldState } from './world/state';

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

export class Simulation {
  readonly rules: RulePack;
  readonly state: WorldState;
  readonly systems: SimSystem[];
  readonly terrain: TerrainSystem;
  private lensId: LensId = 'geologic';
  private readonly acc: Float64Array;
  /** Wall-clock ms of the most recent tick, for the performance budget. */
  lastTickMs = 0;

  constructor(rules: RulePack, seed: number) {
    this.rules = rules;
    const mesh = getMesh(rules.world.gridLevel, rules.world.radiusKm);
    this.state = createWorldState(mesh, seed >>> 0, rules.terrain.plateCount);
    generateInitialTerrain(this.state, rules);
    this.terrain = new TerrainSystem(mesh.count);
    const climate = new ClimateSystem();
    // Climate first (rivers need rainfall), then drainage on the initial terrain.
    climate.run(this, this.dt);
    this.terrain.run(this, 0);
    this.systems = [this.terrain, climate];
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
    return lensById(this.lensId).dtYears;
  }

  /** Advance `ticks` ticks. */
  step(ticks = 1): void {
    const dt = this.dt;
    const t0 = performance.now();
    for (let t = 0; t < ticks; t++) {
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
    }
    this.lastTickMs = ticks > 0 ? (performance.now() - t0) / ticks : 0;
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

/** Keeps climate consistent with terrain and advances the seasonal cycle. */
class ClimateSystem implements SimSystem {
  readonly id = 'climate';
  readonly periodYears = 0;
  private terrainVersion = -1;
  private seaLevel = NaN;
  private scratch: ClimateScratch | null = null;
  private lastWasCoarse = false;

  run(sim: Simulation, dtYears: number): void {
    const s = sim.state;
    let changed = false;
    if (s.versions.elevation !== this.terrainVersion || s.seaLevel !== this.seaLevel) {
      this.scratch ??= new ClimateScratch(s.mesh.count);
      computeClimateStatic(s, sim.rules, this.scratch);
      this.terrainVersion = s.versions.elevation;
      this.seaLevel = s.seaLevel;
      changed = true;
    }
    // Under coarse lenses the temperature is the annual mean: only rewrite it when that mean changed.
    const coarse = dtYears >= 0.5;
    if (coarse && this.lastWasCoarse && !changed) return;
    updateSeasons(s, sim.rules, dtYears);
    this.lastWasCoarse = coarse;
  }
}
