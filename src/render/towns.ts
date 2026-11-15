import * as THREE from 'three';
import { BUILDINGS } from '../core/systems/society/data';
import type { MeshPayload, TownBrief } from '../worker/protocol';
import { MeshBuilder, mulberry, shade, type RGB } from './surface/models';
import type { SurfaceSampler } from './surface/sampler';
import { tangentFrame } from './surface/vegetation';

/**
 * Settlements in the view.
 *
 * From orbit: a marker per town (size by population, colour by nation), name
 * labels for the largest towns and capitals, and trade routes as arcs.
 * Near the ground: the town itself, built procedurally from its population,
 * era, nation and buildings — huts around a shrine in the stone age, gabled
 * houses, temples and walls later, factories and chimneys in the industrial
 * age, towers in the centre in the modern one — with residents walking its
 * streets. The layout is a pure function of the town (same town, same streets).
 */

const BUILDING_ID = BUILDINGS.map((b) => b.id);
/** Close-up towns are built below this camera altitude. */
const SCAPE_ALT = 40_000;
/** …and within this distance of the observer. */
const SCAPE_RANGE = 45_000;
const MAX_LABELS = 28;
const RESIDENTS = 48;

interface Scape {
  id: number;
  key: string;
  group: THREE.Group;
  /** Local frame. */
  origin: THREE.Vector3;
  e: Float64Array;
  n: Float64Array;
  up: Float64Array;
  radius: number;
  /** Height grid over the town (local, metres above the origin). */
  grid: Float32Array;
  gridN: number;
  gridSpan: number;
  people: THREE.InstancedMesh | null;
  walkers: { ax: number; az: number; bx: number; bz: number; t: number; speed: number }[];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function labelTexture(text: string, capital: boolean): { tex: THREE.CanvasTexture; aspect: number } {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = `${capital ? 'bold ' : ''}30px "Hiragino Sans","Yu Gothic UI","Meiryo","Noto Sans JP",sans-serif`;
  ctx.font = font;
  const label = capital ? `★ ${text}` : text;
  const w = Math.ceil(ctx.measureText(label).width) + 16;
  c.width = w;
  c.height = 44;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(8,12,20,0.85)';
  ctx.strokeText(label, 8, 23);
  ctx.fillStyle = capital ? '#ffe9a8' : '#f2f4f8';
  ctx.fillText(label, 8, 23);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return { tex, aspect: w / 44 };
}

export class Towns {
  /** Unit-sphere objects (added to the scaled globe group). */
  readonly globeGroup = new THREE.Group();
  /** Objects in planet-centred metres. */
  readonly sceneGroup = new THREE.Group();
  private mesh: MeshPayload | null = null;
  private radiusM = 6.371e6;
  private list: TownBrief[] = [];
  private markers: THREE.InstancedMesh | null = null;
  private readonly markerMat = new THREE.MeshBasicMaterial({ fog: false });
  private routes: THREE.LineSegments | null = null;
  private readonly routeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, fog: false });
  private readonly labels = new Map<number, { sprite: THREE.Sprite; aspect: number; key: string }>();
  private readonly scapes = new Map<number, Scape>();
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly personGeo: THREE.BufferGeometry;
  sampler: SurfaceSampler | null = null;
  private stale = false;
  private readonly v = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private alt = 1e9;

  constructor() {
    this.sceneGroup.renderOrder = 5;
    // A walking person: legs, body, head (1.7 m).
    const b = new MeshBuilder();
    b.box(0.09, 0.42, 0, 0.12, 0.84, 0.14, [0.25, 0.24, 0.3]);
    b.box(-0.09, 0.42, 0, 0.12, 0.84, 0.14, [0.25, 0.24, 0.3]);
    b.box(0, 1.15, 0, 0.42, 0.62, 0.24, [0.7, 0.5, 0.35]);
    b.box(0, 1.58, 0, 0.22, 0.24, 0.22, [0.86, 0.7, 0.55]);
    const t = b.build();
    this.personGeo = new THREE.BufferGeometry();
    this.personGeo.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));
    const col = new Uint8Array(t.col.length);
    for (let i = 0; i < col.length; i++) col[i] = t.col[i] * 255;
    this.personGeo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  }

  setMesh(mesh: MeshPayload): void {
    this.mesh = mesh;
    this.radiusM = mesh.radiusKm * 1000;
    this.clearScapes();
    this.set([], []);
  }

  /** The ground changed: rebuild close-up towns on the new heights. */
  surfaceChanged(sampler: SurfaceSampler): void {
    this.sampler = sampler;
    this.stale = true;
  }

  private dir(cell: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.mesh!.pos;
    return out.set(p[cell * 3], p[cell * 3 + 1], p[cell * 3 + 2]).normalize();
  }

  set(towns: TownBrief[], links: [number, number, number, number][]): void {
    this.list = towns;
    const m = this.mesh;
    // Markers.
    if (this.markers) {
      this.globeGroup.remove(this.markers);
      this.markers.dispose();
      this.markers = null;
    }
    if (m && towns.length) {
      const geo = new THREE.OctahedronGeometry(1, 0);
      const mk = new THREE.InstancedMesh(geo, this.markerMat, towns.length);
      const col = new THREE.Color();
      towns.forEach((t, i) => {
        this.dir(t.cell, this.v);
        const s = 0.0016 * (1 + Math.log10(1 + t.pop / 2000)) * (t.capital ? 1.5 : 1);
        this.m.makeScale(s, s, s).setPosition(this.v.multiplyScalar(1.004));
        mk.setMatrixAt(i, this.m);
        col.set(t.color);
        if (t.plague) col.lerp(new THREE.Color(0x8a2040), 0.5);
        mk.setColorAt(i, col);
      });
      mk.renderOrder = 6;
      this.markers = mk;
      this.globeGroup.add(mk);
    }
    // Trade routes as raised arcs.
    if (this.routes) {
      this.sceneGroup.remove(this.routes);
      this.routes.geometry.dispose();
      this.routes = null;
    }
    if (m && links.length) {
      const SEG = 10;
      const pos = new Float32Array(links.length * SEG * 6);
      const col = new Float32Array(links.length * SEG * 6);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
      let o = 0;
      let maxVol = 1;
      for (const l of links) maxVol = Math.max(maxVol, l[2]);
      for (const [ca, cb, vol, sea] of links) {
        this.dir(ca, a);
        this.dir(cb, b);
        const ang = a.angleTo(b);
        const lift = this.radiusM * (1 + 0.002 + 0.06 * ang);
        const k = 0.35 + 0.65 * Math.sqrt(vol / maxVol);
        const c: RGB = sea ? [0.45 * k, 0.75 * k, 1 * k] : [1 * k, 0.82 * k, 0.45 * k];
        for (let s = 0; s < SEG; s++) {
          for (const [t, out] of [[s / SEG, p], [(s + 1) / SEG, q]] as const) {
            out.copy(a).lerp(b, t).normalize().multiplyScalar(this.radiusM + (lift - this.radiusM) * Math.sin(Math.PI * t) * 0.5 + 9000);
          }
          pos.set([p.x, p.y, p.z, q.x, q.y, q.z], o * 3);
          col.set([...c, ...c], o * 3);
          o += 2;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.radiusM * 1.2);
      this.routes = new THREE.LineSegments(g, this.routeMat);
      this.routes.renderOrder = 6;
      this.sceneGroup.add(this.routes);
    }
    // Labels for the biggest towns and every capital among them.
    const top = [...towns].sort((x, y) => (y.capital ? 1 : 0) * 3e6 + y.pop - ((x.capital ? 1 : 0) * 3e6 + x.pop)).slice(0, MAX_LABELS);
    const keep = new Set(top.map((t) => t.id));
    for (const [id, l] of this.labels) {
      if (keep.has(id)) continue;
      this.sceneGroup.remove(l.sprite);
      l.sprite.material.map?.dispose();
      l.sprite.material.dispose();
      this.labels.delete(id);
    }
    for (const t of top) {
      const key = `${t.name}|${t.capital}`;
      const cur = this.labels.get(t.id);
      if (cur && cur.key === key) continue;
      if (cur) {
        this.sceneGroup.remove(cur.sprite);
        cur.sprite.material.map?.dispose();
        cur.sprite.material.dispose();
      }
      const { tex, aspect } = labelTexture(t.name, t.capital);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthWrite: false, transparent: true, fog: false }));
      sprite.center.set(0.5, -0.25);
      sprite.renderOrder = 8;
      this.sceneGroup.add(sprite);
      this.labels.set(t.id, { sprite, aspect, key });
    }
    // Close-up towns whose look changed are rebuilt on the next frame.
    for (const s of this.scapes.values()) {
      const t = towns.find((x) => x.id === s.id);
      if (!t || scapeKey(t) !== s.key) this.dropScape(s.id);
    }
  }

  /** Town nearest to a screen point (markers from orbit, the town under the cursor close up). */
  pick(camera: THREE.Camera, ndcX: number, ndcY: number, width: number, height: number, ground: Float64Array | null): number {
    if (!this.mesh) return -1;
    if (this.alt < SCAPE_ALT && ground) {
      for (const s of this.scapes.values()) {
        const d = Math.acos(Math.min(1, ground[0] * s.up[0] + ground[1] * s.up[1] + ground[2] * s.up[2])) * this.radiusM;
        if (d < s.radius * 1.1) return s.id;
      }
    }
    let best = -1;
    let bestD = 18;
    for (const t of this.list) {
      this.dir(t.cell, this.v).multiplyScalar(this.radiusM * 1.004).project(camera);
      if (this.v.z > 1) continue;
      const d = Math.hypot(((this.v.x - ndcX) * width) / 2, ((this.v.y - ndcY) * height) / 2);
      if (d < bestD) {
        bestD = d;
        best = t.id;
      }
    }
    return best;
  }

  update(camera: THREE.PerspectiveCamera, observer: Float64Array, alt: number, dt: number): void {
    this.alt = alt;
    const R = this.radiusM;
    const far = smoothstep(SCAPE_ALT * 0.5, SCAPE_ALT * 1.5, alt);
    if (this.markers) this.markers.visible = far > 0.01;
    if (this.routes) {
      this.routes.visible = alt > 8000;
      this.routeMat.opacity = 0.25 + 0.5 * far;
    }
    // Labels: fixed screen size; float above the town, lower as we come down.
    const h = Math.max(150, Math.min(40_000, alt * 0.02));
    for (const [id, l] of this.labels) {
      const t = this.list.find((x) => x.id === id);
      if (!t) continue;
      this.dir(t.cell, this.v);
      const ground = this.sampler ? Math.max(this.sampler.seaLevel, this.sampler.heightAt(this.v.x, this.v.y, this.v.z, 200)) : 0;
      l.sprite.position.copy(this.v).multiplyScalar(R + ground + h);
      const sc = alt > 3_000_000 ? 0.026 : 0.032;
      l.sprite.scale.set(sc * l.aspect, sc, 1);
      // Hide labels on the far side of the planet (the depth test does the rest).
      const facing = this.v.dot(this.v.clone().set(camera.position.x, camera.position.y, camera.position.z).normalize());
      l.sprite.visible = facing > 0.05 || alt < 200_000;
    }
    // Close-up towns.
    if (!this.sampler || !this.mesh) return;
    if (this.stale) {
      this.clearScapes();
      this.stale = false;
    }
    const near = alt < SCAPE_ALT;
    if (near) {
      let built = 0;
      for (const t of this.list) {
        const d = this.dir(t.cell, this.v);
        const dist = Math.acos(Math.min(1, d.x * observer[0] + d.y * observer[1] + d.z * observer[2])) * R;
        if (dist > SCAPE_RANGE) {
          if (this.scapes.has(t.id)) this.dropScape(t.id);
          continue;
        }
        if (!this.scapes.has(t.id) && built < 1) {
          this.buildScape(t);
          built++;
        }
      }
    }
    for (const s of this.scapes.values()) {
      s.group.visible = near;
      if (near && s.people) this.walk(s, dt);
    }
  }

  private clearScapes(): void {
    for (const id of [...this.scapes.keys()]) this.dropScape(id);
  }

  private dropScape(id: number): void {
    const s = this.scapes.get(id);
    if (!s) return;
    this.sceneGroup.remove(s.group);
    for (const c of s.group.children) {
      if (c instanceof THREE.InstancedMesh) c.dispose();
      else (c as THREE.Mesh).geometry?.dispose();
    }
    this.scapes.delete(id);
  }

  /** Height (local, above the origin) at local (x, z) from the town's grid. */
  private localHeight(s: Scape, x: number, z: number): number {
    const N = s.gridN;
    const fx = ((x / s.gridSpan + 0.5) * (N - 1));
    const fz = ((z / s.gridSpan + 0.5) * (N - 1));
    const i = Math.max(0, Math.min(N - 2, Math.floor(fx))), j = Math.max(0, Math.min(N - 2, Math.floor(fz)));
    const u = Math.max(0, Math.min(1, fx - i)), w = Math.max(0, Math.min(1, fz - j));
    const g = s.grid;
    return (g[j * N + i] * (1 - u) + g[j * N + i + 1] * u) * (1 - w) + (g[(j + 1) * N + i] * (1 - u) + g[(j + 1) * N + i + 1] * u) * w;
  }

  private buildScape(t: TownBrief): void {
    const S = this.sampler!;
    const R = this.radiusM;
    const up = new Float64Array(3);
    const p = this.mesh!.pos;
    const l = Math.hypot(p[t.cell * 3], p[t.cell * 3 + 1], p[t.cell * 3 + 2]);
    up[0] = p[t.cell * 3] / l; up[1] = p[t.cell * 3 + 1] / l; up[2] = p[t.cell * 3 + 2] / l;
    const rnd = mulberry((t.id * 2654435761) ^ 0x51ab);
    const e = new Float64Array(3), n = new Float64Array(3);
    tangentFrame(up, e, n, rnd() * Math.PI * 2);
    // Towns sit on dry land near the cell centre: nudge off water.
    const h0 = S.heightAt(up[0], up[1], up[2], 4);
    const base = Math.max(h0, S.seaLevel + 1);
    const radius = Math.min(4500, 120 + 55 * Math.sqrt(t.pop / 1000));
    const N = 33;
    const span = radius * 2.4;
    const grid = new Float32Array(N * N);
    const dd = new Float64Array(3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1) - 0.5) * span, z = (j / (N - 1) - 0.5) * span;
        for (let k = 0; k < 3; k++) dd[k] = up[k] + (e[k] * x + n[k] * z) / R;
        const ll = Math.hypot(dd[0], dd[1], dd[2]);
        const h = S.heightAt(dd[0] / ll, dd[1] / ll, dd[2] / ll, 4);
        // Curvature: the ground falls away from the tangent plane.
        grid[j * N + i] = h - base - (x * x + z * z) / (2 * R);
      }
    }
    const origin = new THREE.Vector3(up[0] * (R + base), up[1] * (R + base), up[2] * (R + base));
    const s: Scape = { id: t.id, key: scapeKey(t), group: new THREE.Group(), origin, e, n, up, radius, grid, gridN: N, gridSpan: span, people: null, walkers: [] };
    const seaLocal = S.seaLevel - base;
    const geo = buildTown(t, rnd, radius, (x, z) => this.localHeight(s, x, z), seaLocal, s.walkers);
    const mesh = new THREE.Mesh(geo, this.material);
    s.group.add(mesh);
    if (s.walkers.length) {
      const people = new THREE.InstancedMesh(this.personGeo, this.material, s.walkers.length);
      people.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      people.frustumCulled = false;
      s.people = people;
      s.group.add(people);
    }
    s.group.position.copy(origin);
    // Local frame: x = east', y = up, z = north'.
    this.m.makeBasis(new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(up[0], up[1], up[2]), new THREE.Vector3(n[0], n[1], n[2]));
    s.group.quaternion.setFromRotationMatrix(this.m);
    this.sceneGroup.add(s.group);
    this.scapes.set(t.id, s);
  }

  private walk(s: Scape, dt: number): void {
    const P = s.people!;
    const m = this.m;
    for (let k = 0; k < s.walkers.length; k++) {
      const w = s.walkers[k];
      w.t += (dt * w.speed) / Math.max(1, Math.hypot(w.bx - w.ax, w.bz - w.az));
      const f = w.t % 2;
      const u = f < 1 ? f : 2 - f;
      const x = w.ax + (w.bx - w.ax) * u, z = w.az + (w.bz - w.az) * u;
      const dir = f < 1 ? 1 : -1;
      const yaw = Math.atan2((w.bx - w.ax) * dir, (w.bz - w.az) * dir);
      const y = this.localHeight(s, x, z) + 0.05 * Math.abs(Math.sin(w.t * 40));
      m.makeRotationY(yaw).setPosition(x, y, z);
      P.setMatrixAt(k, m);
    }
    P.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.clearScapes();
    this.set([], []);
    this.markerMat.dispose();
    this.routeMat.dispose();
    this.material.dispose();
    this.personGeo.dispose();
  }
}

function scapeKey(t: TownBrief): string {
  return `${t.era}|${Math.round(Math.log2(1 + t.pop / 500))}|${t.buildings.map((b) => b[0]).join('.')}|${t.color}`;
}

// ------------------------------------------------------------ procedural town

const ROOF_TILE: RGB = [0.62, 0.3, 0.2];
const ROOF_SLATE: RGB = [0.32, 0.34, 0.38];
const THATCH: RGB = [0.66, 0.56, 0.32];
const MUD: RGB = [0.58, 0.46, 0.33];
const WOOD: RGB = [0.48, 0.36, 0.24];
const PLASTER: RGB = [0.86, 0.82, 0.74];
const STONE: RGB = [0.66, 0.63, 0.58];
const BRICK: RGB = [0.56, 0.32, 0.24];
const CONCRETE: RGB = [0.7, 0.7, 0.68];
const GLASS: RGB = [0.42, 0.55, 0.66];
const ROAD: RGB = [0.36, 0.34, 0.32];
const PAVED: RGB = [0.26, 0.26, 0.28];

/**
 * One merged mesh for a whole town, in a local frame (y up). `height(x, z)`
 * gives the ground; lots under water are skipped. Fills `walkers` with
 * residents' paths along the streets.
 */
function buildTown(
  t: TownBrief, rnd: () => number, radius: number, height: (x: number, z: number) => number, seaLocal: number,
  walkers: Scape['walkers'],
): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const era = t.era;
  const has = (id: string) => t.buildings.some(([i]) => BUILDING_ID[i] === id);
  const tint = new THREE.Color(t.color);
  const roofBase: RGB = era <= 1 ? THATCH : era <= 5 ? (rnd() < 0.6 ? ROOF_TILE : ROOF_SLATE) : ROOF_SLATE;
  // Regional style: roofs lean toward the nation's colour a little.
  const roof: RGB = [roofBase[0] * 0.8 + tint.r * 0.2, roofBase[1] * 0.8 + tint.g * 0.2, roofBase[2] * 0.8 + tint.b * 0.2];
  const wall: RGB = era <= 1 ? MUD : era <= 3 ? (rnd() < 0.5 ? MUD : PLASTER) : era <= 5 ? (rnd() < 0.5 ? STONE : PLASTER) : era <= 6 ? BRICK : CONCRETE;
  const lot = era <= 1 ? 13 : era <= 5 ? 16 : era <= 7 ? 22 : 30;
  const dry = (x: number, z: number) => height(x, z) > seaLocal + 0.6;
  const slopeOk = (x: number, z: number, r: number) => Math.abs(height(x + r, z) - height(x - r, z)) + Math.abs(height(x, z + r) - height(x, z - r)) < r * 1.2;
  // Streets every few lots; the main roads cross at the centre.
  const block = era <= 1 ? 0 : era <= 5 ? 3 : 4;
  const cells = Math.ceil(radius / lot);
  const lots: [number, number][] = [];
  for (let j = -cells; j <= cells; j++) {
    for (let i = -cells; i <= cells; i++) {
      const street = block > 0 && (i % block === 0 || j % block === 0);
      const jitter = era <= 1 ? lot * 0.4 : lot * 0.08;
      const x = i * lot + (rnd() - 0.5) * jitter, z = j * lot + (rnd() - 0.5) * jitter;
      const r = Math.hypot(x, z);
      if (r > radius) continue;
      if (street) {
        if (block > 0 && dry(x, z) && rnd() < 0.9) {
          const y = height(x, z);
          b.box(x, y + 0.05, z, i % block === 0 ? lot * 0.45 : lot * 1.02, 0.12, j % block === 0 ? lot * 0.45 : lot * 1.02, era >= 7 ? PAVED : ROAD);
        }
        continue;
      }
      // Denser in the centre; a few farmsteads further out.
      const dens = Math.exp(-((r / (radius * 0.62)) ** 2)) * 0.95 + 0.04;
      if (rnd() > dens) continue;
      if (!dry(x, z) || !slopeOk(x, z, lot * 0.4)) continue;
      lots.push([x, z]);
    }
  }
  // Landmarks take the central lots.
  lots.sort((a, c) => Math.hypot(a[0], a[1]) - Math.hypot(c[0], c[1]));
  const landmarks: string[] = [];
  for (const id of ['palace', 'cathedral', 'temple', 'castle', 'university_hall', 'library', 'market', 'mage_tower', 'shrine', 'observatory', 'theatre', 'bank', 'hospital', 'laboratory', 'station']) if (has(id)) landmarks.push(id);
  if (!landmarks.length && era <= 1) landmarks.push('fire');
  let li = 0;
  const cityCore = radius * 0.28;
  for (const [x, z] of lots) {
    const y = height(x, z);
    const r = Math.hypot(x, z);
    const yaw = era <= 1 ? rnd() * Math.PI : 0;
    if (li < landmarks.length && r < radius * 0.5) {
      landmark(b, landmarks[li++], x, y, z, lot, roof, rnd, era);
      continue;
    }
    if (era >= 7 && r < cityCore && (has('skyscraper') || era >= 8)) {
      const hgt = (30 + 170 * (1 - r / cityCore) ** 1.5) * (0.6 + 0.8 * rnd()) * (era >= 9 ? 1.4 : 1);
      tower(b, x, y, z, lot * 0.7, hgt, rnd);
      continue;
    }
    if (era <= 1) hut(b, x, y, z, 2.2 + rnd() * 1.6, wall, roof, yaw);
    else if (era <= 5) house(b, x, y, z, lot * (0.45 + 0.25 * rnd()), lot * (0.55 + 0.3 * rnd()), era <= 3 ? 2.6 : 3 + 3 * Math.floor(rnd() * (1 + (r < radius * 0.4 ? 2 : 0))), wall, roof, rnd() < 0.5);
    else if (era <= 7) house(b, x, y, z, lot * 0.8, lot * 0.85, 6 + 3 * Math.floor(rnd() * (r < radius * 0.5 ? 5 : 2)), wall, roof, false);
    else house(b, x, y, z, lot * 0.55, lot * 0.6, 4 + 3 * Math.floor(rnd() * 2), rnd() < 0.5 ? PLASTER : CONCRETE, ROOF_SLATE, rnd() < 0.6);
  }
  // Industry on the edge.
  const edge = (k: number): [number, number] => {
    const a = rnd() * Math.PI * 2;
    const r = radius * (0.85 + 0.2 * k);
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const nFactory = t.buildings.filter(([i]) => BUILDING_ID[i] === 'factory' || BUILDING_ID[i] === 'power_plant').reduce((s, [, c]) => s + c, 0);
  for (let k = 0; k < Math.min(6, nFactory); k++) {
    const [x, z] = edge(k * 0.2);
    if (!dry(x, z)) continue;
    factory(b, x, height(x, z), z, rnd);
  }
  if (has('nuclear_plant')) {
    const [x, z] = edge(0.6);
    if (dry(x, z)) coolingTower(b, x, height(x, z), z);
  }
  if (has('solar_farm')) {
    const [x, z] = edge(0.9);
    for (let i = 0; i < 24; i++) {
      const px = x + (i % 6) * 9, pz = z + Math.floor(i / 6) * 6;
      if (dry(px, pz)) b.box(px, height(px, pz) + 1, pz, 7, 0.2, 3.5, [0.15, 0.2, 0.35]);
    }
  }
  if (has('stone_circle')) {
    const [x, z] = edge(0.4);
    if (dry(x, z)) stoneCircle(b, x, height(x, z), z, rnd);
  }
  if (has('spaceport')) {
    const [x, z] = edge(1.6);
    if (dry(x, z)) launchPad(b, x, height(x, z), z);
  }
  if (has('space_elevator')) {
    b.limb([0, height(0, 0), 0], [0, height(0, 0) + 3000, 0], 6, 2, 6, [0.8, 0.82, 0.86], true);
  }
  // City walls.
  if ((has('walls') || has('castle')) && era >= 2 && era <= 6) {
    const wr = radius * 0.78;
    const segs = Math.max(16, Math.round(wr / 12));
    for (let k = 0; k < segs; k++) {
      const a0 = (k / segs) * Math.PI * 2, a1 = ((k + 1) / segs) * Math.PI * 2;
      const x0 = Math.cos(a0) * wr, z0 = Math.sin(a0) * wr, x1 = Math.cos(a1) * wr, z1 = Math.sin(a1) * wr;
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      if (!dry(mx, mz)) continue;
      const y = height(mx, mz);
      b.limb([x0, y + 3, z0], [x1, y + 3, z1], 1.6, 1.6, 4, STONE, false);
      if (k % 6 === 0) b.box(x0, y + 5, z0, 5, 10, 5, shade(STONE, 0.9));
    }
  }
  // Fields and residents.
  const nWalk = Math.min(RESIDENTS, Math.max(4, Math.round(Math.sqrt(t.pop) / 3)));
  for (let k = 0; k < nWalk && lots.length > 1; k++) {
    const a = lots[Math.floor(rnd() * Math.min(lots.length, 60))];
    const c = lots[Math.floor(rnd() * Math.min(lots.length, 60))];
    // Walk along the street between the two lots (offset to the lot edge).
    walkers.push({ ax: a[0] + lot * 0.5, az: a[1], bx: c[0] + lot * 0.5, bz: c[1], t: rnd() * 2, speed: 1.1 + rnd() * 0.6 });
  }
  const tpl = b.build();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tpl.pos, 3));
  const col = new Uint8Array(tpl.col.length);
  for (let i = 0; i < col.length; i++) col[i] = Math.max(0, Math.min(255, tpl.col[i] * 255));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  g.computeBoundingSphere();
  return g;
}

function hut(b: MeshBuilder, x: number, y: number, z: number, r: number, wall: RGB, roof: RGB, phase: number): void {
  b.limb([x, y - 0.5, z], [x, y + 1.6, z], r, r, 7, wall, false);
  b.cone(x, z, y + 1.6, r * 1.1, r * 1.25, 7, roof, phase);
}

function house(b: MeshBuilder, x: number, y: number, z: number, w: number, d: number, h: number, wall: RGB, roof: RGB, gableX: boolean): void {
  // Foundation reaches below uneven ground.
  b.box(x, y + h / 2 - 1, z, w, h + 2, d, wall);
  const top = y + h;
  const rh = Math.min(w, d) * 0.45;
  if (gableX) {
    b.quad([x - w / 2 - 0.3, top, z - d / 2 - 0.3], [x - w / 2 - 0.3, top, z + d / 2 + 0.3], [x, top + rh, z + d / 2 + 0.3], [x, top + rh, z - d / 2 - 0.3], roof);
    b.quad([x + w / 2 + 0.3, top, z + d / 2 + 0.3], [x + w / 2 + 0.3, top, z - d / 2 - 0.3], [x, top + rh, z - d / 2 - 0.3], [x, top + rh, z + d / 2 + 0.3], shade(roof, 0.85));
    b.tri([x - w / 2, top, z + d / 2], [x + w / 2, top, z + d / 2], [x, top + rh, z + d / 2], wall);
    b.tri([x + w / 2, top, z - d / 2], [x - w / 2, top, z - d / 2], [x, top + rh, z - d / 2], wall);
  } else {
    b.quad([x - w / 2 - 0.3, top, z + d / 2 + 0.3], [x + w / 2 + 0.3, top, z + d / 2 + 0.3], [x + w / 2 + 0.3, top + rh, z], [x - w / 2 - 0.3, top + rh, z], roof);
    b.quad([x + w / 2 + 0.3, top, z - d / 2 - 0.3], [x - w / 2 - 0.3, top, z - d / 2 - 0.3], [x - w / 2 - 0.3, top + rh, z], [x + w / 2 + 0.3, top + rh, z], shade(roof, 0.85));
    b.tri([x + w / 2, top, z + d / 2], [x + w / 2, top, z - d / 2], [x + w / 2, top + rh, z], wall);
    b.tri([x - w / 2, top, z - d / 2], [x - w / 2, top, z + d / 2], [x - w / 2, top + rh, z], wall);
  }
}

function tower(b: MeshBuilder, x: number, y: number, z: number, w: number, h: number, rnd: () => number): void {
  const glass: RGB = rnd() < 0.5 ? GLASS : shade(CONCRETE, 0.9);
  b.box(x, y + h / 2 - 1, z, w, h + 2, w, glass);
  // Floors as darker bands every ~4 storeys.
  for (let f = 12; f < h; f += 12) b.box(x, y + f, z, w + 0.3, 0.6, w + 0.3, shade(glass, 0.7));
  if (rnd() < 0.4) b.box(x, y + h + 3, z, w * 0.5, 6, w * 0.5, shade(glass, 0.8));
  if (rnd() < 0.3) b.limb([x, y + h, z], [x, y + h + 18, z], 0.4, 0.1, 4, [0.8, 0.8, 0.8], true);
}

function factory(b: MeshBuilder, x: number, y: number, z: number, rnd: () => number): void {
  b.box(x, y + 4, z, 40, 10, 24, BRICK);
  for (let k = 0; k < 4; k++) b.quad([x - 20 + k * 10, y + 9, z - 12], [x - 20 + k * 10, y + 9, z + 12], [x - 12 + k * 10, y + 13, z + 12], [x - 12 + k * 10, y + 13, z - 12], ROOF_SLATE);
  const n = 1 + Math.floor(rnd() * 3);
  for (let k = 0; k < n; k++) b.limb([x + 14 - k * 7, y + 8, z + 8], [x + 14 - k * 7, y + 38, z + 8], 1.6, 1.1, 6, shade(BRICK, 0.8), true);
}

function coolingTower(b: MeshBuilder, x: number, y: number, z: number): void {
  b.limb([x, y - 1, z], [x, y + 40, z], 26, 16, 10, CONCRETE, false);
  b.limb([x, y + 40, z], [x, y + 70, z], 16, 19, 10, CONCRETE, false);
}

function stoneCircle(b: MeshBuilder, x: number, y: number, z: number, rnd: () => number): void {
  const n = 12;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const px = x + Math.cos(a) * 14, pz = z + Math.sin(a) * 14;
    b.box(px, y + 2, pz, 1.4, 5 + rnd(), 0.9, [0.55, 0.54, 0.5]);
    if (k % 2 === 0) {
      const a2 = ((k + 1) / n) * Math.PI * 2;
      b.limb([px, y + 4.8, pz], [x + Math.cos(a2) * 14, y + 4.8, z + Math.sin(a2) * 14], 0.5, 0.5, 4, [0.52, 0.51, 0.48], false);
    }
  }
  b.box(x, y + 2.5, z, 1.2, 6, 1.2, [0.5, 0.48, 0.45]);
}

function launchPad(b: MeshBuilder, x: number, y: number, z: number): void {
  b.box(x, y, z, 60, 2, 60, CONCRETE);
  b.box(x + 10, y + 30, z, 4, 60, 4, [0.7, 0.2, 0.15]);
  b.limb([x, y + 1, z], [x, y + 50, z], 3.5, 3.5, 8, [0.94, 0.94, 0.92], false);
  b.cone(x, z, y + 50, 12, 3.5, 8, [0.9, 0.9, 0.9]);
}

function landmark(b: MeshBuilder, id: string, x: number, y: number, z: number, lot: number, roof: RGB, rnd: () => number, era: number): void {
  const w = lot * 1.6;
  switch (id) {
    case 'fire':
      b.cone(x, z, y, 1.2, 0.8, 5, [0.95, 0.5, 0.15]);
      for (let k = 0; k < 6; k++) b.box(x + Math.cos(k) * 1.4, y + 0.2, z + Math.sin(k) * 1.4, 0.6, 0.4, 0.6, [0.4, 0.38, 0.35]);
      break;
    case 'shrine':
      b.box(x, y + 1, z, 5, 3, 5, WOOD);
      b.cone(x, z, y + 2.5, 3, 4.5, 4, roof, 0.5);
      break;
    case 'temple':
      if (era <= 3) {
        // Stepped platform.
        for (let k = 0; k < 4; k++) b.box(x, y + k * 3 + 1, z, w * (1 - k * 0.2), 3.2, w * (1 - k * 0.2), shade(STONE, 1 - k * 0.04));
        b.box(x, y + 14, z, w * 0.3, 4, w * 0.3, PLASTER);
      } else {
        b.box(x, y + 1, z, w, 2, w * 1.5, STONE);
        for (let k = 0; k < 6; k++) for (const side of [-1, 1]) b.limb([x + side * w * 0.42, y + 2, z - w * 0.65 + k * w * 0.26], [x + side * w * 0.42, y + 11, z - w * 0.65 + k * w * 0.26], 0.7, 0.6, 6, PLASTER, true);
        b.box(x, y + 11.5, z, w, 1.2, w * 1.5, STONE);
        house(b, x, y + 12, z, w, w * 1.5, 0.1, STONE, shade(STONE, 0.95), false);
      }
      break;
    case 'palace':
      b.box(x, y + 6, z, w * 1.6, 12, w * 1.1, PLASTER);
      house(b, x, y + 11, z, w * 1.6, w * 1.1, 0.1, PLASTER, roof, true);
      for (const s of [-1, 1]) b.box(x + s * w * 0.9, y + 9, z, w * 0.35, 18, w * 0.35, shade(PLASTER, 0.95));
      break;
    case 'castle':
      b.box(x, y + 7, z, w, 14, w, STONE);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        b.limb([x + sx * w * 0.5, y - 1, z + sz * w * 0.5], [x + sx * w * 0.5, y + 20, z + sz * w * 0.5], 3, 3, 8, shade(STONE, 0.92), false);
        b.cone(x + sx * w * 0.5, z + sz * w * 0.5, y + 20, 7, 3.6, 8, ROOF_SLATE);
      }
      b.box(x, y + 18, z, w * 0.4, 12, w * 0.4, shade(STONE, 0.96));
      break;
    case 'cathedral':
      b.box(x, y + 10, z, w * 0.7, 20, w * 1.8, STONE);
      house(b, x, y + 19, z, w * 0.7, w * 1.8, 0.1, STONE, ROOF_SLATE, false);
      b.box(x, y + 20, z + w * 0.9, w * 0.4, 40, w * 0.4, STONE);
      b.cone(x, z + w * 0.9, y + 40, 22, w * 0.25, 4, ROOF_SLATE, 0.5);
      break;
    case 'mage_tower':
      b.limb([x, y - 1, z], [x, y + 36, z], 5, 3.5, 8, [0.42, 0.36, 0.55], false);
      b.cone(x, z, y + 36, 12, 5, 8, [0.3, 0.22, 0.5]);
      b.blob(x, y + 50, z, 1.2, 1.2, 1.2, [0.7, 0.5, 1], rnd, 0.1);
      break;
    case 'observatory':
      b.limb([x, y - 1, z], [x, y + 8, z], 6, 6, 10, PLASTER, false);
      b.blob(x, y + 8, z, 6, 5, 6, [0.86, 0.86, 0.9], rnd, 0.02);
      break;
    case 'market':
      for (let k = 0; k < 6; k++) {
        const px = x + ((k % 3) - 1) * 5, pz = z + (Math.floor(k / 3) - 0.5) * 6;
        b.box(px, y + 1, pz, 3.6, 2, 3, WOOD);
        b.quad([px - 2, y + 2.6, pz - 1.8], [px - 2, y + 2.6, pz + 1.8], [px + 2, y + 3.2, pz + 1.8], [px + 2, y + 3.2, pz - 1.8], [0.8 - k * 0.05, 0.3 + k * 0.08, 0.25]);
      }
      break;
    case 'station':
      b.box(x, y + 5, z, w * 2, 10, w * 0.8, BRICK);
      b.limb([x - w, y + 10, z], [x + w, y + 10, z], w * 0.42, w * 0.42, 6, [0.4, 0.42, 0.45], false);
      break;
    default: {
      // Libraries, universities, theatres, banks, hospitals, laboratories: a large civic block.
      const h = era >= 7 ? 22 + rnd() * 30 : 10 + rnd() * 6;
      const c = era >= 7 ? CONCRETE : STONE;
      b.box(x, y + h / 2 - 1, z, w, h + 2, w * 0.9, c);
      if (era < 7) {
        for (let k = 0; k < 5; k++) b.limb([x - w * 0.4 + k * w * 0.2, y + 1, z + w * 0.47], [x - w * 0.4 + k * w * 0.2, y + h * 0.8, z + w * 0.47], 0.5, 0.45, 6, PLASTER, true);
        b.cone(x, z, y + h, 4, w * 0.25, 8, roof);
      }
    }
  }
}
