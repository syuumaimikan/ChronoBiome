import { describe, expect, it } from 'vitest';
import { parseRulePack, type RulePack } from '../src/core/rules/schema';
import { earthLikePack } from '../src/core/rules/packs/earthLike';
import { buildGeodesic, cellCountForLevel } from '../src/core/world/geodesic';
import { degree, nearestCell } from '../src/core/world/topology';
import { hashWorld } from '../src/core/world/state';
import { Simulation } from '../src/core/sim';
import { latitudeBand } from '../src/core/systems/climate/climate';

function pack(overrides: (p: typeof earthLikePack) => void = () => {}): RulePack {
  const p = structuredClone(earthLikePack);
  overrides(p);
  const r = parseRulePack(p);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.pack;
}

describe('geodesic grid', () => {
  for (const level of [0, 2, 4]) {
    it(`level ${level} is a valid closed spherical mesh`, () => {
      const m = buildGeodesic(level);
      expect(m.count).toBe(cellCountForLevel(level));
      expect(m.faces.length / 3).toBe(20 * 4 ** level);
      let pentagons = 0;
      for (let i = 0; i < m.count; i++) {
        const d = degree(m, i);
        expect(d === 5 || d === 6).toBe(true);
        if (d === 5) pentagons++;
        // unit length
        expect(Math.hypot(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2])).toBeCloseTo(1, 5);
        // symmetric adjacency
        for (let k = m.nbrStart[i]; k < m.nbrStart[i + 1]; k++) {
          const j = m.nbr[k];
          const back = Array.from(m.nbr.subarray(m.nbrStart[j], m.nbrStart[j + 1]));
          expect(back).toContain(i);
        }
      }
      expect(pentagons).toBe(12);
      // Euler characteristic V - E + F = 2
      expect(m.count - m.nbr.length / 2 + m.faces.length / 3).toBe(2);
    });
  }

  it('orders each cell ring counter-clockwise seen from outside', () => {
    const m = buildGeodesic(3);
    for (let i = 0; i < m.count; i++) {
      const s = m.ringStart[i], e = m.ringStart[i + 1];
      const c = [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
      for (let k = s; k < e; k++) {
        const a = m.ring[k] * 3, b = m.ring[s + ((k - s + 1) % (e - s))] * 3;
        const ax = m.faceCenter[a] - c[0], ay = m.faceCenter[a + 1] - c[1], az = m.faceCenter[a + 2] - c[2];
        const bx = m.faceCenter[b] - c[0], by = m.faceCenter[b + 1] - c[1], bz = m.faceCenter[b + 2] - c[2];
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        expect(nx * c[0] + ny * c[1] + nz * c[2]).toBeGreaterThan(0);
      }
    }
  });

  it('has mean spacing that matches the cell count on Earth', () => {
    const m = buildGeodesic(6);
    expect(m.spacingKm).toBeGreaterThan(100);
    expect(m.spacingKm).toBeLessThan(130);
  });
});

describe('world generation', () => {
  const rules = pack();

  it('is deterministic for a seed and differs across seeds', () => {
    const a = new Simulation(rules, 1234);
    const b = new Simulation(rules, 1234);
    const c = new Simulation(rules, 1235);
    expect(hashWorld(a.state)).toBe(hashWorld(b.state));
    expect(hashWorld(a.state)).not.toBe(hashWorld(c.state));
    a.lens = 'present';
    b.lens = 'present';
    a.step(40);
    b.step(40);
    expect(hashWorld(a.state)).toBe(hashWorld(b.state));
  });

  it('honours the ocean fraction and assigns every cell to a plate', () => {
    const sim = new Simulation(rules, 99);
    const { elevation, plate } = sim.state.fields;
    let ocean = 0;
    for (let i = 0; i < elevation.length; i++) {
      if (elevation[i] < sim.state.seaLevel) ocean++;
      expect(plate[i]).toBeLessThan(rules.terrain.plateCount);
    }
    expect(ocean / elevation.length).toBeCloseTo(0.7, 1);
    const present = new Set(plate);
    expect(present.size).toBe(rules.terrain.plateCount);
  });

  it('assigns a biome to every cell', () => {
    const sim = new Simulation(rules, 7);
    for (const b of sim.state.fields.biome) expect(b).not.toBe(255);
  });
});

describe('first-order climate is Earth-like', () => {
  const rules = pack();
  const sim = new Simulation(rules, 2024);
  const { mesh, fields, seaLevel } = sim.state;

  it('is warmer at the equator than at the poles', () => {
    let eq = 0, eqN = 0, po = 0, poN = 0;
    for (let i = 0; i < mesh.count; i++) {
      const lat = Math.abs(mesh.lat[i]) * (180 / Math.PI);
      if (fields.elevation[i] >= seaLevel) continue;
      if (lat < 10) { eq += fields.tempMean[i]; eqN++; }
      if (lat > 75) { po += fields.tempMean[i]; poN++; }
    }
    // Over the ocean: Earth today is ≈ 28 → −2 °C. At genesis the young star is
    // fainter (≈ −4 °C globally), and the gradient stays about 30 °C.
    expect(eq / eqN - po / poN).toBeGreaterThan(28);
    expect(eq / eqN).toBeGreaterThan(po / poN + 20);
  });

  it('cools with altitude at the lapse rate', () => {
    const r2 = pack((p) => { p.climate!.lapseRateCPerKm = 0; });
    const flat = new Simulation(r2, 2024);
    let checked = 0;
    for (let i = 0; i < mesh.count && checked < 50; i++) {
      const h = fields.elevation[i] - seaLevel;
      if (h > 2000) {
        expect(flat.state.fields.tempMean[i] - fields.tempMean[i]).toBeCloseTo((6.5 * h) / 1000, 3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('has opposite seasons in the two hemispheres', () => {
    const s = new Simulation(rules, 2024);
    s.lens = 'present';
    s.step(Math.round(365 * 0.25)); // northern summer solstice
    const north = nearestCell(mesh, Math.cos(1), Math.sin(1), 0);
    const south = nearestCell(mesh, Math.cos(-1), Math.sin(-1), 0);
    const f = s.state.fields;
    expect(f.temperature[north]).toBeGreaterThan(f.tempMean[north]);
    expect(f.temperature[south]).toBeLessThan(f.tempMean[south]);
    // coarse lens shows annual means
    s.lens = 'geologic';
    s.step(1);
    expect(Array.from(f.temperature.subarray(0, 100))).toEqual(Array.from(f.tempMean.subarray(0, 100)));
  });

  it('has wet tropics, dry subtropics and wet mid-latitudes', () => {
    expect(latitudeBand(0)).toBeGreaterThan(latitudeBand(28));
    expect(latitudeBand(55)).toBeGreaterThan(latitudeBand(28));
    expect(latitudeBand(55)).toBeGreaterThan(latitudeBand(89));
  });
});

describe('performance budget', () => {
  it('runs a present-lens tick within 8 ms at grid level 6', () => {
    const sim = new Simulation(pack(), 1);
    sim.lens = 'present';
    sim.step(10); // warm up
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      sim.step(1);
      times.push(sim.lastTickMs);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(8);
  });
});
