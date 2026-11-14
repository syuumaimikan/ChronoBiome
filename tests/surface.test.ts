import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { earthLikePack } from '../src/core/rules/packs/earthLike';
import { parseRulePack } from '../src/core/rules/schema';
import { Simulation } from '../src/core/sim';
import { dirToFace, faceToDir, type FacePoint } from '../src/render/surface/cube';
import { Fauna } from '../src/render/surface/fauna';
import { resolveLooks } from '../src/render/surface/looks';
import { newSample, SurfaceSampler } from '../src/render/surface/sampler';
import { MAX_LEVEL, SurfaceTerrain } from '../src/render/surface/terrain';
import { tangentFrame } from '../src/render/surface/vegetation';

function makeWorld(seed = 4242) {
  const r = parseRulePack(structuredClone(earthLikePack));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const sim = new Simulation(r.pack, seed);
  const st = sim.state;
  const sampler = new SurfaceSampler({
    mesh: st.mesh,
    elevation: st.fields.elevation,
    biome: st.fields.biome,
    moisture: st.fields.moisture,
    tempMean: st.fields.tempMean,
    seaLevel: st.seaLevel,
    seed: st.seed,
    lapseRateCPerKm: r.pack.climate.lapseRateCPerKm,
  });
  const looks = resolveLooks(r.pack.biomes.map((b) => ({ id: b.id, name: b.name, color: b.color, surface: b.surface })));
  return { sim, sampler, looks, pack: r.pack };
}

/** A cell well inside a biome (all neighbours share it). */
function interiorCell(w: ReturnType<typeof makeWorld>, biomeIds: string[]): number {
  const { mesh, fields } = w.sim.state;
  const want = new Set(biomeIds.map((id) => w.pack.biomes.findIndex((b) => b.id === id)));
  for (let i = 0; i < mesh.count; i++) {
    if (!want.has(fields.biome[i])) continue;
    let ok = true;
    for (let k = mesh.nbrStart[i]; k < mesh.nbrStart[i + 1]; k++) if (fields.biome[mesh.nbr[k]] !== fields.biome[i]) ok = false;
    if (ok) return i;
  }
  throw new Error(`no interior cell of ${biomeIds.join('/')}`);
}

function randomDir(rnd: () => number): Float64Array {
  const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
  return new Float64Array([r * Math.cos(t), u, r * Math.sin(t)]);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

describe('cube-sphere mapping', () => {
  it('round-trips directions through face coordinates', () => {
    const rnd = lcg(7);
    const fp: FacePoint = { face: 0, u: 0, v: 0 };
    const out = new Float64Array(3);
    for (let k = 0; k < 2000; k++) {
      const d = randomDir(rnd);
      dirToFace(d[0], d[1], d[2], fp);
      expect(fp.u).toBeGreaterThanOrEqual(-1);
      expect(fp.u).toBeLessThanOrEqual(1);
      faceToDir(fp.face, fp.u, fp.v, out);
      expect(Math.hypot(out[0] - d[0], out[1] - d[1], out[2] - d[2])).toBeLessThan(1e-9);
    }
  });
});

describe('surface sampler', { timeout: 60_000 }, () => {
  const w = makeWorld();

  it('finds the same nearest cell as a brute-force search', () => {
    const { pos, count } = w.sim.state.mesh;
    const rnd = lcg(11);
    for (let k = 0; k < 200; k++) {
      const d = randomDir(rnd);
      let best = 0, bd = -2;
      for (let i = 0; i < count; i++) {
        const dot = pos[i * 3] * d[0] + pos[i * 3 + 1] * d[1] + pos[i * 3 + 2] * d[2];
        if (dot > bd) { bd = dot; best = i; }
      }
      expect(w.sampler.nearestCell(d[0], d[1], d[2])).toBe(best);
    }
  });

  it('is continuous: points a metre apart differ by a few metres at most', () => {
    const rnd = lcg(21);
    const R = w.sampler.radiusM;
    let worst = 0;
    for (let k = 0; k < 400; k++) {
      const d = randomDir(rnd);
      const a = w.sampler.heightAt(d[0], d[1], d[2], 0);
      const e = new Float64Array(3), n = new Float64Array(3);
      tangentFrame(d, e, n, rnd() * 6.28);
      const q = [d[0] + e[0] / R, d[1] + e[1] / R, d[2] + e[2] / R];
      const l = Math.hypot(q[0], q[1], q[2]);
      const b = w.sampler.heightAt(q[0] / l, q[1] / l, q[2] / l, 0);
      worst = Math.max(worst, Math.abs(a - b));
    }
    expect(worst).toBeLessThan(6);
  });

  it('is deterministic and coarse detail only drops the small wavelengths', () => {
    const again = makeWorld();
    const rnd = lcg(5);
    for (let k = 0; k < 100; k++) {
      const d = randomDir(rnd);
      const fine = w.sampler.heightAt(d[0], d[1], d[2], 0);
      expect(again.sampler.heightAt(d[0], d[1], d[2], 0)).toBe(fine);
      // Leaving out wavelengths below 2 km changes the height by at most the omitted amplitudes.
      expect(Math.abs(w.sampler.heightAt(d[0], d[1], d[2], 2000) - fine)).toBeLessThan(150);
    }
  });

  it('cools with height at the lapse rate', () => {
    const c = interiorCell(w, ['temperate_forest', 'grassland', 'taiga', 'savanna']);
    const p = w.sim.state.mesh.pos;
    const s = newSample();
    w.sampler.sample(p[c * 3], p[c * 3 + 1], p[c * 3 + 2], 0, s);
    const expected = w.sim.state.fields.tempMean[c] - ((s.height - Math.max(w.sim.state.fields.elevation[c], w.sampler.seaLevel)) * w.pack.climate.lapseRateCPerKm) / 1000;
    expect(Math.abs(s.temp - expected)).toBeLessThan(3);
  });
});

describe('close-up terrain', { timeout: 120_000 }, () => {
  const w = makeWorld();

  function standAt(cell: number): THREE.PerspectiveCamera {
    const p = w.sim.state.mesh.pos;
    const d = new Float64Array([p[cell * 3], p[cell * 3 + 1], p[cell * 3 + 2]]);
    const l = Math.hypot(d[0], d[1], d[2]);
    for (let i = 0; i < 3; i++) d[i] /= l;
    const h = Math.max(w.sampler.heightAt(d[0], d[1], d[2], 0), w.sampler.seaLevel) + 2;
    const r = w.sampler.radiusM + h;
    const cam = new THREE.PerspectiveCamera(45, 1.5, 0.1, 2e8);
    cam.position.set(d[0] * r, d[1] * r, d[2] * r);
    const e = new Float64Array(3), n = new Float64Array(3);
    tangentFrame(d, e, n, 0);
    cam.up.set(d[0], d[1], d[2]);
    cam.lookAt(cam.position.x + n[0] * 100, cam.position.y + n[1] * 100, cam.position.z + n[2] * 100);
    cam.updateMatrixWorld();
    return cam;
  }

  /** Each update reveals one more level of the quadtree; stop when nothing changes. */
  function settle(t: SurfaceTerrain, cam: THREE.Camera): void {
    let last = -1;
    for (let k = 0; k < 60; k++) {
      t.update(cam, 1e9);
      const sig = t.stats.chunks * 1000 + t.stats.visible;
      if (t.stats.pending === 0 && sig === last) break;
      last = sig;
    }
  }

  function census(t: SurfaceTerrain) {
    let trees = 0, grass = 0;
    for (const g of t.group.children) {
      if (!g.visible) continue;
      const [, , plants, grassMesh] = g.children as THREE.Mesh[];
      if (plants.geometry) trees += plants.geometry.getAttribute('position').count;
      if (grassMesh.geometry && grassMesh.visible) grass += grassMesh.geometry.getAttribute('position').count;
    }
    return { maxLevel: t.stats.maxLevel, trees, grass, visible: t.stats.visible };
  }

  it('refines to metre-scale chunks under the player and grows a forest there', () => {
    const cell = interiorCell(w, ['temperate_forest', 'taiga', 'tropical_rainforest', 'temperate_rainforest']);
    const t = new SurfaceTerrain();
    t.setData(w.sampler, w.looks, w.sim.state.seed, null);
    const cam = standAt(cell);
    settle(t, cam);
    const c = census(t);
    expect(t.stats.pending).toBe(0);
    expect(c.maxLevel).toBeGreaterThanOrEqual(MAX_LEVEL - 1);
    expect(c.trees).toBeGreaterThan(5000);
    expect(c.grass).toBeGreaterThan(0);
    // Light: a bounded number of chunks even at ground level.
    expect(c.visible).toBeLessThan(600);

    // The same world and camera give exactly the same vegetation.
    const t2 = new SurfaceTerrain();
    t2.setData(w.sampler, w.looks, w.sim.state.seed, null);
    settle(t2, cam);
    expect(census(t2)).toEqual(c);
    t.dispose();
    t2.dispose();
  });

  it('spawns the same herds at the same place', () => {
    const cell = interiorCell(w, ['savanna', 'grassland', 'temperate_forest', 'taiga']);
    const p = w.sim.state.mesh.pos;
    const d = new Float64Array([p[cell * 3], p[cell * 3 + 1], p[cell * 3 + 2]]);
    const l = Math.hypot(d[0], d[1], d[2]);
    for (let i = 0; i < 3; i++) d[i] /= l;
    const h = w.sampler.heightAt(d[0], d[1], d[2], 0);
    const counts: number[] = [];
    for (let run = 0; run < 2; run++) {
      const f = new Fauna();
      f.setWorld(w.sampler, w.looks, w.sim.state.seed);
      f.update(0.016, 0, d, h, true);
      counts.push(f.count);
      f.dispose();
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
  });
});
