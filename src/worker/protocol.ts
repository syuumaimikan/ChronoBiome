import type { LensId } from '../core/lens';
import type { BiomeSurface } from '../core/rules/schema';
import type { SpellNode } from '../core/systems/magic/spell';
import type { ChronicleEntry, FieldName, WorldFields } from '../core/world/state';

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
  magic: boolean;
  starName: string;
  planets: { id: number; name: string; kind: string; a: number; color: string; home: boolean; moon: boolean }[];
}

export type FieldVersions = Partial<Record<FieldName, number>>;

/** A species as the surface view and lists need it. */
export interface SpeciesBrief {
  id: number;
  name: string;
  sci: string;
  clade: string;
  plan: 'grazer' | 'heavy' | 'small' | 'predator' | 'bird' | 'aquatic';
  massKg: number;
  diet: number;
  habitat: number;
  flight: boolean;
  hue: number;
  shade: number;
  pattern: number;
  horn: number;
  tail: number;
  /** Individuals per km² in the asked region (0 when not there). */
  density: number;
  sapient: boolean;
}

export interface SpeciesDetail extends SpeciesBrief {
  description: string;
  born: number;
  died: number;
  cause?: string;
  pop: number;
  peakPop: number;
  range: number;
  rangeKm2: number;
  tempOpt: number;
  tempTol: number;
  moistOpt: number;
  intelligence: number;
  social: number;
  dispersal: number;
  endotherm: boolean;
  domesticable: boolean;
  /** Ancestors, nearest first. */
  lineage: { id: number; name: string; clade: string; born: number; died: number }[];
  descendants: number;
  livingDescendants: number;
  /** How well the player's field journal knows it (0 unknown … 3 complete). */
  known: number;
  /** Diet partners in the same region: likely prey / predators. */
  prey: string[];
  predators: string[];
}

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
  landUse: number;
  /** People per km². */
  people: number;
  mana: number;
  richness: number;
  /** Species living in the cell's region, densest first. */
  life: SpeciesBrief[];
  /** Settlement owning the cell. */
  town?: { id: number; name: string; pop: number; polity: string; color: string };
  ruin?: { name: string; time: number; era: string };
}

export interface TownBrief {
  id: number;
  name: string;
  cell: number;
  pop: number;
  polity: number;
  color: string;
  era: number;
  capital: boolean;
  /** Building counts by index (only non-zero entries). */
  buildings: [number, number][];
  coastal: boolean;
  plague: boolean;
  aligned: boolean;
}

export interface WorldSummary {
  star: { name: string; stage: string; luminosity: number };
  climate: { co2: number; dT: number; iceShare: number; regime: string; emission: number };
  life: {
    stage: number;
    stageName: string;
    species: number;
    extinct: number;
    oxygen: number;
    vegetation: number;
    sapient: string | null;
    massExtinctions: number;
    clades: [string, number][];
  };
  civ: {
    started: boolean;
    era: number;
    eraName: string;
    pop: number;
    settlements: number;
    polities: number;
    wars: number;
    religions: number;
    languages: number;
    techs: number;
    colonies: number;
    ruins: number;
    spells: number;
    quests: number;
    deaths: { war: number; plague: number; famine: number };
    topPolities: { id: number; name: string; color: string; pop: number; settlements: number; gov: string }[];
  };
  lastSeq: number;
  keyframes: number;
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
  summary: WorldSummary;
  /** Chronicle entries after the asked sequence number. */
  chronicle: ChronicleEntry[];
  towns: TownBrief[];
  /** Trade links as [cell a, cell b, volume, by sea 0/1]. */
  links: [number, number, number, number][];
}

export interface Query {
  inspect?: number;
  /** Return chronicle entries with seq greater than this. */
  chronicleAfter: number;
}

export type InitResult =
  | { ok: true; mesh: MeshPayload; world: WorldInfo; snapshot: Snapshot }
  | { ok: false; errors: string[] };

export interface SettlementDetail {
  id: number;
  name: string;
  cell: number;
  founded: number;
  pop: number;
  K: number;
  urban: number;
  wealth: number;
  polity: { id: number; name: string; gov: string; color: string; capital: string; ruler: string; founded: number; religion: string };
  era: string;
  language: string;
  religion: string;
  values: { name: string; v: number }[];
  goods: { name: string; stock: number; price: number; supply: number; demand: number }[];
  techs: { name: string; era: string; field: string; adoption: number }[];
  researching: { name: string; progress: number; cost: number } | null;
  building: { name: string; progress: number; cost: number } | null;
  buildings: { name: string; count: number }[];
  plague: string | null;
  famine: boolean;
  deposits: string[];
  partners: string[];
  golems: number;
  people: { name: string; role: string; born: number; deeds: string[] }[];
}

export interface TechNode {
  id: string;
  name: string;
  era: number;
  field: string;
  req: string[];
  cost: number;
  magic: boolean;
  /** World time first invented (−1). */
  first: number;
  /** Share of settlements that know it, and the best adoption anywhere. */
  share: number;
  best: number;
}

export interface SkyInfo {
  time: number;
  moonPhase: number;
  bodies: { id: number; name: string; lon: number; lat: number; kind: string; color: string }[];
  stars: { lon: number; lat: number; mag: number }[];
  constellations: { name: string; lines: [number, number][]; lon: number; lat: number; zodiac: boolean }[];
  zodiac: string[];
  aspects: { a: string; b: string; name: string }[];
  events: { time: number; kind: string; text: string }[];
  chart: string;
  arcane: number;
  orrery: { id: number; name: string; x: number; y: number; a: number; color: string; kind: string; habitability: number; tempC: number }[];
}

export interface SpellPreview {
  ok: boolean;
  errors: string[];
  cost: number;
  stability: number;
  radius: number;
  years: number;
  summary: string;
}

export interface CastOutcome {
  ok: boolean;
  text: string;
  manaUsed: number;
  backfire: boolean;
}

export interface KeyframeInfo {
  index: number;
  label: string;
  time: number;
  tick: number;
}

export interface PlayerInfo {
  name: string;
  role: string;
  born: number;
  age: number;
  lifespan: number;
  chart: string;
  settlement: string;
  cell: number;
  wealth: number;
  inventory: string[];
  past: { name: string; role: string; deeds: string[] }[];
  deeds: string[];
  quests: { id: number; title: string; text: string; status: string; cell: number }[];
  observed: number;
  alive: boolean;
}

export type PlayerAction =
  | { kind: 'incarnate'; role: 'merchant' | 'mage' | 'explorer' | 'general' }
  | { kind: 'observe'; species: number }
  | { kind: 'excavate'; cell: number }
  | { kind: 'trade'; good: number; amount: number }
  | { kind: 'build'; building: number }
  | { kind: 'travel'; settlement: number }
  | { kind: 'cast'; nodes: SpellNode[]; cell: number };

export type Scenario = 'impact' | 'supervolcano' | 'pandemic' | 'solar_flare' | 'ice_age' | 'golden_age' | 'red_giant';

export interface LabRun {
  seed: number;
  /** Time series sampled every few ticks. */
  series: { time: number; species: number; dT: number; co2: number; pop: number; era: number }[];
  firstSapience: number;
  firstCity: number;
  finalEra: number;
  extinctions: number;
  massExtinctions: number;
  maxPop: number;
}

export interface SimApi {
  /** Validate the rule pack, build the world and return its mesh and first snapshot. */
  init(packData: unknown, seed: string | number, want: FieldName[]): Promise<InitResult>;
  /** Advance and return what changed among `want`. */
  step(ticks: number, want: FieldName[], known: FieldVersions, q: Query): Promise<Snapshot>;
  setLens(lens: LensId): Promise<void>;
  snapshot(want: FieldName[], known: FieldVersions, q: Query): Promise<Snapshot>;
  hash(): Promise<number>;
  species(id: number): Promise<SpeciesDetail | null>;
  /** Land and sea species around a cell (for the surface view's animals). */
  faunaAt(cell: number): Promise<SpeciesBrief[]>;
  settlement(id: number): Promise<SettlementDetail | null>;
  techTree(): Promise<TechNode[]>;
  sky(lonDeg: number): Promise<SkyInfo>;
  /** Species range as density per fine cell (for the range layer). */
  range(id: number): Promise<Float32Array>;
  planSpell(nodes: SpellNode[]): Promise<SpellPreview>;
  keyframe(label: string): Promise<KeyframeInfo[]>;
  keyframes(): Promise<KeyframeInfo[]>;
  restore(index: number): Promise<void>;
  scenario(kind: Scenario, cell: number): Promise<string>;
  player(): Promise<PlayerInfo | null>;
  act(action: PlayerAction): Promise<{ ok: boolean; text: string; player: PlayerInfo | null }>;
  exportWorld(): Promise<string>;
  worldBible(): Promise<string>;
  /** Headless run of a fresh world (Lab). */
  labRun(packData: unknown, seed: number, ticks: number, scenario?: Scenario): Promise<LabRun>;
}
