import type { SpellNode } from '../magic/spell';
import type { Role } from './data';

/**
 * Plain-data state of civilisation (so keyframes are structured clones).
 * Settlements are the unit of everything: a settlement is a town with its
 * hinterland — farms, pastures and hunting grounds — on the cells it controls.
 */

export interface Settlement {
  id: number;
  name: string;
  cell: number;
  region: number;
  polity: number;
  founded: number;
  pop: number;
  peakPop: number;
  /** Carrying capacity from the land and food imports. */
  K: number;
  /** Share living in the town itself. */
  urban: number;
  wealth: number;
  stock: Float32Array;
  price: Float32Array;
  supply: Float32Array;
  demand: Float32Array;
  /** Adoption 0..1 of each technology (0 = unknown). */
  tech: Float32Array;
  research: number;
  progress: number;
  buildings: Uint16Array;
  build: number;
  buildProgress: number;
  /** Language vector, language id, cultural values (see data.VALUES). */
  lang: Float32Array;
  langId: number;
  values: Float32Array;
  religion: number;
  devotion: number;
  /** Epidemic: pathogen id (−1 none), years left, share infected this outbreak, share immune. */
  plague: number;
  plagueLeft: number;
  plagueAttack: number;
  immune: number;
  /** Share of the people the current outbreak kills per year (0 when none). */
  plagueToll?: number;
  deposits: number;
  coastal: boolean;
  river: boolean;
  loyalty: number;
  /** Cells it controls; farmed cells. */
  catchment: number;
  farmCells: number;
  foodImport: number;
  lastFamine: number;
  /** Temporary magic boons, decaying. */
  buffs: { food: number; health: number; defense: number; morale: number };
  /** Orientation of its sky-aligned monument (degrees from north, NaN none) and whether it lines up now. */
  megaAzimuth: number;
  aligned: boolean;
  golems: number;
  /** Sum of effects (cached each step). */
  fx: Float32Array;
}

export interface Polity {
  id: number;
  base: string;
  name: string;
  color: string;
  capital: number;
  founded: number;
  fell: number;
  gov: number;
  values: Float32Array;
  religion: number;
  langId: number;
  treasury: number;
  opinion: Record<number, number>;
  ruler: number;
  pop: number;
  settlements: number;
  territory: number;
  strength: number;
  era: number;
  /** Polity this one split from (−1). */
  parent: number;
}

export interface Religion {
  id: number;
  name: string;
  founded: number;
  origin: string;
  deity: number;
  doctrine: number;
  color: string;
  followers: number;
  prophet: number;
  cause: string;
}

export interface Language {
  id: number;
  name: string;
  parent: number;
  founded: number;
  vec: number[];
  seed: number;
  speakers: number;
}

export interface Pathogen {
  id: number;
  name: string;
  born: number;
  /** Basic reproduction number and share of the infected who die. */
  r0: number;
  lethality: number;
  origin: string;
  deaths: number;
  cases: number;
  host: string;
}

export interface Person {
  id: number;
  name: string;
  born: number;
  died: number;
  lifespan: number;
  role: Role;
  settlement: number;
  polity: number;
  chart: string;
  /** Value modifiers from the birth chart. */
  traits: number[];
  deeds: string[];
}

export type ArtifactKind = 'inscription' | 'blueprint' | 'grimoire' | 'relic';

export interface Artifact {
  id: number;
  kind: ArtifactKind;
  cell: number;
  /** Burial depth (m): sediment buries it, erosion exposes it. */
  depth: number;
  time: number;
  from: string;
  langId: number;
  tech: number;
  spell: SpellNode[] | null;
  text: string;
  found: boolean;
  /** Settlement deciphering it (−1) and progress 0..1. */
  decipherAt: number;
  progress: number;
}

export interface TradeLink {
  a: number;
  b: number;
  km: number;
  sea: boolean;
  /** Value traded per year (smoothed). */
  volume: number;
}

export interface War {
  a: number;
  b: number;
  started: number;
  cause: string;
  /** Exhaustion of each side; peace when it is high. */
  wearA: number;
  wearB: number;
  battles: number;
}

export interface Ruin {
  cell: number;
  name: string;
  time: number;
  pop: number;
  era: number;
  polity: string;
  buildings: number[];
  /** A runaway golem or apex beast guarding it (for dungeons). */
  guardian: string;
}

export interface Colony {
  id: number;
  body: number;
  name: string;
  pop: number;
  founded: number;
  polity: number;
  terraform: number;
}

export interface Golem {
  id: number;
  settlement: number;
  material: 'clay' | 'stone' | 'iron' | 'crystal';
  routine: SpellNode[];
  durability: number;
  mana: number;
  manaCap: number;
  state: 'working' | 'idle' | 'rampant';
  built: number;
  output: string;
}

export interface Quest {
  id: number;
  kind: 'protect' | 'cull' | 'epidemic' | 'famine' | 'mana' | 'excavate';
  title: string;
  text: string;
  target: number;
  cell: number;
  created: number;
  baseline: number;
  status: 'open' | 'done' | 'failed';
}

export interface PlayerState {
  person: number;
  settlement: number;
  wealth: number;
  inventory: number[];
  past: number[];
  journal: { observed: Record<number, number> };
}

export interface CivState {
  started: number;
  settlements: Settlement[];
  polities: Polity[];
  religions: Religion[];
  languages: Language[];
  pathogens: Pathogen[];
  persons: Person[];
  artifacts: Artifact[];
  links: TradeLink[];
  wars: War[];
  ruins: Ruin[];
  colonies: Colony[];
  golems: Golem[];
  quests: Quest[];
  player: PlayerState | null;
  nextId: number;
  /** World time each technology was first invented (−1). */
  firstTech: number[];
  era: number;
  totalPop: number;
  deathsWar: number;
  deathsPlague: number;
  deathsFamine: number;
  /** Cell → owning settlement id (−1). */
  owner: Int32Array;
  deposits: Uint8Array;
  depositsAt: number;
  territoryAt: number;
  linksAt: number;
  spaceMilestones: string[];
  /** Spells invented by civilisations. */
  spells: { name: string; nodes: SpellNode[]; by: string; time: number }[];
}

export function createCivState(cells: number): CivState {
  return {
    started: -1,
    settlements: [],
    polities: [],
    religions: [],
    languages: [],
    pathogens: [],
    persons: [],
    artifacts: [],
    links: [],
    wars: [],
    ruins: [],
    colonies: [],
    golems: [],
    quests: [],
    player: null,
    nextId: 1,
    firstTech: [],
    era: -1,
    totalPop: 0,
    deathsWar: 0,
    deathsPlague: 0,
    deathsFamine: 0,
    owner: new Int32Array(cells).fill(-1),
    deposits: new Uint8Array(cells),
    depositsAt: -1,
    territoryAt: -1e9,
    linksAt: -1e9,
    spaceMilestones: [],
    spells: [],
  };
}
