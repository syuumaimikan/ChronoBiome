import { signal } from '@preact/signals';
import { wrap, type Remote } from 'comlink';
import type { LensId } from '../core/lens';
import { earthLikePack } from '../core/rules/packs/earthLike';
import { parseRulePackText } from '../core/rules/schema';
import type { SpellNode } from '../core/systems/magic/spell';
import type { ChronicleEntry, FieldName, WorldFields } from '../core/world/state';
import { chat, loadSettings, saveSettings, tasks, type LlmSettings } from '../llm/llm';
import type { ExploreMode } from '../render/explorer';
import { layerById, type LayerId } from '../render/layers';
import { PlanetView, type ViewStatus } from '../render/planetView';
import { resolveLooks, type BiomeLook } from '../render/surface/looks';
import { SurfaceSampler } from '../render/surface/sampler';
import type {
  CellInfo, FieldVersions, InitResult, KeyframeInfo, LabRun, MeshPayload, PlayerAction, PlayerInfo, Scenario, SettlementDetail, SimApi, SkyInfo, Snapshot,
  SpeciesDetail, TechNode, TownBrief, WorldInfo, WorldSummary,
} from '../worker/protocol';

/** Fields the close-up surface is built from. */
const SURFACE_FIELDS: FieldName[] = ['elevation', 'biome', 'moisture', 'tempMean', 'landUse'];
/** While time runs, rebuild the surface at most this often (ms). */
const SURFACE_REBUILD_MS = 2500;
const MAX_CHRONICLE = 800;

export type Panel = 'cell' | 'chronicle' | 'world' | 'nations' | 'species' | 'town' | 'tech' | 'sky' | 'spell' | 'play' | 'lab' | 'export' | 'llm';

/** One sample of the world's vital signs, for the charts. */
export interface Sample {
  time: number;
  species: number;
  co2: number;
  dT: number;
  pop: number;
  era: number;
  settlements: number;
}

export interface LabJob {
  seed: number;
  status: 'queued' | 'running' | 'done' | 'error';
  run?: LabRun;
  error?: string;
}

/** UI state, shared by all components. */
export const ui = {
  packText: signal(JSON.stringify(earthLikePack, null, 2)),
  packErrors: signal<string[]>([]),
  seed: signal('Gaia'),
  layer: signal<LayerId>('biome'),
  lens: signal<LensId>('auto'),
  playing: signal(false),
  ticksPerFrame: signal(1),
  exaggeration: signal(30),
  status: signal<'idle' | 'generating' | 'ready' | 'error'>('idle'),
  errors: signal<string[]>([]),
  world: signal<WorldInfo | null>(null),
  time: signal(0),
  tick: signal(0),
  dtYears: signal(1e6),
  tickMs: signal(0),
  genMs: signal(0),
  fps: signal(0),
  plateCount: signal(0),
  landShare: signal(0),
  seaLevel: signal(0),
  selected: signal(-1),
  cell: signal<CellInfo | null>(null),
  /** Bumped whenever layer data changes, so the legend recomputes. */
  paintVersion: signal(0),
  tab: signal<'observe' | 'rules'>('observe'),
  /** Camera / player state for the HUD. */
  view: signal<ViewStatus | null>(null),
  mode: signal<ExploreMode>('orbit'),
  timeFlows: signal(true),
  summary: signal<WorldSummary | null>(null),
  chronicle: signal<ChronicleEntry[]>([]),
  towns: signal<TownBrief[]>([]),
  panel: signal<Panel>('world'),
  panelOpen: signal(true),
  history: signal<Sample[]>([]),
  lab: signal<LabJob[]>([]),
  species: signal<SpeciesDetail | null>(null),
  speciesNote: signal(''),
  town: signal<SettlementDetail | null>(null),
  tech: signal<TechNode[]>([]),
  sky: signal<SkyInfo | null>(null),
  keyframes: signal<KeyframeInfo[]>([]),
  player: signal<PlayerInfo | null>(null),
  toast: signal(''),
  /** Species whose range is painted on the "range" layer. */
  rangeOf: signal(-1),
  llm: signal<LlmSettings>(loadSettings()),
  llmBusy: signal(false),
  narration: signal(''),
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, ms = 4000): void {
  ui.toast.value = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.value = ''), ms);
}

class Controller {
  private readonly api: Remote<SimApi>;
  private view: PlanetView | null = null;
  private cache: Partial<WorldFields> = {};
  private known: FieldVersions = {};
  private seaLevel = 0;
  private rgb = new Uint8Array(0);
  private pumping = false;
  private busy: Promise<unknown> = Promise.resolve();
  private mesh: MeshPayload | null = null;
  private looks: BiomeLook[] = [];
  private surfaceAt = -1e9;
  private surfaceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq = -1;
  private range: Float32Array | null = null;
  private faunaCell = -1;
  private faunaAt = 0;

  constructor() {
    this.api = this.spawn();
    setInterval(() => {
      if (this.view) ui.fps.value = Math.round(this.view.fps);
    }, 1000);
    setInterval(() => {
      if (!this.view || ui.tab.value !== 'observe') return;
      ui.view.value = this.view.status();
      void this.updateFauna();
    }, 250);
    // While walking, the inspector follows the ground under the player.
    setInterval(() => {
      if (!this.view || ui.mode.value !== 'walk' || ui.status.value !== 'ready') return;
      const cell = this.view.observerCell();
      if (cell >= 0 && cell !== ui.selected.value) this.select(cell);
    }, 1000);
  }

  /** A simulation worker (the Lab uses extra ones for headless runs). */
  spawn(): Remote<SimApi> {
    return this.spawnWorker().api;
  }

  private spawnWorker(): { api: Remote<SimApi>; worker: Worker } {
    const worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
    return { api: wrap<SimApi>(worker), worker };
  }

  get fields(): Partial<WorldFields> {
    return this.cache;
  }

  attach(canvas: HTMLCanvasElement): void {
    if (this.view) return;
    this.view = new PlanetView(canvas);
    this.view.onMode = (m) => (ui.mode.value = m);
    this.view.onPickAnimal = (id) => void this.showSpecies(id, true);
    this.view.onPickTown = (id) => void this.showTown(id);
    void this.generate();
  }

  get planet(): PlanetView | null {
    return this.view;
  }

  private want(): FieldName[] {
    return [...new Set<FieldName>([...SURFACE_FIELDS, ...layerById(ui.layer.value).fields])];
  }

  private query() {
    return { inspect: ui.selected.value >= 0 ? ui.selected.value : undefined, chronicleAfter: this.lastSeq };
  }

  /** Rebuild the close-up surface from the latest fields (throttled while time runs). */
  private scheduleSurface(now = false): void {
    if (this.surfaceTimer) return;
    const wait = now ? 0 : Math.max(0, this.surfaceAt + SURFACE_REBUILD_MS - performance.now());
    if (wait === 0) {
      this.buildSurface();
      return;
    }
    this.surfaceTimer = setTimeout(() => {
      this.surfaceTimer = null;
      this.buildSurface();
    }, wait);
  }

  private buildSurface(): void {
    const world = ui.world.value;
    const c = this.cache;
    if (!world || !this.view || !this.mesh || !c.elevation || !c.biome || !c.moisture || !c.tempMean) return;
    this.surfaceAt = performance.now();
    const sampler = new SurfaceSampler({
      mesh: this.mesh,
      elevation: c.elevation,
      biome: c.biome,
      moisture: c.moisture,
      tempMean: c.tempMean,
      seaLevel: this.seaLevel,
      seed: world.seed,
      lapseRateCPerKm: world.lapseRateCPerKm,
    });
    const natural = ui.layer.value === 'biome';
    this.view.setSurface(sampler, this.looks, world.seed, natural ? null : this.rgb.slice(), c.landUse ?? null, ui.summary.value?.life.vegetation ?? 1);
  }

  /** Serialise worker calls so play, layer and lens changes never interleave. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  async generate(): Promise<void> {
    const parsed = parseRulePackText(ui.packText.value);
    if (!parsed.ok) {
      ui.status.value = 'error';
      ui.errors.value = parsed.errors;
      ui.packErrors.value = parsed.errors;
      return;
    }
    ui.playing.value = false;
    ui.status.value = 'generating';
    ui.errors.value = [];
    ui.packErrors.value = [];
    const res = await this.queue<InitResult>(
      () => this.api.init(JSON.parse(ui.packText.value), ui.seed.value, this.want()) as Promise<InitResult>,
    );
    if (!res.ok) {
      ui.status.value = 'error';
      ui.errors.value = res.errors;
      return;
    }
    this.cache = {};
    this.known = {};
    this.lastSeq = -1;
    this.range = null;
    ui.rangeOf.value = -1;
    ui.chronicle.value = [];
    ui.history.value = [];
    ui.species.value = null;
    ui.town.value = null;
    ui.player.value = null;
    ui.narration.value = '';
    this.rgb = new Uint8Array(res.mesh.count * 3);
    this.mesh = res.mesh;
    this.looks = resolveLooks(res.world.biomes);
    if (this.surfaceTimer) clearTimeout(this.surfaceTimer);
    this.surfaceTimer = null;
    ui.world.value = res.world;
    this.view!.setMesh(res.mesh);
    await this.queue(() => this.api.setLens(ui.lens.value));
    ui.genMs.value = res.world.genMs;
    this.apply(res.snapshot, true);
    ui.status.value = 'ready';
    if (ui.selected.value >= 0) this.select(ui.selected.value);
    void this.loadKeyframes();
  }

  private apply(s: Snapshot, forcePaint = false): void {
    let repaint = forcePaint;
    let surface = forcePaint;
    const layer = layerById(ui.layer.value);
    for (const [name, arr] of Object.entries(s.fields) as [FieldName, WorldFields[FieldName]][]) {
      (this.cache as Record<string, unknown>)[name] = arr;
      if (layer.fields.includes(name)) repaint = true;
      if (SURFACE_FIELDS.includes(name)) surface = true;
    }
    Object.assign(this.known, s.versions);
    const seaChanged = s.seaLevel !== this.seaLevel;
    this.seaLevel = s.seaLevel;
    if (s.fields.elevation || seaChanged) this.view?.setRelief(this.cache.elevation!, this.seaLevel, ui.exaggeration.value);
    if (repaint || seaChanged) this.repaint();
    const prevVeg = ui.summary.value?.life.vegetation ?? -1;
    if (surface || seaChanged || (repaint && ui.layer.value !== 'biome') || Math.abs(prevVeg - s.summary.life.vegetation) > 0.05) this.scheduleSurface(forcePaint || !this.view?.hasSurface);
    this.view?.setSubsolarLatitude(s.subsolarLat);
    ui.time.value = s.time;
    ui.tick.value = s.tick;
    ui.dtYears.value = s.dtYears;
    ui.tickMs.value = s.tickMs;
    ui.plateCount.value = s.plateCount;
    ui.landShare.value = s.landShare;
    ui.seaLevel.value = s.seaLevel;
    ui.summary.value = s.summary;
    if (s.cell) ui.cell.value = s.cell;
    if (s.chronicle.length) {
      this.lastSeq = s.chronicle[s.chronicle.length - 1].seq;
      const all = ui.chronicle.value.concat(s.chronicle);
      ui.chronicle.value = all.length > MAX_CHRONICLE ? all.slice(all.length - MAX_CHRONICLE) : all;
    }
    const townsChanged = s.towns.length !== ui.towns.value.length || s.towns.some((t, i) => {
      const o = ui.towns.value[i];
      return !o || o.id !== t.id || o.era !== t.era || o.color !== t.color || o.buildings.length !== t.buildings.length || Math.abs(Math.log((t.pop + 1) / (o.pop + 1))) > 0.1;
    });
    ui.towns.value = s.towns;
    if (townsChanged || s.links.length !== this.linkCount) {
      this.linkCount = s.links.length;
      this.view?.setTowns(s.towns, s.links);
    }
    this.sample(s);
    this.refreshDetails();
  }

  private linkCount = -1;
  private detailAt = 0;

  /** Keep the vital-signs history (one sample per noticeable change). */
  private sample(s: Snapshot): void {
    const h = ui.history.value;
    const last = h[h.length - 1];
    const sm = s.summary;
    const next: Sample = { time: s.time, species: sm.life.species, co2: sm.climate.co2, dT: sm.climate.dT, pop: sm.civ.pop, era: sm.civ.era, settlements: sm.civ.settlements };
    if (last && last.time >= s.time) {
      // Time went backwards (restored a keyframe): start the chart again from here.
      if (last.time > s.time) ui.history.value = [next];
      return;
    }
    if (last && s.time - last.time < s.dtYears * 4 && last.species === next.species && Math.abs(last.pop - next.pop) < 0.02 * (last.pop + 1)) return;
    const all = h.length >= 600 ? h.filter((_, i) => i % 2 === 0) : h.slice();
    all.push(next);
    ui.history.value = all;
  }

  /** Re-read the open species / town card now and then, so it follows the simulation. */
  private refreshDetails(): void {
    const now = performance.now();
    if (now - this.detailAt < 1500) return;
    this.detailAt = now;
    const p = ui.panel.value;
    if (p === 'town' && ui.town.value) {
      const id = ui.town.value.id;
      void this.api.settlement(id).then((d) => {
        if (ui.town.value?.id === id) ui.town.value = d;
      });
    } else if (p === 'species' && ui.species.value) {
      const id = ui.species.value.id;
      void this.api.species(id).then((d) => {
        if (ui.species.value?.id === id && d) ui.species.value = d;
      });
    } else if (p === 'play' && ui.player.value) {
      void this.api.player().then((pl) => (ui.player.value = pl));
    } else if (p === 'tech' && ui.playing.value) {
      void this.api.techTree().then((t) => (ui.tech.value = t));
    }
  }

  // ------------------------------------------------------------ lab

  /** Run fresh worlds headlessly, several at once in their own workers. */
  async runLab(seeds: number[], ticks: number, scenario?: Scenario): Promise<void> {
    const pack = JSON.parse(ui.packText.value);
    const jobs: LabJob[] = seeds.map((seed) => ({ seed, status: 'queued' }));
    ui.lab.value = jobs;
    const update = () => (ui.lab.value = [...jobs]);
    const parallel = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    let next = 0;
    const lane = async () => {
      const { api, worker } = this.spawnWorker();
      while (next < jobs.length) {
        const job = jobs[next++];
        job.status = 'running';
        update();
        try {
          job.run = await api.labRun(pack, job.seed, ticks, scenario);
          job.status = 'done';
        } catch (e) {
          job.status = 'error';
          job.error = (e as Error).message;
        }
        update();
      }
      worker.terminate();
    };
    await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, lane));
  }

  private repaint(): void {
    const world = ui.world.value;
    const layer = layerById(ui.layer.value);
    if (!world || !this.view || layer.fields.some((f) => !this.cache[f])) return;
    layer.paint(this.rgb, this.cache, world, this.seaLevel, { range: this.range, towns: ui.towns.value });
    this.view.setCellColors(this.rgb);
    ui.paintVersion.value++;
  }

  async refresh(): Promise<void> {
    if (ui.status.value !== 'ready') return;
    const snap = await this.queue(() => this.api.snapshot(this.want(), this.known, this.query()));
    this.apply(snap);
  }

  setLayer(id: LayerId): void {
    ui.layer.value = id;
    if (layerById(id).fields.every((f) => this.cache[f])) {
      this.repaint();
      // The close-up surface shows the layer too (natural colours for biomes).
      this.scheduleSurface(true);
    }
    void this.refresh();
  }

  descend(): void {
    this.view?.descend();
  }

  ascend(): void {
    this.view?.ascend();
  }

  setTimeOfDay(h: number): void {
    this.view?.setTimeOfDay(h);
    if (this.view) ui.view.value = this.view.status();
  }

  setTimeFlows(on: boolean): void {
    ui.timeFlows.value = on;
    this.view?.setTimeFlows(on);
  }

  async setLens(id: LensId): Promise<void> {
    ui.lens.value = id;
    if (ui.status.value !== 'ready') return;
    await this.queue(() => this.api.setLens(id));
    await this.refresh();
  }

  setExaggeration(v: number): void {
    ui.exaggeration.value = v;
    if (this.cache.elevation) this.view?.setRelief(this.cache.elevation, this.seaLevel, v);
  }

  async stepOnce(): Promise<void> {
    if (ui.status.value !== 'ready') return;
    const snap = await this.queue(() => this.api.step(1, this.want(), this.known, this.query()));
    this.apply(snap);
  }

  togglePlay(): void {
    ui.playing.value = !ui.playing.value;
    if (ui.playing.value) void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (ui.playing.value && ui.status.value === 'ready') {
        const snap = await this.queue(() => this.api.step(ui.ticksPerFrame.value, this.want(), this.known, this.query()));
        this.apply(snap);
        // Yield to rendering; the timer keeps time flowing when the page is hidden and rAF is throttled.
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          requestAnimationFrame(finish);
          setTimeout(finish, 16);
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /** A click on the view: animals and towns under the pointer first, then (optionally) the ground. */
  pick(clientX: number, clientY: number, ground = true): void {
    if (this.view?.pickObject(clientX, clientY)) return;
    if (!ground) return;
    const cell = this.view?.pickCell(clientX, clientY) ?? -1;
    this.select(cell, true);
  }

  /** Select a cell; `show` also opens its card (a user's click, not the walk-follow). */
  select(cell: number, show = false): void {
    ui.selected.value = cell;
    this.view?.setMarker(cell);
    if (cell < 0) {
      ui.cell.value = null;
      return;
    }
    if (show) this.openPanel('cell');
    void this.refresh();
  }

  /** Fly the camera to a cell. */
  focus(cell: number): void {
    this.view?.flyTo(cell);
    this.select(cell);
  }

  private openPanel(p: Panel): void {
    ui.panel.value = p;
    ui.panelOpen.value = true;
  }

  // ------------------------------------------------------------ details

  async showSpecies(id: number, observed = false): Promise<void> {
    if (observed) {
      const r = await this.queue(() => this.api.act({ kind: 'observe', species: id }));
      ui.player.value = r.player;
      toast(r.text);
    }
    const d = await this.queue(() => this.api.species(id));
    ui.species.value = d;
    ui.speciesNote.value = '';
    this.openPanel('species');
  }

  async showRange(id: number): Promise<void> {
    this.range = await this.queue(() => this.api.range(id));
    ui.rangeOf.value = id;
    this.setLayer('range');
  }

  async showTown(id: number): Promise<void> {
    const d = await this.queue(() => this.api.settlement(id));
    if (!d) return;
    ui.town.value = d;
    this.openPanel('town');
  }

  async loadTech(): Promise<void> {
    ui.tech.value = await this.queue(() => this.api.techTree());
  }

  async loadSky(): Promise<void> {
    const lon = ui.cell.value?.lonDeg ?? 0;
    ui.sky.value = await this.queue(() => this.api.sky(lon));
  }

  planSpell(nodes: SpellNode[]) {
    return this.queue(() => this.api.planSpell(nodes));
  }

  async act(action: PlayerAction): Promise<boolean> {
    const r = await this.queue(() => this.api.act(action));
    ui.player.value = r.player;
    toast(r.text, 6000);
    await this.refresh();
    return r.ok;
  }

  async loadPlayer(): Promise<void> {
    ui.player.value = await this.queue(() => this.api.player());
  }

  async loadKeyframes(): Promise<void> {
    ui.keyframes.value = await this.queue(() => this.api.keyframes());
  }

  async keyframe(label: string): Promise<void> {
    ui.keyframes.value = await this.queue(() => this.api.keyframe(label));
    toast('この時点を保存しました。');
  }

  async restore(index: number): Promise<void> {
    ui.playing.value = false;
    await this.queue(() => this.api.restore(index));
    this.known = {};
    ui.chronicle.value = [];
    this.lastSeq = -1;
    await this.refresh();
    this.scheduleSurface(true);
    toast('その時点に戻りました。ここから別の歴史が始まります。');
  }

  async scenario(kind: Scenario): Promise<void> {
    const text = await this.queue(() => this.api.scenario(kind, ui.selected.value));
    toast(text, 6000);
    await this.refresh();
    void this.loadKeyframes();
  }

  exportWorld(): Promise<string> {
    return this.queue(() => this.api.exportWorld());
  }

  worldBible(): Promise<string> {
    return this.queue(() => this.api.worldBible());
  }

  /** Current map colours (for the PNG export). */
  mapColors(): { rgb: Uint8Array; mesh: MeshPayload | null } {
    return { rgb: this.rgb, mesh: this.mesh };
  }

  // ------------------------------------------------------------ LLM

  setLlm(s: LlmSettings): void {
    ui.llm.value = s;
    saveSettings(s);
  }

  async narrate(): Promise<void> {
    const facts = ui.chronicle.value.filter((c) => c.kind !== 'sky').slice(-14).map((c) => c.text);
    if (!facts.length) return;
    ui.llmBusy.value = true;
    try {
      ui.narration.value = await chat(ui.llm.value, tasks.narrate(facts));
    } catch (e) {
      ui.narration.value = '';
      toast((e as Error).message, 9000);
    } finally {
      ui.llmBusy.value = false;
    }
  }

  async fieldNote(): Promise<void> {
    const sp = ui.species.value;
    if (!sp) return;
    ui.llmBusy.value = true;
    try {
      const facts = `${sp.name}（${sp.sci}）。${sp.description}。適温 ${sp.tempOpt.toFixed(0)}℃、推定 ${Math.round(sp.pop)} 個体。祖先: ${sp.lineage.slice(0, 3).map((l) => l.name).join(' ← ') || '不明'}。餌: ${sp.prey.join('、') || '—'}。天敵: ${sp.predators.join('、') || '—'}。${sp.domesticable ? '家畜にできる。' : ''}`;
      ui.speciesNote.value = await chat(ui.llm.value, tasks.fieldNote(facts));
    } catch (e) {
      toast((e as Error).message, 9000);
    } finally {
      ui.llmBusy.value = false;
    }
  }

  /** Context string about the world for questions and the game master. */
  worldContext(): string {
    const s = ui.summary.value;
    if (!s) return '';
    const L = [
      `主星 ${s.star.name}（${s.star.stage}）。CO2 ${s.climate.co2.toFixed(0)} ppm、気温偏差 ${s.climate.dT.toFixed(1)}℃（${s.climate.regime}）。`,
      `生命: ${s.life.stageName}、現生種 ${s.life.species}、知性種 ${s.life.sapient ?? 'なし'}。`,
      s.civ.started ? `文明: ${s.civ.eraName}時代、人口 ${Math.round(s.civ.pop)}、国 ${s.civ.polities}、戦争 ${s.civ.wars}。主な国: ${s.civ.topPolities.map((p) => `${p.name}（${p.gov}）`).join('、')}。` : '文明はまだない。',
      '最近の出来事:',
      ...ui.chronicle.value.slice(-12).map((c) => `- ${c.text}`),
    ];
    return L.join('\n');
  }

  async ask(question: string): Promise<string> {
    ui.llmBusy.value = true;
    try {
      return await chat(ui.llm.value, tasks.ask(question, this.worldContext()), { noCache: false });
    } finally {
      ui.llmBusy.value = false;
    }
  }

  // ------------------------------------------------------------ surface fauna

  /** Keep the surface view's animals in step with the species living there. */
  private async updateFauna(): Promise<void> {
    const v = this.view;
    if (!v || ui.status.value !== 'ready' || !v.wantsFauna) return;
    const cell = v.observerCell();
    const now = performance.now();
    if (cell < 0 || (cell === this.faunaCell && now - this.faunaAt < 8000)) return;
    this.faunaCell = cell;
    this.faunaAt = now;
    const list = await this.queue(() => this.api.faunaAt(cell));
    v.setFaunaSpecies(list);
  }
}

export const controller = new Controller();

// Debug handle for the browser console during development.
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__chrono = { controller, ui };
