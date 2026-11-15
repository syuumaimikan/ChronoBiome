import * as THREE from 'three';
import type { SpeciesBrief } from '../../worker/protocol';
import { dirToFace, faceToDir, type FacePoint } from './cube';
import { MeshBuilder, mulberry, shade, type RGB, type Template } from './models';
import { newSample, type SurfaceSampler } from './sampler';
import { tangentFrame } from './vegetation';

/**
 * Animals around the observer, drawn from the simulated species that live in
 * the region (the worker sends them, densest first). A species' body plan,
 * size, coat and horns come from its traits, so the same species looks the
 * same wherever it is met and its descendants look related. Herds are spawned
 * per ~300 m tile from a hash and the species' density, so walking back to a
 * place finds the same herd there. Legs and wings are animated on the GPU;
 * behaviour (graze, wander, flee from the player, circle in the sky) runs on
 * the CPU. Before animals evolved the land is empty.
 */

type Plan = 'grazer' | 'heavy' | 'small' | 'predator' | 'bird';

const TILE_N = 2 ** 15;
const SPAWN_RADIUS = 650;
const DESPAWN_MS = 2500;
const MAX_ANIMALS = 240;
const CAPACITY = 64;

interface Behaviour {
  walk: number;
  run: number;
  fear: number;
  herd: [number, number];
  roam: number;
  stride: number;
  flying: boolean;
  /** Body length (m) of the template at scale 1, and the mass it stands for. */
  refKg: number;
  /** Most animals of this plan per km² that are drawn (real densities can be far higher). */
  maxPerKm2: number;
}

const PLANS: Record<Plan, Behaviour> = {
  grazer: { walk: 1.4, run: 10, fear: 32, herd: [3, 11], roam: 40, stride: 1.5, flying: false, refKg: 70, maxPerKm2: 30 },
  heavy: { walk: 1.1, run: 5.5, fear: 18, herd: [2, 6], roam: 50, stride: 2.4, flying: false, refKg: 900, maxPerKm2: 6 },
  small: { walk: 0.9, run: 6, fear: 11, herd: [1, 3], roam: 15, stride: 0.5, flying: false, refKg: 3, maxPerKm2: 40 },
  predator: { walk: 1.8, run: 9, fear: 0, herd: [1, 2], roam: 130, stride: 1.3, flying: false, refKg: 40, maxPerKm2: 3 },
  bird: { walk: 9, run: 14, fear: 0, herd: [4, 12], roam: 90, stride: 3, flying: true, refKg: 1, maxPerKm2: 25 },
};

interface Kind {
  id: number;
  plan: Plan;
  mesh: THREE.InstancedMesh;
  gait: THREE.InstancedBufferAttribute;
  members: Animal[];
  size: number;
}

interface Animal {
  sp: Kind;
  dir: Float64Array;
  home: Float64Array;
  heading: number;
  want: number;
  speed: number;
  state: 0 | 1 | 2;
  timer: number;
  phase: number;
  graze: number;
  tile: number;
  rnd: () => number;
  /** Birds: circle angle, radius, height above ground. */
  orbit: number;
  orbitR: number;
  orbitH: number;
  height: number;
}

interface Tile {
  key: number;
  animals: Animal[];
  seen: number;
}

export class Fauna {
  readonly group = new THREE.Group();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly kinds = new Map<number, Kind>();
  private readonly tiles = new Map<number, Tile>();
  private readonly uniforms = { uTime: { value: 0 } };
  private sampler: SurfaceSampler | null = null;
  private seed = 0;
  private list: SpeciesBrief[] = [];
  private listKey = '';
  private readonly anchor = new THREE.Vector3();
  private anchorSet = false;
  private lastScan = -1e9;
  private readonly fp: FacePoint = { face: 0, u: 0, v: 0 };
  private readonly tmp = new Float64Array(3);
  private readonly e = new Float64Array(3);
  private readonly n = new Float64Array(3);
  private readonly m = new THREE.Matrix4();
  private readonly s = newSample();
  private readonly v = new THREE.Vector3();
  count = 0;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute vec3 aPivot;\nattribute vec3 aGait;\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float ph = aGait.x;
          float amp = aGait.y;
          vec3 p = transformed - aPivot;
          if (aPart > 0.5 && aPart < 4.5) {
            float off = (aPart < 1.5 || aPart > 3.5) ? 0.0 : 3.14159;
            float a = amp * sin(ph + off);
            float c = cos(a), s = sin(a);
            transformed = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c) + aPivot;
          } else if (aPart > 4.5 && aPart < 6.5) {
            float a = amp * sin(ph) * (aPart < 5.5 ? 1.0 : -1.0);
            float c = cos(a), s = sin(a);
            transformed = vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z) + aPivot;
          } else if (aPart > 6.5) {
            float a = aGait.z * (0.55 + 0.15 * sin(uTime * 0.8 + ph)) + 0.05 * amp * sin(ph * 2.0);
            float c = cos(a), s = sin(a);
            transformed = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c) + aPivot;
          }
        }`);
    };
    this.group.frustumCulled = false;
  }

  setWorld(sampler: SurfaceSampler, seed: number): void {
    const same = this.seed === seed;
    this.sampler = sampler;
    if (!same) this.clear();
    this.seed = seed;
  }

  /** Species living around the observer (from the simulation). */
  setSpecies(list: SpeciesBrief[]): void {
    const visible = list.filter((s) => s.habitat === 0 && !s.sapient && s.plan !== 'aquatic' && s.massKg >= 0.05 && s.density > 0);
    const key = visible.map((s) => s.id).join(',');
    this.list = visible;
    if (key === this.listKey) return;
    this.listKey = key;
    // Respawn herds so newly arrived species appear and vanished ones leave.
    for (const t of this.tiles.values()) for (const a of t.animals) this.removeAnimal(a);
    this.tiles.clear();
    const keep = new Set(visible.map((s) => s.id));
    for (const [id, k] of this.kinds) {
      if (keep.has(id)) continue;
      this.group.remove(k.mesh);
      k.mesh.geometry.dispose();
      this.kinds.delete(id);
    }
  }

  clear(): void {
    for (const t of this.tiles.values()) for (const a of t.animals) this.removeAnimal(a);
    this.tiles.clear();
    for (const sp of this.kinds.values()) {
      this.group.remove(sp.mesh);
      sp.mesh.geometry.dispose();
    }
    this.kinds.clear();
    this.list = [];
    this.listKey = '';
    this.count = 0;
  }

  /**
   * Species of the animal nearest to a screen point (within `maxPx` pixels), or -1.
   * Animals are small: picking by screen distance is far more forgiving than a ray.
   */
  pick(camera: THREE.Camera, ndcX: number, ndcY: number, width: number, height: number, maxPx = 28): number {
    if (!this.group.visible) return -1;
    let best = -1;
    let bestD = maxPx;
    const R = this.sampler?.radiusM ?? 0;
    for (const sp of this.kinds.values()) {
      for (const a of sp.members) {
        const r = R + a.height + sp.size * 0.5;
        this.v.set(a.dir[0] * r, a.dir[1] * r, a.dir[2] * r).project(camera);
        if (this.v.z > 1 || this.v.z < -1) continue;
        const dx = ((this.v.x - ndcX) * width) / 2;
        const dy = ((this.v.y - ndcY) * height) / 2;
        const d = Math.hypot(dx, dy);
        if (d < bestD) {
          bestD = d;
          best = sp.id;
        }
      }
    }
    return best;
  }

  /** Advance animals; `observer` is the player (or camera focus) direction and height. */
  update(dt: number, timeS: number, observer: Float64Array, observerHeight: number, active: boolean): void {
    this.uniforms.uTime.value = timeS;
    this.group.visible = active;
    if (!active || !this.sampler) return;
    const S = this.sampler;
    const R = S.radiusM;
    const ox = observer[0] * (R + observerHeight), oy = observer[1] * (R + observerHeight), oz = observer[2] * (R + observerHeight);
    if (!this.anchorSet || this.anchor.distanceTo(this.v.set(ox, oy, oz)) > 1500) {
      this.anchor.set(ox, oy, oz);
      this.anchorSet = true;
      for (const sp of this.kinds.values()) sp.mesh.position.copy(this.anchor);
    }
    const now = performance.now();
    if (now - this.lastScan > 400) {
      this.lastScan = now;
      this.scanTiles(observer, now);
    }
    dt = Math.min(dt, 0.1);
    for (const sp of this.kinds.values()) {
      const g = sp.gait.array as Float32Array;
      for (let k = 0; k < sp.members.length; k++) {
        const a = sp.members[k];
        this.think(a, dt, observer, R);
        this.writeMatrix(sp, k, a, R);
        g[k * 3] = a.phase;
        g[k * 3 + 1] = a.sp.plan === 'bird' ? (a.state === 2 ? 0.9 : 0.55 + 0.35 * Math.max(0, Math.sin(timeS * 0.4 + a.orbit))) : Math.min(0.75, a.speed > 0.05 ? 0.3 + a.speed * 0.05 : 0);
        g[k * 3 + 2] = a.graze;
      }
      sp.mesh.count = sp.members.length;
      sp.mesh.instanceMatrix.needsUpdate = true;
      sp.gait.needsUpdate = true;
    }
  }

  private scanTiles(observer: Float64Array, now: number): void {
    const S = this.sampler!;
    const R = S.radiusM;
    tangentFrame(observer, this.e, this.n, 0);
    const step = 150;
    for (let dy = -SPAWN_RADIUS; dy <= SPAWN_RADIUS; dy += step) {
      for (let dx = -SPAWN_RADIUS; dx <= SPAWN_RADIUS; dx += step) {
        if (dx * dx + dy * dy > SPAWN_RADIUS * SPAWN_RADIUS) continue;
        const x = observer[0] + (this.e[0] * dx + this.n[0] * dy) / R;
        const y = observer[1] + (this.e[1] * dx + this.n[1] * dy) / R;
        const z = observer[2] + (this.e[2] * dx + this.n[2] * dy) / R;
        dirToFace(x, y, z, this.fp);
        const tu = Math.min(TILE_N - 1, Math.floor(((this.fp.u + 1) / 2) * TILE_N));
        const tv = Math.min(TILE_N - 1, Math.floor(((this.fp.v + 1) / 2) * TILE_N));
        const key = (this.fp.face * TILE_N + tu) * TILE_N + tv;
        let t = this.tiles.get(key);
        if (!t) {
          t = { key, animals: [], seen: now };
          this.tiles.set(key, t);
          this.spawnTile(t, this.fp.face, tu, tv);
        }
        t.seen = now;
      }
    }
    for (const [key, t] of this.tiles) {
      if (now - t.seen > DESPAWN_MS) {
        for (const a of t.animals) this.removeAnimal(a);
        this.tiles.delete(key);
      }
    }
  }

  private spawnTile(t: Tile, face: number, tu: number, tv: number): void {
    if (!this.list.length) return;
    const S = this.sampler!;
    const d = this.tmp;
    faceToDir(face, -1 + ((tu + 0.5) * 2) / TILE_N, -1 + ((tv + 0.5) * 2) / TILE_N, d);
    S.sample(d[0], d[1], d[2], 40, this.s);
    if (this.s.height < S.seaLevel + 1) return;
    const rnd = mulberry((t.key * 2654435761) ^ this.seed);
    const areaKm2 = ((Math.PI / 2) * S.radiusM / TILE_N / 1000) ** 2;
    this.list.forEach((brief, idx) => {
      const plan = brief.plan as Plan;
      const B = PLANS[plan];
      if (!B) return;
      const mean = (B.herd[0] + B.herd[1]) / 2;
      // Big herbivores are many, top predators few: the simulated density, capped for drawing.
      const perKm2 = Math.min(B.maxPerKm2, brief.density);
      if (rnd() >= (perKm2 * areaKm2) / mean) return;
      const sp = this.kindFor(brief);
      const size = B.herd[0] + Math.floor(rnd() * (B.herd[1] - B.herd[0] + 1));
      const home = new Float64Array(3);
      this.offset(d, (rnd() - 0.5) * 200, (rnd() - 0.5) * 200, home);
      for (let k = 0; k < size && this.count < MAX_ANIMALS && sp.members.length < CAPACITY; k++) {
        const dir = new Float64Array(3);
        this.offset(home, (rnd() - 0.5) * B.roam * 0.6, (rnd() - 0.5) * B.roam * 0.6, dir);
        const a: Animal = {
          sp, dir, home, heading: rnd() * Math.PI * 2, want: 0, speed: 0, state: 0, timer: rnd() * 3,
          phase: rnd() * 6.28, graze: 0, tile: t.key, rnd: mulberry((t.key ^ (idx * 7919) ^ (k * 104729)) >>> 0),
          orbit: rnd() * Math.PI * 2, orbitR: 30 + rnd() * 50, orbitH: 18 + rnd() * 40, height: 0,
        };
        a.want = a.heading;
        sp.members.push(a);
        t.animals.push(a);
        this.count++;
      }
    });
  }

  private removeAnimal(a: Animal): void {
    const m = a.sp.members;
    const i = m.indexOf(a);
    if (i >= 0) {
      m[i] = m[m.length - 1];
      m.pop();
      this.count--;
    }
    a.sp.mesh.count = m.length;
  }

  /** Move along the surface by (east, north) metres. */
  private offset(from: Float64Array, east: number, north: number, out: Float64Array): void {
    const R = this.sampler!.radiusM;
    tangentFrame(from, this.e, this.n, 0);
    const x = from[0] + (this.e[0] * east + this.n[0] * north) / R;
    const y = from[1] + (this.e[1] * east + this.n[1] * north) / R;
    const z = from[2] + (this.e[2] * east + this.n[2] * north) / R;
    const l = Math.hypot(x, y, z);
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
  }

  private think(a: Animal, dt: number, observer: Float64Array, R: number): void {
    const plan = PLANS[a.sp.plan];
    const S = this.sampler!;
    tangentFrame(a.dir, this.e, this.n, 0);
    const toObs = (x: number, y: number, z: number): [number, number] => [
      ((x - a.dir[0]) * this.e[0] + (y - a.dir[1]) * this.e[1] + (z - a.dir[2]) * this.e[2]) * R,
      ((x - a.dir[0]) * this.n[0] + (y - a.dir[1]) * this.n[1] + (z - a.dir[2]) * this.n[2]) * R,
    ];
    // Bigger animals walk faster (stride grows with size).
    const k = Math.sqrt(Math.max(0.3, a.sp.size));

    if (plan.flying) {
      a.orbit += (plan.walk / a.orbitR) * dt;
      const [hx, hy] = toObs(a.home[0], a.home[1], a.home[2]);
      const tx = hx + Math.cos(a.orbit) * a.orbitR, ty = hy + Math.sin(a.orbit) * a.orbitR;
      a.want = Math.atan2(tx, ty);
      a.speed = plan.walk;
      a.state = 1;
      a.phase += dt * 9;
    } else {
      const [ox, oy] = toObs(observer[0], observer[1], observer[2]);
      const dObs = Math.hypot(ox, oy);
      a.timer -= dt;
      if (plan.fear > 0 && dObs < plan.fear) {
        a.state = 2;
        a.want = Math.atan2(-ox, -oy);
        a.timer = 2 + a.rnd() * 2;
      } else if (a.timer <= 0) {
        const [hx, hy] = toObs(a.home[0], a.home[1], a.home[2]);
        if (a.rnd() < (a.sp.plan === 'predator' ? 0.7 : 0.4)) {
          a.state = 1;
          const tx = hx + (a.rnd() - 0.5) * plan.roam * 2, ty = hy + (a.rnd() - 0.5) * plan.roam * 2;
          a.want = Math.atan2(tx, ty);
          a.timer = 3 + a.rnd() * 6;
        } else {
          a.state = 0;
          a.timer = 2 + a.rnd() * 6;
        }
      }
      const target = (a.state === 2 ? plan.run : a.state === 1 ? plan.walk : 0) * k;
      a.speed += (target - a.speed) * Math.min(1, dt * 3);
      a.graze += ((a.state === 0 && a.sp.plan !== 'predator' ? 1 : 0) - a.graze) * Math.min(1, dt * 2);
      a.phase += dt * (a.speed / (plan.stride * a.sp.size)) * Math.PI * 2;
    }

    // Turn smoothly toward the wanted heading.
    let dh = a.want - a.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    a.heading += Math.max(-3 * dt, Math.min(3 * dt, dh));

    if (a.speed > 0.01) {
      const step = (a.speed * dt) / R;
      const fx = this.n[0] * Math.cos(a.heading) + this.e[0] * Math.sin(a.heading);
      const fy = this.n[1] * Math.cos(a.heading) + this.e[1] * Math.sin(a.heading);
      const fz = this.n[2] * Math.cos(a.heading) + this.e[2] * Math.sin(a.heading);
      const nx = a.dir[0] + fx * step, ny = a.dir[1] + fy * step, nz = a.dir[2] + fz * step;
      const l = Math.hypot(nx, ny, nz);
      const h = S.heightAt(nx / l, ny / l, nz / l, 0);
      if (!plan.flying && h < S.seaLevel + 0.3) {
        a.want = a.heading + Math.PI;
        a.heading += Math.PI * 0.5;
      } else {
        a.dir[0] = nx / l; a.dir[1] = ny / l; a.dir[2] = nz / l;
      }
    }
    const ground = S.heightAt(a.dir[0], a.dir[1], a.dir[2], 0);
    if (plan.flying) a.height = Math.max(ground, S.seaLevel) + a.orbitH + 3 * Math.sin(a.orbit * 2);
    else if (a.sp.plan === 'small' && a.speed > 0.3) a.height = ground + 0.18 * a.sp.size * Math.abs(Math.sin(a.phase));
    else a.height = ground;
  }

  private writeMatrix(sp: Kind, k: number, a: Animal, R: number): void {
    tangentFrame(a.dir, this.e, this.n, -a.heading);
    const r = R + a.height;
    const px = a.dir[0] * r - this.anchor.x, py = a.dir[1] * r - this.anchor.y, pz = a.dir[2] * r - this.anchor.z;
    const s = sp.size;
    let ux = a.dir[0], uy = a.dir[1], uz = a.dir[2];
    // Banking for birds.
    if (sp.plan === 'bird') {
      const bank = -0.35;
      const c = Math.cos(bank), sn = Math.sin(bank);
      const ex = this.e[0] * c + ux * sn, ey = this.e[1] * c + uy * sn, ez = this.e[2] * c + uz * sn;
      ux = ux * c - this.e[0] * sn; uy = uy * c - this.e[1] * sn; uz = uz * c - this.e[2] * sn;
      this.e[0] = ex; this.e[1] = ey; this.e[2] = ez;
    }
    this.m.set(
      this.e[0] * s, ux * s, this.n[0] * s, px,
      this.e[1] * s, uy * s, this.n[1] * s, py,
      this.e[2] * s, uz * s, this.n[2] * s, pz,
      0, 0, 0, 1,
    );
    sp.mesh.setMatrixAt(k, this.m);
  }

  private kindFor(brief: SpeciesBrief): Kind {
    let sp = this.kinds.get(brief.id);
    if (sp) return sp;
    const plan = brief.plan as Plan;
    const rnd = mulberry((brief.id * 2654435761) ^ this.seed);
    const t = buildAnimal(plan, rnd, brief);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));
    const col = new Uint8Array(t.col.length);
    for (let i = 0; i < col.length; i++) col[i] = Math.max(0, Math.min(255, t.col[i] * 255));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setAttribute('aPart', new THREE.BufferAttribute(t.part ?? new Float32Array(t.vertexCount), 1));
    geo.setAttribute('aPivot', new THREE.BufferAttribute(t.pivot ?? new Float32Array(t.vertexCount * 3), 3));
    const gait = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    gait.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGait', gait);
    const mesh = new THREE.InstancedMesh(geo, this.material, CAPACITY);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.position.copy(this.anchor);
    this.group.add(mesh);
    // Size from mass: length grows with the cube root of mass.
    const size = Math.max(0.2, Math.min(7, Math.cbrt(brief.massKg / PLANS[plan].refKg)));
    sp = { id: brief.id, plan, mesh, gait, members: [], size };
    this.kinds.set(brief.id, sp);
    return sp;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}

// ------------------------------------------------------------ body plans

function hslRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** Coat colour from the species' hue and shade: earthy for mammals, brighter plumage for birds. */
function coatOf(b: SpeciesBrief): RGB {
  const bird = b.clade === 'bird';
  const reptile = b.clade === 'reptile' || b.clade === 'amphibian';
  // Most fur is brown-grey: pull the hue toward ochre unless it is a bird or reptile.
  const hue = bird || reptile ? b.hue : 0.06 + 0.06 * Math.sin(b.hue * 6.283);
  const sat = bird ? 0.35 + 0.4 * b.hue : reptile ? 0.35 : 0.22 + 0.2 * b.shade;
  const light = 0.22 + 0.42 * b.shade;
  return hslRgb(hue, sat, light);
}

function buildAnimal(plan: Plan, rnd: () => number, brief: SpeciesBrief): Template {
  const b = new MeshBuilder();
  const fur = coatOf(brief);
  const belly = brief.pattern === 1 ? shade(fur, 1.45) : shade(fur, 1.2);
  const dark = shade(fur, 0.55);
  const horned = brief.horn > 0.45;
  const hornCol: RGB = brief.shade > 0.5 ? [0.36, 0.28, 0.2] : [0.85, 0.8, 0.7];
  switch (plan) {
    case 'grazer': {
      const s = 1;
      const leg = (0.62 + rnd() * 0.25) * s;
      const bodyL = 1.25 * s, bodyH = 0.52 * s, bodyW = 0.42 * s;
      legs(b, leg, bodyW * 0.36, bodyL * 0.38, 0.09 * s, dark);
      b.box(0, leg + bodyH / 2, 0, bodyW, bodyH, bodyL, fur);
      b.box(0, leg + bodyH * 0.18, 0, bodyW * 0.85, bodyH * 0.35, bodyL * 0.8, belly);
      if (brief.pattern === 2) for (let i = 0; i < 3; i++) b.box(0, leg + bodyH * 0.6, -bodyL * 0.3 + i * bodyL * 0.3, bodyW * 1.02, bodyH * 0.5, bodyL * 0.08, dark);
      b.box(0, leg + bodyH * 0.75, -bodyL / 2 - 0.05 * s, 0.08 * s, 0.18 * s + 0.3 * brief.tail * s, 0.1 * s, belly);
      // Neck and head nod together (part 7, pivot at the shoulders).
      b.part = 7;
      b.pivot = [0, leg + bodyH * 0.8, bodyL * 0.42];
      b.limb([0, leg + bodyH * 0.7, bodyL * 0.42], [0, leg + bodyH + 0.42 * s, bodyL * 0.62], 0.12 * s, 0.09 * s, 4, fur, false);
      const hy = leg + bodyH + 0.45 * s, hz = bodyL * 0.72;
      b.box(0, hy, hz, 0.2 * s, 0.2 * s, 0.38 * s, fur);
      b.box(0, hy - 0.03 * s, hz + 0.2 * s, 0.13 * s, 0.12 * s, 0.1 * s, dark);
      b.sheet([0.08 * s, hy + 0.08 * s, hz - 0.1 * s], [0.25 * s, hy + 0.2 * s, hz - 0.15 * s], [0.1 * s, hy + 0.12 * s, hz - 0.02 * s], fur);
      b.sheet([-0.08 * s, hy + 0.08 * s, hz - 0.1 * s], [-0.1 * s, hy + 0.12 * s, hz - 0.02 * s], [-0.25 * s, hy + 0.2 * s, hz - 0.15 * s], fur);
      if (horned) {
        const tall = 0.25 + brief.horn * 0.6;
        for (const side of [1, -1]) {
          const base: [number, number, number] = [side * 0.06 * s, hy + 0.1 * s, hz - 0.08 * s];
          const tip: [number, number, number] = [side * 0.2 * s, hy + (0.1 + tall) * s, hz - 0.25 * s];
          b.limb(base, tip, 0.03 * s, 0.012 * s, 3, hornCol, true);
          if (brief.horn > 0.75) b.limb([(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2], [side * 0.25 * s, hy + tall * 0.75 * s, hz], 0.02 * s, 0.01 * s, 3, hornCol, true);
        }
      }
      break;
    }
    case 'heavy': {
      const s = 1;
      const leg = 0.75 * s;
      const bodyL = 2.3 * s, bodyH = 1.15 * s, bodyW = 1.0 * s;
      legs(b, leg, bodyW * 0.32, bodyL * 0.34, 0.2 * s, dark);
      b.box(0, leg + bodyH / 2, 0, bodyW, bodyH, bodyL, fur);
      b.box(0, leg + bodyH * 0.85, bodyL * 0.22, bodyW * 1.05, bodyH * 0.45, bodyL * 0.45, shade(fur, 0.85));
      if (brief.tail > 0.3) b.limb([0, leg + bodyH * 0.6, -bodyL / 2], [0, leg * (1 - brief.tail), -bodyL / 2 - (0.4 + 1.6 * brief.tail) * s], 0.2 * s, 0.05 * s, 4, fur, true);
      b.part = 7;
      b.pivot = [0, leg + bodyH * 0.7, bodyL * 0.5];
      const hy = leg + bodyH * 0.55, hz = bodyL * 0.6;
      b.box(0, hy, hz, 0.55 * s, 0.6 * s, 0.6 * s, shade(fur, 0.9));
      if (!horned) {
        b.limb([0, hy - 0.1 * s, hz + 0.3 * s], [0, hy - 0.85 * s, hz + 0.45 * s], 0.13 * s, 0.07 * s, 4, shade(fur, 0.9), true);
        b.sheet([0.28 * s, hy + 0.2 * s, hz - 0.1 * s], [0.75 * s, hy - 0.1 * s, hz - 0.2 * s], [0.3 * s, hy - 0.35 * s, hz], shade(fur, 0.8));
        b.sheet([-0.28 * s, hy + 0.2 * s, hz - 0.1 * s], [-0.3 * s, hy - 0.35 * s, hz], [-0.75 * s, hy - 0.1 * s, hz - 0.2 * s], shade(fur, 0.8));
      } else {
        for (const side of [1, -1]) b.limb([side * 0.22 * s, hy + 0.2 * s, hz + 0.1 * s], [side * 0.45 * s, hy + (0.3 + 0.4 * brief.horn) * s, hz + 0.25 * s], 0.06 * s, 0.02 * s, 3, hornCol, true);
        if (brief.horn > 0.8) b.limb([0, hy + 0.05 * s, hz + 0.32 * s], [0, hy + 0.55 * s, hz + 0.5 * s], 0.08 * s, 0.02 * s, 3, hornCol, true);
      }
      break;
    }
    case 'small': {
      const s = 1;
      const leg = 0.12 * s;
      b.part = 3; b.pivot = [0.08 * s, leg, -0.1 * s];
      b.box(0.08 * s, leg / 2, -0.12 * s, 0.07 * s, leg, 0.2 * s, dark);
      b.part = 4; b.pivot = [-0.08 * s, leg, -0.1 * s];
      b.box(-0.08 * s, leg / 2, -0.12 * s, 0.07 * s, leg, 0.2 * s, dark);
      b.part = 1; b.pivot = [0.06 * s, leg, 0.12 * s];
      b.box(0.06 * s, leg / 2, 0.12 * s, 0.05 * s, leg, 0.05 * s, dark);
      b.part = 2; b.pivot = [-0.06 * s, leg, 0.12 * s];
      b.box(-0.06 * s, leg / 2, 0.12 * s, 0.05 * s, leg, 0.05 * s, dark);
      b.part = 0; b.pivot = [0, 0, 0];
      b.blob(0, leg + 0.13 * s, -0.02 * s, 0.17 * s, 0.14 * s, 0.24 * s, fur, rnd, 0.08);
      b.blob(0, leg + 0.07 * s, -0.25 * s, 0.07 * s, 0.07 * s, 0.07 * s, belly, rnd, 0.05);
      if (brief.tail > 0.4) b.limb([0, leg + 0.15 * s, -0.24 * s], [0, leg + (0.15 + 0.3 * brief.tail) * s, -(0.3 + 0.35 * brief.tail) * s], 0.05 * s, 0.03 * s, 3, fur, true);
      b.part = 7; b.pivot = [0, leg + 0.2 * s, 0.15 * s];
      b.blob(0, leg + 0.26 * s, 0.22 * s, 0.09 * s, 0.09 * s, 0.11 * s, fur, rnd, 0.05);
      const ear = 0.08 + brief.horn * 0.2;
      b.sheet([0.03 * s, leg + 0.32 * s, 0.2 * s], [0.07 * s, leg + (0.32 + ear) * s, 0.14 * s], [0.06 * s, leg + 0.3 * s, 0.16 * s], belly);
      b.sheet([-0.03 * s, leg + 0.32 * s, 0.2 * s], [-0.06 * s, leg + 0.3 * s, 0.16 * s], [-0.07 * s, leg + (0.32 + ear) * s, 0.14 * s], belly);
      break;
    }
    case 'predator': {
      const s = 1;
      const reptile = brief.clade === 'reptile';
      const leg = (reptile ? 0.3 : 0.48) * s;
      const bodyL = (reptile ? 1.5 : 1.0) * s, bodyH = 0.38 * s, bodyW = 0.32 * s;
      legs(b, leg, bodyW * 0.34, bodyL * 0.38, 0.08 * s, dark);
      b.box(0, leg + bodyH / 2, 0, bodyW, bodyH, bodyL, fur);
      if (brief.pattern === 2) for (let i = 0; i < 4; i++) b.box(0, leg + bodyH * 0.65, -bodyL * 0.36 + i * bodyL * 0.24, bodyW * 1.03, bodyH * 0.4, bodyL * 0.06, dark);
      b.limb([0, leg + bodyH * 0.75, -bodyL / 2], [0, leg + 0.05 * s, -bodyL / 2 - (0.3 + 0.6 * brief.tail) * s], 0.07 * s, 0.03 * s, 4, shade(fur, 0.9), true);
      b.part = 7; b.pivot = [0, leg + bodyH * 0.8, bodyL * 0.45];
      const hy = leg + bodyH * 1.05, hz = bodyL * 0.6;
      b.box(0, hy, hz, 0.24 * s, 0.22 * s, 0.26 * s, fur);
      b.box(0, hy - 0.05 * s, hz + 0.17 * s, 0.12 * s, 0.1 * s, (reptile ? 0.3 : 0.14) * s, belly);
      if (!reptile) {
        b.sheet([0.06 * s, hy + 0.1 * s, hz - 0.05 * s], [0.12 * s, hy + 0.25 * s, hz - 0.08 * s], [0.11 * s, hy + 0.1 * s, hz + 0.03 * s], dark);
        b.sheet([-0.06 * s, hy + 0.1 * s, hz - 0.05 * s], [-0.11 * s, hy + 0.1 * s, hz + 0.03 * s], [-0.12 * s, hy + 0.25 * s, hz - 0.08 * s], dark);
      }
      break;
    }
    case 'bird': {
      const s = 1;
      const plum = fur;
      b.blob(0, 0, 0, 0.11 * s, 0.1 * s, 0.26 * s, plum, rnd, 0.05);
      b.blob(0, 0.05 * s, 0.24 * s, 0.07 * s, 0.07 * s, 0.08 * s, shade(plum, 1.1), rnd, 0.05);
      b.tri([0.02 * s, 0.05 * s, 0.31 * s], [-0.02 * s, 0.05 * s, 0.31 * s], [0, 0.03 * s, 0.4 * s], [0.88, 0.69, 0.25]);
      b.sheet([0.05 * s, 0, -0.2 * s], [-0.05 * s, 0, -0.2 * s], [0, 0.01 * s, -(0.3 + 0.3 * brief.tail) * s], shade(plum, 0.8));
      const span = brief.flight ? 0.45 + rnd() * 0.35 : 0.15;
      b.part = 5; b.pivot = [0.08 * s, 0.03 * s, 0];
      b.sheet([0.08 * s, 0.03 * s, 0.1 * s], [0.08 * s, 0.03 * s, -0.1 * s], [(0.08 + span) * s, 0.03 * s, -0.05 * s], shade(plum, 0.9));
      b.part = 6; b.pivot = [-0.08 * s, 0.03 * s, 0];
      b.sheet([-0.08 * s, 0.03 * s, 0.1 * s], [-(0.08 + span) * s, 0.03 * s, -0.05 * s], [-0.08 * s, 0.03 * s, -0.1 * s], shade(plum, 0.9));
      break;
    }
  }
  return b.build();
}

/** Four legs with hip pivots: 1 front-left, 2 front-right, 3 back-left, 4 back-right. */
function legs(b: MeshBuilder, len: number, x: number, z: number, w: number, col: RGB): void {
  const spots: [number, number, number][] = [[x, z, 1], [-x, z, 2], [x, -z, 3], [-x, -z, 4]];
  for (const [lx, lz, part] of spots) {
    b.part = part;
    b.pivot = [lx, len, lz];
    b.box(lx, len / 2, lz, w, len, w, col);
    b.box(lx, w * 0.3, lz + w * 0.15, w * 1.1, w * 0.6, w * 1.3, shade(col, 0.7));
  }
  b.part = 0;
  b.pivot = [0, 0, 0];
}
