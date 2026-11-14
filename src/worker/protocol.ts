import type { LensId } from '../core/lens';
import type { BiomeSurface } from '../core/rules/schema';
import type { FieldName, WorldFields } from '../core/world/state';

/** Geometry the render thread needs, copied once from the worker. */
export interface MeshPayload {
  level: number;
  count: number;
  radiusKm: number;
  spacingKm: number;
  pos: Float32Array;
  lat: Float32Array;
  lon: Float32Array;
  nbrStart: Int32Array;
  nbr: Int32Array;
  faces: Uint32Array;
  faceCenter: Float32Array;
  ringStart: Int32Array;
  ring: Int32Array;
}

export interface BiomeInfo {
  id: string;
  name: string;
  color: string;
  /** Close-up look for the surface view (absent: inferred from climate). */
  surface?: BiomeSurface;
}

export interface WorldInfo {
  /** Wall-clock time the worker spent generating the world. */
  genMs: number;
  seed: number;
  packName: string;
  biomes: BiomeInfo[];
  lapseRateCPerKm: number;
}

export type FieldVersions = Partial<Record<FieldName, number>>;

/** Everything known about one cell, for the inspector. */
export interface CellInfo {
  cell: number;
  latDeg: number;
  lonDeg: number;
  /** Metres relative to sea level (negative = depth). */
  heightM: number;
  temperature: number;
  tempMean: number;
  seasonAmp: number;
  moisture: number;
  continentality: number;
  biome: number;
  plate: number;
  plateSpeedCmPerYr: number;
  crustKm: number;
  crustAgeMyr: number;
  continentalCrust: boolean;
  /** Plate-boundary convergence (> 0) or divergence (< 0); 0 inside a plate. */
  stress: number;
  /** Upstream rainfall draining through the cell, in cells of rain. */
  flow: number;
}

/** State the UI shows each frame. Only fields that changed since `known` are included. */
export interface Snapshot {
  cell?: CellInfo;
  time: number;
  tick: number;
  lens: LensId;
  dtYears: number;
  seaLevel: number;
  subsolarLat: number;
  tickMs: number;
  plateCount: number;
  /** Share of the surface above sea level. */
  landShare: number;
  hash?: number;
  fields: Partial<WorldFields>;
  versions: FieldVersions;
}

export type InitResult =
  | { ok: true; mesh: MeshPayload; world: WorldInfo; snapshot: Snapshot }
  | { ok: false; errors: string[] };

export interface SimApi {
  /** Validate the rule pack, build the world and return its mesh and first snapshot. */
  init(packData: unknown, seed: string | number, want: FieldName[]): Promise<InitResult>;
  /** Advance and return what changed among `want`. */
  step(ticks: number, want: FieldName[], known: FieldVersions, inspect?: number): Promise<Snapshot>;
  setLens(lens: LensId): Promise<void>;
  snapshot(want: FieldName[], known: FieldVersions, inspect?: number): Promise<Snapshot>;
  hash(): Promise<number>;
}
