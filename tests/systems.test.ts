import { describe, expect, it } from 'vitest';
import { cartridgeRuntime } from '../src/export/cartridgeRuntime';
import { buildCartridge, mapPixels, nearestCell } from '../src/export/files';
import { act, injectScenario, playerSummary } from '../src/core/play/actions';
import { SCENARIOS } from '../src/core/play/scenarios';
import { arcanePack } from '../src/core/rules/packs/arcane';
import { earthLikePack } from '../src/core/rules/packs/earthLike';
import { parseRulePack, type RulePackInput } from '../src/core/rules/schema';
import { getMesh, Simulation } from '../src/core/sim';
import { aspects, birthChart, ephemeris, moonPhase, skyEvents, solsticeSunriseAzimuth } from '../src/core/systems/astrology/astrology';
import { checkRoutine, planSpell, runRoutine, type SpellNode } from '../src/core/systems/magic/spell';
import { BUILDINGS, TECHS } from '../src/core/systems/society/data';
import { generateSystem } from '../src/core/universe/system';
import { DEFAULT_SETTINGS } from '../src/llm/llm';

function sim(pack: RulePackInput, seed = 11): Simulation {
  const r = parseRulePack(structuredClone(pack));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return new Simulation(r.pack, seed);
}

const ELEMENTS = ['火', '水', '地', '風', '生命', '精神', '時空'];
const CTX = { skill: 0.5, potency: 1, elements: ELEMENTS };
const rain = (amount: number, shape: 'touch' | 'area' | 'ward' | 'ritual' = 'area'): SpellNode[] => [
  { k: 'source', what: 'ambient' }, { k: 'element', el: '水' }, { k: 'form', shape }, { k: 'target', what: 'cell' },
  { k: 'effect', op: 'raise', field: 'moisture', amount },
];

describe('spells', () => {
  it('accepts a well-formed spell and describes it', () => {
    const p = planSpell(rain(0.3), CTX);
    expect(p.errors).toEqual([]);
    expect(p.ok).toBe(true);
    expect(p.cost).toBeGreaterThan(0);
    expect(p.summary).toContain('湿り気');
  });

  it('rejects parts that do not connect', () => {
    // Fire cannot change a population's density; a settlement has no elevation.
    const bad: SpellNode[] = [{ k: 'source', what: 'ambient' }, { k: 'element', el: '火' }, { k: 'form', shape: 'bolt' }, { k: 'target', what: 'population' }, { k: 'effect', op: 'raise', field: 'density', amount: 1 }];
    expect(planSpell(bad, CTX).ok).toBe(false);
    expect(planSpell(rain(0.3).slice(1), CTX).errors.join()).toContain('源');
    expect(planSpell([...rain(0.3).slice(2), ...rain(0.3).slice(0, 2)], CTX).ok).toBe(false);
    expect(planSpell([{ k: 'source', what: 'ambient' }, { k: 'element', el: '雷' }, ...rain(0.3).slice(2)], CTX).errors.join()).toContain('雷');
    expect(planSpell([...rain(0.3), { k: 'act', what: 'mine' }], CTX).ok).toBe(false);
  });

  it('costs more for bigger, wider and longer effects', () => {
    const c = (n: SpellNode[]) => planSpell(n, CTX).cost;
    expect(c(rain(0.6))).toBeGreaterThan(c(rain(0.3)));
    expect(c(rain(0.3, 'ritual'))).toBeGreaterThan(c(rain(0.3, 'area')));
    expect(c(rain(0.3, 'area'))).toBeGreaterThan(c(rain(0.3, 'touch')));
    expect(c([...rain(0.3), { k: 'mod', m: 'amplify', x: 1 }])).toBeGreaterThan(c(rain(0.3)));
    // Waiting for the full moon makes a spell cheaper.
    expect(c([...rain(0.3), { k: 'cond', when: 'fullmoon' }])).toBeLessThan(c(rain(0.3)));
  });

  it('is less stable when complex and in unskilled hands', () => {
    const big: SpellNode[] = [...rain(0.3, 'ritual'), { k: 'mod', m: 'amplify', x: 2 }, { k: 'mod', m: 'chain', x: 2 }];
    expect(planSpell(big, CTX).stability).toBeLessThan(planSpell(rain(0.3), CTX).stability);
    expect(planSpell(rain(0.3), { ...CTX, skill: 0.05 }).stability).toBeLessThan(planSpell(rain(0.3), { ...CTX, skill: 0.9 }).stability);
  });

  it('runs golem routines within the step limit', () => {
    const r: SpellNode[] = [{ k: 'sense', what: 'enemy', above: true, value: 0.5 }, { k: 'act', what: 'guard' }, { k: 'act', what: 'farm' }];
    expect(checkRoutine(r)).toEqual([]);
    expect(runRoutine(r, () => 1).act).toBe('guard');
    expect(runRoutine(r, () => 0).act).toBe('farm');
    const long: SpellNode[] = Array.from({ length: 500 }, () => ({ k: 'sense', what: 'ore', above: true, value: 0 }) as SpellNode);
    expect(runRoutine(long, () => 1).steps).toBeLessThanOrEqual(65);
    expect(checkRoutine(long).length).toBeGreaterThan(0);
  });
});

describe('sky and orbits', () => {
  const sys = generateSystem(1234);

  it('follows Kepler’s third law', () => {
    for (const b of sys.bodies.filter((x) => x.parent < 0)) {
      expect(b.orbit.period).toBeCloseTo(Math.pow(b.orbit.a, 1.5) / Math.sqrt(sys.starMass), 6);
    }
  });

  it('gives the same chart for the same moment and place', () => {
    const a = birthChart(sys, 1234.567, 30, []);
    const b = birthChart(sys, 1234.567, 30, []);
    expect(a).toEqual(b);
    expect(a.sun).toBeGreaterThanOrEqual(0);
    expect(a.sun).toBeLessThan(12);
  });

  it('cycles the moon and finds events in time order', () => {
    const ph = Array.from({ length: 60 }, (_, i) => moonPhase(sys, 100 + i / 365));
    for (const p of ph) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
    // Within two months the moon goes through every phase.
    expect(Math.max(...ph) - Math.min(...ph)).toBeGreaterThan(0.8);
    const ev = skyEvents(sys, 1234, 100, 101.5, 30);
    for (let i = 1; i < ev.length; i++) expect(ev[i].time).toBeGreaterThanOrEqual(ev[i - 1].time);
    for (const e of ev) {
      expect(e.time).toBeGreaterThanOrEqual(100);
      expect(e.time).toBeLessThan(101.5);
    }
  });

  it('finds aspects between real bodies only', () => {
    const eph = ephemeris(sys, 500);
    const ids = new Set(eph.map((b) => b.id));
    for (const a of aspects(eph, 6)) {
      expect(ids.has(a.a)).toBe(true);
      expect(ids.has(a.b)).toBe(true);
      expect(a.off).toBeLessThanOrEqual(6);
    }
  });

  it('puts the solstice sunrise further north at higher latitude', () => {
    expect(solsticeSunriseAzimuth(0, 23.44)).toBeCloseTo(66.56, 1);
    expect(solsticeSunriseAzimuth((51 * Math.PI) / 180, 23.44)).toBeLessThan(solsticeSunriseAzimuth(0, 23.44));
    expect(Number.isNaN(solsticeSunriseAzimuth((80 * Math.PI) / 180, 23.44))).toBe(true);
  });
});

describe('magic as a law of nature', () => {
  it('leaves no magic state in the Earth-like pack', () => {
    const s = sim(earthLikePack);
    s.step(30);
    expect(s.state.fields.mana.every((v) => v === 0)).toBe(true);
    expect(TECHS.some((t) => t.magic)).toBe(true);
    expect(act(s, { kind: 'cast', nodes: rain(0.3), cell: 10 }).ok).toBe(false);
  });

  it('wells mana up from genesis in the Arcane pack, finite and positive', () => {
    const s = sim(arcanePack);
    s.step(30);
    const m = s.state.fields.mana;
    let sum = 0;
    for (const v of m) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      sum += v;
    }
    expect(sum).toBeGreaterThan(0);
    // Deep-time steps land on the equilibrium instead of piling up.
    const max = Math.max(...m);
    s.step(30);
    expect(Math.max(...s.state.fields.mana)).toBeLessThan(max * 3 + 1);
  });

  it('lets a god cast a spell where mana flows', () => {
    const s = sim(arcanePack);
    s.step(30);
    const m = s.state.fields.mana;
    let cell = 0;
    for (let c = 0; c < m.length; c++) if (m[c] > m[cell]) cell = c;
    const before = m[cell];
    const r = act(s, { kind: 'cast', nodes: rain(0.05, 'touch'), cell });
    expect(r.text.length).toBeGreaterThan(0);
    if (r.ok) expect(s.state.fields.mana[cell]).toBeLessThan(before);
  });
});

describe('scenarios and play before civilisation', () => {
  it('injects every scenario without breaking the world', () => {
    for (const sc of SCENARIOS) {
      const s = sim(earthLikePack, 5);
      s.step(5);
      const text = injectScenario(s, sc.id, 100);
      expect(text.length).toBeGreaterThan(0);
      s.step(3);
      expect(Number.isFinite(s.state.climate.meanAnomaly)).toBe(true);
    }
  });

  it('refuses to incarnate with no towns, and reports a player', () => {
    const s = sim(earthLikePack);
    expect(act(s, { kind: 'incarnate', role: 'merchant' }).ok).toBe(false);
    expect(act(s, { kind: 'excavate', cell: 0 }).ok).toBe(false);
    const p = playerSummary(s);
    expect(p === null || p.alive === false).toBe(true);
  });

  it('keeps building and technology data consistent', () => {
    const ids = new Set(TECHS.map((t) => t.id));
    for (const t of TECHS) for (const r of t.req) expect(ids.has(r)).toBe(true);
    for (const t of TECHS) for (const r of t.req) expect(TECHS.find((x) => x.id === r)!.era).toBeLessThanOrEqual(t.era);
    for (const b of BUILDINGS) if (b.tech) expect(ids.has(b.tech)).toBe(true);
  });
});

describe('exports', () => {
  const mesh = getMesh(4, 6371);

  it('walks to the true nearest cell', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let k = 0; k < 200; k++) {
      const z = 2 * rnd() - 1, phi = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
      const x = r * Math.cos(phi), y = r * Math.sin(phi);
      let bd = -2;
      for (let c = 0; c < mesh.count; c++) bd = Math.max(bd, mesh.pos[c * 3] * x + mesh.pos[c * 3 + 1] * y + mesh.pos[c * 3 + 2] * z);
      const got = nearestCell(mesh, x, y, z, Math.floor(rnd() * mesh.count));
      const gd = mesh.pos[got * 3] * x + mesh.pos[got * 3 + 1] * y + mesh.pos[got * 3 + 2] * z;
      expect(gd).toBeCloseTo(bd, 6);
    }
  });

  it('rasterises cell colours onto an equirectangular map', () => {
    const rgb = new Uint8Array(mesh.count * 3);
    for (let c = 0; c < mesh.count; c++) rgb[c * 3] = mesh.lat[c] > 0 ? 255 : 0;
    const px = mapPixels(rgb, mesh, 64);
    expect(px.length).toBe(64 * 32 * 4);
    // Top row is the north (red), bottom row the south (black).
    expect(px[0]).toBe(255);
    expect(px[(31 * 64) * 4]).toBe(0);
    expect(px[3]).toBe(255);
  });

  it('builds a self-contained cartridge whose data survives the trip', () => {
    const world = {
      seed: 42, time: 4.5e9, star: { name: 'テスト星' },
      settlements: [{ id: 1, name: '</script><b>町', lat: 10, lon: 20, pop: 5000, polity: '国', era: '鉄器', prices: { food: 1 }, buildings: [], founded: 0 }],
      species: [], ruins: [{ name: '遺跡', cell: 3, time: 1, era: '青銅器', polity: '古国', guardian: '' }], polities: [], religions: [], chronicle: [], artifacts: [], persons: [], spells: [],
    };
    const html = buildCartridge(world, mesh, null, DEFAULT_SETTINGS);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Only the real closing tags remain: data cannot end a script early.
    const scripts = html.match(/<script[^>]*>/g)!.length;
    expect(html.split('</script>').length - 1).toBe(scripts);
    const json = html.match(/<script type="application\/json" id="world">([\s\S]*?)<\/script>/)![1];
    const back = JSON.parse(json);
    expect(back.settlements[0].name).toBe('</script><b>町');
    expect(typeof back.ruins[0].lat).toBe('number');
    expect(back.goods.length).toBeGreaterThan(5);
    // The runtime is self-contained source that parses on its own.
    expect(() => new Function(`(${cartridgeRuntime.toString()})`)).not.toThrow();
    expect(html).not.toMatch(/\bimport\s|\brequire\(/);
  });
});
