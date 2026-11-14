import { hashBytes, hashCombine } from '../hash';
import type { GeodesicMesh } from './geodesic';

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
}

export type FieldName = keyof WorldFields;
export const FIELD_NAMES: readonly FieldName[] = [
  'elevation', 'plate', 'crustThickness', 'crustAge', 'relief', 'stress', 'flow',
  'tempMean', 'temperature', 'seasonAmp', 'moisture', 'continentality', 'biome',
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
}

export function createWorldState(mesh: GeodesicMesh, seed: number, plateCount: number): WorldState {
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
    },
    versions,
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
  return h;
}
