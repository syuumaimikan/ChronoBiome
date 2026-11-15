import { hashBytes, hashCombine } from '../hash';
import type { GeodesicMesh } from './geodesic';
import { createGlobalClimate, type GlobalClimate } from '../systems/climate/global';
import { generateSystem, type StarSystem } from '../universe/system';
import { createBioState, type BioState } from '../systems/biosphere/bioState';
import { createCivState, type CivState } from '../systems/society/civState';

/**
 * Whole-world simulation state. Everything a system reads or writes lives in
 * flat typed arrays (structure of arrays), so ticks allocate nothing and layers
 * can be shipped to the render thread as raw buffers.
 */

/** Plates are created by rifting and die when consumed, so the table has fixed capacity. */
export const MAX_PLATES = 64;

export interface PlateTable {
  /** Slots in use (highest live id + 1). */
  count: number;
  alive: Uint8Array;
  /** Euler pole of each plate (unit vector, xyz interleaved). */
  pole: Float32Array;
  /** Angular speed around the pole, radians per year (signed). */
  omega: Float64Array;
  /** Speed the mantle drives the plate toward; collisions slow it below this. */
  drive: Float64Array;
  /** Rotation (radians) accumulated since the plate last moved one cell. */
  pending: Float64Array;
}

export interface WorldFields {
  /** Metres relative to the datum; sea level is `state.seaLevel`. Derived from the crust (isostasy). */
  elevation: Float32Array;
  plate: Uint16Array;
  /** Crust thickness, km (oceanic ≈ 7, continental ≈ 30–40, orogens up to 75). */
  crustThickness: Float32Array;
  /** Crust age, millions of years (drives thermal subsidence of the sea floor). */
  crustAge: Float32Array;
  /** Uncompensated relief (volcanic edifices, detail), metres. */
  relief: Float32Array;
  /** Plate-boundary convergence: > 0 converging, < 0 diverging, 0 inside plates. */
  stress: Float32Array;
  /** Drainage: rainfall accumulated from upstream, in "cells of rain". */
  flow: Float32Array;
  /** Annual mean temperature, °C. */
  tempMean: Float32Array;
  /** Current temperature including the seasonal cycle, °C. */
  temperature: Float32Array;
  /** Half the summer–winter difference, °C. */
  seasonAmp: Float32Array;
  /** 0..1 relative wetness. */
  moisture: Float32Array;
  /** 0 = maritime, 1 = deep continental interior. */
  continentality: Float32Array;
  /** Index into the rule pack's biome list (255 = none). */
  biome: Uint8Array;
  /** 0 wild, 1 farmland, 2 town, 3 ruins. */
  landUse: Uint8Array;
  /** Polity that holds the cell (-1 = none). */
  territory: Int16Array;
  /** People per km². */
  population: Float32Array;
  /** Animal species living in the cell's region. */
  richness: Float32Array;
  /** Magic field strength (0 without magic). */
  mana: Float32Array;
}

export type FieldName = keyof WorldFields;
export const FIELD_NAMES: readonly FieldName[] = [
  'elevation', 'plate', 'crustThickness', 'crustAge', 'relief', 'stress', 'flow',
  'tempMean', 'temperature', 'seasonAmp', 'moisture', 'continentality', 'biome',
  'landUse', 'territory', 'population', 'richness', 'mana',
];

export interface WorldState {
  readonly mesh: GeodesicMesh;
  readonly seed: number;
  /** Years since the formation of the world. */
  time: number;
  tick: number;
  seaLevel: number;
  /** Ocean water volume in metres × cells (cells are near-equal in area); conserved. */
  waterVolume: number;
  /** Mantle hotspots (fixed in the mantle frame, so plates drift over them). */
  hotspots: Int32Array;
  readonly plates: PlateTable;
  readonly fields: WorldFields;
  /** Bumped whenever a field is rewritten, so consumers can skip unchanged layers. */
  readonly versions: Record<FieldName, number>;
  /** Star, planets and moons. */
  readonly system: StarSystem;
  /** Global energy balance, carbon and ice. */
  readonly climate: GlobalClimate;
  /** Everything worth telling, oldest first. */
  readonly chronicle: ChronicleEntry[];
  /** Species, populations and the history of life. */
  readonly bio: BioState;
  /** Settlements, nations, technology, culture. */
  readonly civ: CivState;
  /** Recent physical events (impacts, eruptions) for other systems and the UI. */
  readonly events: WorldEvent[];
  /** Temporary climate modifiers from spells (°C, moisture), decaying. */
  readonly mods: ClimateMods;
  readonly magic: { arcane: number };
}

export interface WorldEvent {
  kind: 'impact' | 'lip' | 'eruption';
  time: number;
  cell: number;
  magnitude: number;
  handled?: boolean;
}

export interface ClimateMods {
  temp: Float32Array;
  moist: Float32Array;
  /** Decay rate per year of the modifiers. */
  decay: number;
  dirty: boolean;
  reliefDirty: boolean;
}

export interface WorldOptions {
  tiltDeg?: number;
  co2Ppm?: number;
  maxSpecies?: number;
}

export type ChronicleKind = 'geo' | 'climate' | 'life' | 'civ' | 'war' | 'tech' | 'religion' | 'disaster' | 'space' | 'magic' | 'sky';

export interface ChronicleEntry {
  /** Running number (never reused, so the UI can ask for entries after one). */
  seq: number;
  time: number;
  kind: ChronicleKind;
  text: string;
  cell?: number;
  polity?: number;
  species?: number;
}

/** Keep the chronicle bounded: old minor entries are dropped first. */
export function chronicle(state: WorldState, kind: ChronicleKind, text: string, extra: Partial<ChronicleEntry> = {}): void {
  const seq = (state.chronicle[state.chronicle.length - 1]?.seq ?? -1) + 1;
  state.chronicle.push({ time: state.time, kind, text, ...extra, seq });
  if (state.chronicle.length > 4000) state.chronicle.splice(0, 1000);
}

export function createWorldState(mesh: GeodesicMesh, seed: number, plateCount: number, opts: WorldOptions = {}): WorldState {
  const tiltDeg = opts.tiltDeg ?? 23.44;
  const co2Ppm = opts.co2Ppm ?? 280;
  const system = generateSystem(seed);
  const n = mesh.count;
  const versions = Object.fromEntries(FIELD_NAMES.map((f) => [f, 0])) as Record<FieldName, number>;
  const alive = new Uint8Array(MAX_PLATES);
  alive.fill(1, 0, plateCount);
  return {
    mesh,
    seed,
    time: 0,
    tick: 0,
    seaLevel: 0,
    waterVolume: 0,
    hotspots: new Int32Array(0),
    plates: {
      count: plateCount,
      alive,
      pole: new Float32Array(MAX_PLATES * 3),
      omega: new Float64Array(MAX_PLATES),
      drive: new Float64Array(MAX_PLATES),
      pending: new Float64Array(MAX_PLATES),
    },
    fields: {
      elevation: new Float32Array(n),
      plate: new Uint16Array(n),
      crustThickness: new Float32Array(n),
      crustAge: new Float32Array(n),
      relief: new Float32Array(n),
      stress: new Float32Array(n),
      flow: new Float32Array(n),
      tempMean: new Float32Array(n),
      temperature: new Float32Array(n),
      seasonAmp: new Float32Array(n),
      moisture: new Float32Array(n),
      continentality: new Float32Array(n),
      biome: new Uint8Array(n),
      landUse: new Uint8Array(n),
      territory: new Int16Array(n).fill(-1),
      population: new Float32Array(n),
      richness: new Float32Array(n),
      mana: new Float32Array(n),
    },
    versions,
    system,
    climate: createGlobalClimate(system, tiltDeg, co2Ppm),
    chronicle: [],
    bio: createBioState(mesh.level, opts.maxSpecies ?? 150),
    civ: createCivState(n),
    events: [],
    mods: { temp: new Float32Array(n), moist: new Float32Array(n), decay: 0, dirty: false, reliefDirty: false },
    magic: { arcane: 1 },
  };
}

export function touch(state: WorldState, ...names: FieldName[]): void {
  for (const n of names) state.versions[n]++;
}

export function livePlateCount(state: WorldState): number {
  let c = 0;
  for (let p = 0; p < state.plates.count; p++) c += state.plates.alive[p];
  return c;
}

/** Fingerprint of the full simulation state, for determinism checks. */
export function hashWorld(state: WorldState): number {
  let h = hashCombine(state.seed, state.tick);
  h = hashCombine(h, hashBytes(new Float64Array([state.time, state.seaLevel, state.waterVolume, state.plates.count])));
  for (const name of FIELD_NAMES) h = hashCombine(h, hashBytes(state.fields[name]));
  h = hashCombine(h, hashBytes(state.hotspots));
  h = hashCombine(h, hashBytes(state.plates.alive));
  h = hashCombine(h, hashBytes(state.plates.pole));
  h = hashCombine(h, hashBytes(state.plates.omega));
  h = hashCombine(h, hashBytes(state.plates.drive));
  h = hashCombine(h, hashBytes(state.plates.pending));
  h = hashCombine(h, hashBytes(new Float64Array([state.climate.co2Natural, state.climate.co2Excess, state.bio.stage, state.bio.nextId, state.bio.living.length, state.civ.nextId, state.civ.totalPop])));
  h = hashCombine(h, hashBytes(state.bio.density));
  return h;
}
