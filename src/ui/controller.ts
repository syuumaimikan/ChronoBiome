import { signal } from '@preact/signals';
import { wrap, type Remote } from 'comlink';
import type { LensId } from '../core/lens';
import { earthLikePack } from '../core/rules/packs/earthLike';
import { parseRulePackText } from '../core/rules/schema';
import type { FieldName, WorldFields } from '../core/world/state';
import type { ExploreMode } from '../render/explorer';
import { layerById, type LayerId } from '../render/layers';
import { PlanetView, type ViewStatus } from '../render/planetView';
import { resolveLooks, type BiomeLook } from '../render/surface/looks';
import { SurfaceSampler } from '../render/surface/sampler';
import type { CellInfo, FieldVersions, InitResult, MeshPayload, SimApi, Snapshot, WorldInfo } from '../worker/protocol';

/** Fields the close-up surface is built from. */
const SURFACE_FIELDS: FieldName[] = ['elevation', 'biome', 'moisture', 'tempMean'];
/** While time runs, rebuild the surface at most this often (ms). */
const SURFACE_REBUILD_MS = 2500;

/** UI state, shared by all components. */
export const ui = {
  packText: signal(JSON.stringify(earthLikePack, null, 2)),
  packErrors: signal<string[]>([]),
  seed: signal('Gaia'),
  layer: signal<LayerId>('biome'),
  lens: signal<LensId>('geologic'),
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
};

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

  constructor() {
    const worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
    this.api = wrap<SimApi>(worker);
    setInterval(() => {
      if (this.view) ui.fps.value = Math.round(this.view.fps);
    }, 1000);
    setInterval(() => {
      if (!this.view || ui.tab.value !== 'observe') return;
      ui.view.value = this.view.status();
    }, 250);
    // While walking, the inspector follows the ground under the player.
    setInterval(() => {
      if (!this.view || ui.mode.value !== 'walk' || ui.status.value !== 'ready') return;
      const cell = this.view.observerCell();
      if (cell >= 0 && cell !== ui.selected.value) this.select(cell);
    }, 1000);
  }

  get fields(): Partial<WorldFields> {
    return this.cache;
  }

  attach(canvas: HTMLCanvasElement): void {
    if (this.view) return;
    this.view = new PlanetView(canvas);
    this.view.onMode = (m) => (ui.mode.value = m);
    void this.generate();
  }

  get planet(): PlanetView | null {
    return this.view;
  }

  private want(): FieldName[] {
    return [...new Set<FieldName>([...SURFACE_FIELDS, ...layerById(ui.layer.value).fields])];
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
    this.view.setSurface(sampler, this.looks, world.seed, natural ? null : this.rgb.slice());
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
    if (surface || seaChanged || (repaint && ui.layer.value !== 'biome')) this.scheduleSurface(forcePaint || !this.view?.hasSurface);
    this.view?.setSubsolarLatitude(s.subsolarLat);
    ui.time.value = s.time;
    ui.tick.value = s.tick;
    ui.dtYears.value = s.dtYears;
    ui.tickMs.value = s.tickMs;
    ui.plateCount.value = s.plateCount;
    ui.landShare.value = s.landShare;
    ui.seaLevel.value = s.seaLevel;
    if (s.cell) ui.cell.value = s.cell;
  }

  private repaint(): void {
    const world = ui.world.value;
    const layer = layerById(ui.layer.value);
    if (!world || !this.view || layer.fields.some((f) => !this.cache[f])) return;
    layer.paint(this.rgb, this.cache, world, this.seaLevel);
    this.view.setCellColors(this.rgb);
    ui.paintVersion.value++;
  }

  private inspectArg(): number | undefined {
    return ui.selected.value >= 0 ? ui.selected.value : undefined;
  }

  async refresh(): Promise<void> {
    if (ui.status.value !== 'ready') return;
    const snap = await this.queue(() => this.api.snapshot(this.want(), this.known, this.inspectArg()));
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
    const snap = await this.queue(() => this.api.step(1, this.want(), this.known, this.inspectArg()));
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
        const snap = await this.queue(() => this.api.step(ui.ticksPerFrame.value, this.want(), this.known, this.inspectArg()));
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

  pick(clientX: number, clientY: number): void {
    const cell = this.view?.pickCell(clientX, clientY) ?? -1;
    this.select(cell);
  }

  select(cell: number): void {
    ui.selected.value = cell;
    this.view?.setMarker(cell);
    if (cell < 0) {
      ui.cell.value = null;
      return;
    }
    void this.refresh();
  }
}

export const controller = new Controller();

// Debug handle for the browser console during development.
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__chrono = { controller, ui };
