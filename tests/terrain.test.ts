import { describe, expect, it } from 'vitest';
import { parseRulePack, type RulePack } from '../src/core/rules/schema';
import { earthLikePack } from '../src/core/rules/packs/earthLike';
import { Simulation } from '../src/core/sim';
import { hashWorld, livePlateCount } from '../src/core/world/state';
import { baseElevation, CONTINENTAL_KM, oceanVolume } from '../src/core/systems/terrain/isostasy';
import { ErosionScratch, routeDrainage } from '../src/core/systems/terrain/erosion';

function pack(overrides: (p: typeof earthLikePack) => void = () => {}): RulePack {
  const p = structuredClone(earthLikePack);
  overrides(p);
  const r = parseRulePack(p);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.pack;
}

function shares(sim: Simulation) {
  const { fields, seaLevel, mesh } = sim.state;
  let land = 0, cont = 0;
  for (let i = 0; i < mesh.count; i++) {
    if (fields.elevation[i] >= seaLevel) land++;
    if (fields.crustThickness[i] >= CONTINENTAL_KM) cont++;
  }
  return { land: land / mesh.count, cont: cont / mesh.count };
}

describe('isostasy', () => {
  it('puts ridges, abyssal plains and continents at Earth-like depths', () => {
    expect(baseElevation(7, 0)).toBeCloseTo(-2600, -1);
    expect(baseElevation(7, 100)).toBeLessThan(-5500);
    expect(baseElevation(7, 100)).toBeGreaterThan(-6500);
    expect(baseElevation(30, 2000)).toBeGreaterThan(500);
    expect(baseElevation(30, 2000)).toBeLessThan(1200);
    // thermal subsidence stops after ~100 Myr
    expect(baseElevation(7, 300)).toBe(baseElevation(7, 100));
  });
});

describe('plate tectonics over deep time', { timeout: 120_000 }, () => {
  const rules = pack();
  const sim = new Simulation(rules, 4242);
  const before = shares(sim);
  const plateBefore = sim.state.fields.plate.slice();
  sim.step(300); // 300 Myr at the geologic lens

  it('moves plates', () => {
    let changed = 0;
    const plate = sim.state.fields.plate;
    for (let i = 0; i < plate.length; i++) if (plate[i] !== plateBefore[i]) changed++;
    expect(changed / plate.length).toBeGreaterThan(0.2);
    expect(sim.terrain.totals.moves).toBeGreaterThan(100);
    expect(livePlateCount(sim.state)).toBeGreaterThanOrEqual(2);
  });

  it('conserves ocean water through sea-level changes', () => {
    const { fields, seaLevel, waterVolume } = sim.state;
    expect(oceanVolume(fields.elevation, seaLevel) / waterVolume).toBeCloseTo(1, 3);
    expect(Math.abs(seaLevel)).toBeLessThan(1500);
  });

  it('keeps continents and a plausible land share', () => {
    const after = shares(sim);
    expect(after.cont).toBeGreaterThan(before.cont * 0.5);
    expect(after.cont).toBeLessThan(before.cont * 1.8);
    expect(after.land).toBeGreaterThan(0.1);
    expect(after.land).toBeLessThan(0.6);
  });

  it('keeps every value finite and within physical bounds', () => {
    const f = sim.state.fields;
    for (let i = 0; i < f.elevation.length; i++) {
      expect(Number.isFinite(f.elevation[i])).toBe(true);
      expect(f.crustThickness[i]).toBeGreaterThan(0);
      expect(f.crustThickness[i]).toBeLessThanOrEqual(rules.tectonics.maxCrustKm + 1e-3);
    }
    let maxH = -Infinity;
    for (const e of f.elevation) maxH = Math.max(maxH, e - sim.state.seaLevel);
    expect(maxH).toBeLessThan(9500);
    expect(maxH).toBeGreaterThan(1500);
  });

  it('makes young sea floor at ridges shallower than old abyssal plains', () => {
    const f = sim.state.fields;
    let young = 0, youngN = 0, old = 0, oldN = 0;
    for (let i = 0; i < f.elevation.length; i++) {
      if (f.crustThickness[i] >= 12) continue;
      if (f.crustAge[i] < 10) { young += f.elevation[i]; youngN++; }
      if (f.crustAge[i] > 80) { old += f.elevation[i]; oldN++; }
    }
    expect(youngN).toBeGreaterThan(50);
    expect(oldN).toBeGreaterThan(50);
    expect(young / youngN - old / oldN).toBeGreaterThan(1500);
  });

  it('drains every land cell to the sea', () => {
    const s = new ErosionScratch(sim.state.mesh.count);
    routeDrainage(sim.state, s);
    const { elevation } = sim.state.fields;
    const sea = sim.state.seaLevel;
    for (let k = 0; k < s.count; k++) {
      let c = s.order[k];
      let steps = 0;
      while (elevation[c] >= sea && steps++ < sim.state.mesh.count) c = s.recv[c];
      expect(elevation[c]).toBeLessThan(sea);
    }
  });
});

describe('erosion without tectonics', () => {
  it('wears mountains down over tens of millions of years', { timeout: 60_000 }, () => {
    const sim = new Simulation(pack(), 77);
    sim.step(60); // build mountain belts with moving plates
    // Then stop all tectonic forcing.
    sim.state.plates.omega.fill(0);
    sim.state.plates.drive.fill(0);
    sim.state.hotspots = new Int32Array(0);
    sim.rules.tectonics.riftEveryMyr = 1e12;
    sim.rules.tectonics.reorganizeEveryMyr = 1e12;
    const highest = () => {
      const e = sim.state.fields.elevation;
      const sorted = Array.from(e).sort((a, b) => b - a);
      return sorted.slice(0, 50).reduce((a, b) => a + b, 0) / 50 - sim.state.seaLevel;
    };
    const h0 = highest();
    sim.step(60);
    const h1 = highest();
    expect(h1).toBeLessThan(h0 * 0.95);
    expect(h1).toBeGreaterThan(h0 * 0.2);
  });
});

describe('determinism with tectonics', () => {
  it('reproduces the same world after geologic ticks', { timeout: 60_000 }, () => {
    const rules = pack();
    const a = new Simulation(rules, 9);
    const b = new Simulation(rules, 9);
    a.step(25);
    b.step(25);
    expect(hashWorld(a.state)).toBe(hashWorld(b.state));
  });
});

describe('geologic performance budget', () => {
  it('runs a geologic-lens tick within 40 ms at grid level 6', { timeout: 60_000 }, () => {
    const sim = new Simulation(pack(), 3);
    sim.step(3);
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      sim.step(1);
      times.push(sim.lastTickMs);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(40);
  });
});
