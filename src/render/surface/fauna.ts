import * as THREE from 'three';
import type { FaunaKind } from '../../core/rules/schema';
import { hashString } from '../../core/hash';
import { dirToFace, faceToDir, type FacePoint } from './cube';
import { AUTO_FAUNA, type BiomeLook } from './looks';
import { hex, MeshBuilder, mulberry, shade, type RGB, type Template } from './models';
import { newSample, type SurfaceSampler } from './sampler';
import { tangentFrame } from './vegetation';

/**
 * Animals around the observer. Each world grows its own species from a few
 * body plans (the rule pack says which plans live in which biome and how
 * densely); their proportions and coats come from the world seed. Herds are
 * spawned per ~300 m tile from a hash, so walking back to a place finds the
 * same herd there. Legs and wings are animated on the GPU; behaviour (graze,
 * wander, flee from the player, circle in the sky) runs on the CPU.
 *
 * Until the ecology simulation (M4) exists these are the biome's archetypes;
 * later they will be drawn from the simulated species and populations.
 */

const TILE_N = 2 ** 15;
const SPAWN_RADIUS = 650;
const DESPAWN_MS = 2500;
const MAX_ANIMALS = 220;
const CAPACITY = 64;

interface Plan {
  walk: number;
  run: number;
  fear: number;
  herd: [number, number];
  roam: number;
  stride: number;
  flying: boolean;
}

const PLANS: Record<FaunaKind, Plan> = {
  grazer: { walk: 1.4, run: 10, fear: 32, herd: [3, 11], roam: 40, stride: 1.5, flying: false },
  heavy: { walk: 1.1, run: 5.5, fear: 18, herd: [2, 6], roam: 50, stride: 2.4, flying: false },
  small: { walk: 0.9, run: 6, fear: 11, herd: [1, 3], roam: 15, stride: 0.5, flying: false },
  predator: { walk: 1.8, run: 9, fear: 0, herd: [1, 2], roam: 130, stride: 1.3, flying: false },
  bird: { walk: 9, run: 14, fear: 0, herd: [4, 12], roam: 90, stride: 3, flying: true },
};

interface Species {
  key: string;
  kind: FaunaKind;
  mesh: THREE.InstancedMesh;
  gait: THREE.InstancedBufferAttribute;
  members: Animal[];
  size: number;
}

interface Animal {
  sp: Species;
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
  private readonly species = new Map<string, Species>();
  private readonly tiles = new Map<number, Tile>();
  private readonly uniforms = { uTime: { value: 0 } };
  private sampler: SurfaceSampler | null = null;
  private looks: BiomeLook[] = [];
  private seed = 0;
  private readonly anchor = new THREE.Vector3();
  private anchorSet = false;
  private lastScan = -1e9;
  private readonly fp: FacePoint = { face: 0, u: 0, v: 0 };
  private readonly tmp = new Float64Array(3);
  private readonly e = new Float64Array(3);
  private readonly n = new Float64Array(3);
  private readonly m = new THREE.Matrix4();
  private readonly s = newSample();
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

  setWorld(sampler: SurfaceSampler, looks: BiomeLook[], seed: number): void {
    const same = this.seed === seed && this.looks.length === looks.length;
    this.sampler = sampler;
    this.looks = looks;
    if (!same) this.clear();
    this.seed = seed;
  }

  clear(): void {
    for (const t of this.tiles.values()) for (const a of t.animals) this.removeAnimal(a);
    this.tiles.clear();
    for (const sp of this.species.values()) {
      this.group.remove(sp.mesh);
      sp.mesh.geometry.dispose();
    }
    this.species.clear();
    this.count = 0;
  }

  /** Advance animals; `observer` is the player (or camera focus) direction and height. */
  update(dt: number, timeS: number, observer: Float64Array, observerHeight: number, active: boolean): void {
    this.uniforms.uTime.value = timeS;
    this.group.visible = active;
    if (!active || !this.sampler) return;
    const S = this.sampler;
    const R = S.radiusM;
    const ox = observer[0] * (R + observerHeight), oy = observer[1] * (R + observerHeight), oz = observer[2] * (R + observerHeight);
    if (!this.anchorSet || this.anchor.distanceTo(new THREE.Vector3(ox, oy, oz)) > 1500) {
      this.anchor.set(ox, oy, oz);
      this.anchorSet = true;
      for (const sp of this.species.values()) sp.mesh.position.copy(this.anchor);
    }
    const now = performance.now();
    if (now - this.lastScan > 400) {
      this.lastScan = now;
      this.scanTiles(observer, now);
    }
    dt = Math.min(dt, 0.1);
    for (const sp of this.species.values()) {
      const g = sp.gait.array as Float32Array;
      for (let k = 0; k < sp.members.length; k++) {
        const a = sp.members[k];
        this.think(a, dt, observer, R);
        this.writeMatrix(sp, k, a, R);
        g[k * 3] = a.phase;
        g[k * 3 + 1] = a.sp.kind === 'bird' ? (a.state === 2 ? 0.9 : 0.55 + 0.35 * Math.max(0, Math.sin(timeS * 0.4 + a.orbit))) : Math.min(0.75, a.speed > 0.05 ? 0.3 + a.speed * 0.05 : 0);
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
    const S = this.sampler!;
    const d = this.tmp;
    faceToDir(face, -1 + ((tu + 0.5) * 2) / TILE_N, -1 + ((tv + 0.5) * 2) / TILE_N, d);
    S.sample(d[0], d[1], d[2], 40, this.s);
    if (this.s.height < S.seaLevel + 1) return;
    const look = this.looks[this.s.biome];
    if (!look) return;
    const fauna = look.auto ? AUTO_FAUNA : look.fauna;
    const rnd = mulberry((t.key * 2654435761) ^ this.seed);
    const areaKm2 = ((Math.PI / 2) * S.radiusM / TILE_N / 1000) ** 2;
    fauna.forEach((f, idx) => {
      const plan = PLANS[f.kind];
      const mean = (plan.herd[0] + plan.herd[1]) / 2;
      if (rnd() >= (f.perKm2 * areaKm2) / mean) return;
      const sp = this.speciesFor(this.s.biome, idx, f.kind);
      const size = plan.herd[0] + Math.floor(rnd() * (plan.herd[1] - plan.herd[0] + 1));
      const home = new Float64Array(3);
      this.offset(d, (rnd() - 0.5) * 200, (rnd() - 0.5) * 200, home);
      for (let k = 0; k < size && this.count < MAX_ANIMALS && sp.members.length < CAPACITY; k++) {
        const dir = new Float64Array(3);
        this.offset(home, (rnd() - 0.5) * plan.roam * 0.6, (rnd() - 0.5) * plan.roam * 0.6, dir);
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
    const plan = PLANS[a.sp.kind];
    const S = this.sampler!;
    tangentFrame(a.dir, this.e, this.n, 0);
    const toObs = (x: number, y: number, z: number): [number, number] => [
      ((x - a.dir[0]) * this.e[0] + (y - a.dir[1]) * this.e[1] + (z - a.dir[2]) * this.e[2]) * R,
      ((x - a.dir[0]) * this.n[0] + (y - a.dir[1]) * this.n[1] + (z - a.dir[2]) * this.n[2]) * R,
    ];

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
        if (a.rnd() < (a.sp.kind === 'predator' ? 0.7 : 0.4)) {
          a.state = 1;
          const tx = hx + (a.rnd() - 0.5) * plan.roam * 2, ty = hy + (a.rnd() - 0.5) * plan.roam * 2;
          a.want = Math.atan2(tx, ty);
          a.timer = 3 + a.rnd() * 6;
        } else {
          a.state = 0;
          a.timer = 2 + a.rnd() * 6;
        }
      }
      const target = a.state === 2 ? plan.run : a.state === 1 ? plan.walk : 0;
      a.speed += (target - a.speed) * Math.min(1, dt * 3);
      a.graze += ((a.state === 0 && a.sp.kind !== 'predator' ? 1 : 0) - a.graze) * Math.min(1, dt * 2);
      a.phase += dt * (a.speed / plan.stride) * Math.PI * 2;
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
    else if (a.sp.kind === 'small' && a.speed > 0.3) a.height = ground + 0.18 * Math.abs(Math.sin(a.phase));
    else a.height = ground;
  }

  private writeMatrix(sp: Species, k: number, a: Animal, R: number): void {
    tangentFrame(a.dir, this.e, this.n, -a.heading);
    const r = R + a.height;
    const px = a.dir[0] * r - this.anchor.x, py = a.dir[1] * r - this.anchor.y, pz = a.dir[2] * r - this.anchor.z;
    const s = sp.size;
    let ux = a.dir[0], uy = a.dir[1], uz = a.dir[2];
    // Banking for birds.
    if (sp.kind === 'bird') {
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

  private speciesFor(biome: number, idx: number, kind: FaunaKind): Species {
    const key = `${biome}:${idx}:${kind}`;
    let sp = this.species.get(key);
    if (sp) return sp;
    const rnd = mulberry(hashString(`${this.seed}:${key}`));
    const look = this.looks[biome];
    const t = buildAnimal(kind, rnd, look?.ground ?? [0.5, 0.5, 0.4]);
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
    sp = { key, kind, mesh, gait, members: [], size: 0.85 + rnd() * 0.4 };
    this.species.set(key, sp);
    return sp;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}

// ------------------------------------------------------------ body plans

const COATS = ['#8a6a48', '#6e5a44', '#a88a62', '#5c4a3a', '#9a9288', '#c4a878', '#4a4440', '#b07a4a'];

function coat(rnd: () => number, ground: [number, number, number]): RGB {
  const snowy = ground[0] + ground[1] + ground[2] > 2.4;
  if (snowy && rnd() < 0.7) return hex(rnd() < 0.5 ? '#e8e6e0' : '#c9c4ba');
  return hex(COATS[Math.floor(rnd() * COATS.length)]);
}

function buildAnimal(kind: FaunaKind, rnd: () => number, ground: [number, number, number]): Template {
  const b = new MeshBuilder();
  const fur = coat(rnd, ground);
  const belly = shade(fur, 1.3);
  const dark = shade(fur, 0.55);
  switch (kind) {
    case 'grazer': {
      const s = 0.85 + rnd() * 0.5;
      const leg = (0.62 + rnd() * 0.25) * s;
      const bodyL = 1.25 * s, bodyH = 0.52 * s, bodyW = 0.42 * s;
      legs(b, leg, bodyW * 0.36, bodyL * 0.38, 0.09 * s, dark);
      b.box(0, leg + bodyH / 2, 0, bodyW, bodyH, bodyL, fur);
      b.box(0, leg + bodyH * 0.18, 0, bodyW * 0.85, bodyH * 0.35, bodyL * 0.8, belly);
      b.box(0, leg + bodyH * 0.75, -bodyL / 2 - 0.05 * s, 0.08 * s, 0.18 * s, 0.1 * s, belly);
      // Neck and head nod together (part 7, pivot at the shoulders).
      b.part = 7;
      b.pivot = [0, leg + bodyH * 0.8, bodyL * 0.42];
      b.limb([0, leg + bodyH * 0.7, bodyL * 0.42], [0, leg + bodyH + 0.42 * s, bodyL * 0.62], 0.12 * s, 0.09 * s, 4, fur, false);
      const hy = leg + bodyH + 0.45 * s, hz = bodyL * 0.72;
      b.box(0, hy, hz, 0.2 * s, 0.2 * s, 0.38 * s, fur);
      b.box(0, hy - 0.03 * s, hz + 0.2 * s, 0.13 * s, 0.12 * s, 0.1 * s, dark);
      b.sheet([0.08 * s, hy + 0.08 * s, hz - 0.1 * s], [0.25 * s, hy + 0.2 * s, hz - 0.15 * s], [0.1 * s, hy + 0.12 * s, hz - 0.02 * s], fur);
      b.sheet([-0.08 * s, hy + 0.08 * s, hz - 0.1 * s], [-0.1 * s, hy + 0.12 * s, hz - 0.02 * s], [-0.25 * s, hy + 0.2 * s, hz - 0.15 * s], fur);
      if (rnd() < 0.55) {
        const horn = hex(rnd() < 0.5 ? '#d8ccb4' : '#5a4632');
        const tall = 0.35 + rnd() * 0.45;
        for (const side of [1, -1]) {
          const base: [number, number, number] = [side * 0.06 * s, hy + 0.1 * s, hz - 0.08 * s];
          const tip: [number, number, number] = [side * 0.2 * s, hy + (0.1 + tall) * s, hz - 0.25 * s];
          b.limb(base, tip, 0.03 * s, 0.012 * s, 3, horn, true);
          if (rnd() < 0.5) b.limb([(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2], [side * 0.25 * s, hy + tall * 0.75 * s, hz], 0.02 * s, 0.01 * s, 3, horn, true);
        }
      }
      break;
    }
    case 'heavy': {
      const s = 1.0 + rnd() * 0.4;
      const leg = 0.75 * s;
      const bodyL = 2.3 * s, bodyH = 1.15 * s, bodyW = 1.0 * s;
      legs(b, leg, bodyW * 0.32, bodyL * 0.34, 0.2 * s, dark);
      b.box(0, leg + bodyH / 2, 0, bodyW, bodyH, bodyL, fur);
      b.box(0, leg + bodyH * 0.85, bodyL * 0.22, bodyW * 1.05, bodyH * 0.45, bodyL * 0.45, shade(fur, 0.85));
      b.part = 7;
      b.pivot = [0, leg + bodyH * 0.7, bodyL * 0.5];
      const hy = leg + bodyH * 0.55, hz = bodyL * 0.6;
      b.box(0, hy, hz, 0.55 * s, 0.6 * s, 0.6 * s, shade(fur, 0.9));
      if (rnd() < 0.5) {
        b.limb([0, hy - 0.1 * s, hz + 0.3 * s], [0, hy - 0.85 * s, hz + 0.45 * s], 0.13 * s, 0.07 * s, 4, shade(fur, 0.9), true);
        b.sheet([0.28 * s, hy + 0.2 * s, hz - 0.1 * s], [0.75 * s, hy - 0.1 * s, hz - 0.2 * s], [0.3 * s, hy - 0.35 * s, hz], shade(fur, 0.8));
        b.sheet([-0.28 * s, hy + 0.2 * s, hz - 0.1 * s], [-0.3 * s, hy - 0.35 * s, hz], [-0.75 * s, hy - 0.1 * s, hz - 0.2 * s], shade(fur, 0.8));
      } else {
        const horn = hex('#e0d6c0');
        for (const side of [1, -1]) b.limb([side * 0.22 * s, hy + 0.2 * s, hz + 0.1 * s], [side * 0.45 * s, hy + 0.45 * s, hz + 0.25 * s], 0.06 * s, 0.02 * s, 3, horn, true);
      }
      break;
    }
    case 'small': {
      const s = 0.8 + rnd() * 0.5;
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
      b.part = 7; b.pivot = [0, leg + 0.2 * s, 0.15 * s];
      b.blob(0, leg + 0.26 * s, 0.22 * s, 0.09 * s, 0.09 * s, 0.11 * s, fur, rnd, 0.05);
      const ear = 0.15 + rnd() * 0.14;
      b.sheet([0.03 * s, leg + 0.32 * s, 0.2 * s], [0.07 * s, leg + (0.32 + ear) * s, 0.14 * s], [0.06 * s, leg + 0.3 * s, 0.16 * s], belly);
      b.sheet([-0.03 * s, leg + 0.32 * s, 0.2 * s], [-0.06 * s, leg + 0.3 * s, 0.16 * s], [-0.07 * s, leg + (0.32 + ear) * s, 0.14 * s], belly);
      break;
    }
    case 'predator': {
      const s = 0.85 + rnd() * 0.45;
      const leg = 0.48 * s;
      const bodyL = 1.0 * s, bodyH = 0.38 * s, bodyW = 0.32 * s;
      legs(b, leg, bodyW * 0.34, bodyL * 0.38, 0.08 * s, dark);
      b.box(0, leg + bodyH / 2, 0, bodyW, bodyH, bodyL, fur);
      b.limb([0, leg + bodyH * 0.75, -bodyL / 2], [0, leg + 0.05 * s, -bodyL / 2 - 0.5 * s], 0.07 * s, 0.03 * s, 4, shade(fur, 0.9), true);
      b.part = 7; b.pivot = [0, leg + bodyH * 0.8, bodyL * 0.45];
      const hy = leg + bodyH * 1.05, hz = bodyL * 0.6;
      b.box(0, hy, hz, 0.24 * s, 0.22 * s, 0.26 * s, fur);
      b.box(0, hy - 0.05 * s, hz + 0.17 * s, 0.12 * s, 0.1 * s, 0.14 * s, belly);
      b.sheet([0.06 * s, hy + 0.1 * s, hz - 0.05 * s], [0.12 * s, hy + 0.25 * s, hz - 0.08 * s], [0.11 * s, hy + 0.1 * s, hz + 0.03 * s], dark);
      b.sheet([-0.06 * s, hy + 0.1 * s, hz - 0.05 * s], [-0.11 * s, hy + 0.1 * s, hz + 0.03 * s], [-0.12 * s, hy + 0.25 * s, hz - 0.08 * s], dark);
      break;
    }
    case 'bird': {
      const s = 0.8 + rnd() * 0.8;
      const plum = rnd() < 0.3 ? hex(['#2a2a2e', '#f0ede6', '#7a5a3a', '#4a6a8a'][Math.floor(rnd() * 4)]) : fur;
      b.blob(0, 0, 0, 0.11 * s, 0.1 * s, 0.26 * s, plum, rnd, 0.05);
      b.blob(0, 0.05 * s, 0.24 * s, 0.07 * s, 0.07 * s, 0.08 * s, shade(plum, 1.1), rnd, 0.05);
      b.tri([0.02 * s, 0.05 * s, 0.31 * s], [-0.02 * s, 0.05 * s, 0.31 * s], [0, 0.03 * s, 0.4 * s], hex('#e0b040'));
      b.sheet([0.05 * s, 0, -0.2 * s], [-0.05 * s, 0, -0.2 * s], [0, 0.01 * s, -0.4 * s], shade(plum, 0.8));
      const span = 0.45 + rnd() * 0.35;
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
