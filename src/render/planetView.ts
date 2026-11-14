import * as THREE from 'three';
import type { MeshPayload } from '../worker/protocol';
import { Explorer, type ExploreMode, type ExploreStatus } from './explorer';
import { Avatar } from './surface/avatar';
import { Fauna } from './surface/fauna';
import type { BiomeLook } from './surface/looks';
import { newSample, type SurfaceSampler } from './surface/sampler';
import { horizonColor, makeStarField, Sky } from './surface/sky';
import { SurfaceTerrain } from './surface/terrain';
import { tangentFrame } from './surface/vegetation';

/**
 * The planet from orbit down to the ground, in planet-centred metres.
 *
 * From far away the simulation's own cells are drawn as a low-poly globe (one
 * mesh; switching map layers only rewrites its colour buffer). Closer in, a
 * continuous level-of-detail terrain takes over, with seas, forests, rocks,
 * grass and animals near the ground, a sky with day and night, and fog. The
 * explorer moves the camera: an orbit camera, or a walking player.
 */

/** Above this altitude the cell globe is shown, below it the continuous terrain. */
const HEX_ALT = 2_200_000;
/** Animals are simulated and drawn below this altitude. */
const FAUNA_ALT = 3_000;

export interface ViewStatus extends ExploreStatus {
  /** Biome index under the observer (-1 if unknown). */
  biome: number;
  /** Air temperature (annual mean) at the observer, °C. */
  tempC: number;
  surface: boolean;
  animals: number;
  chunks: number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class PlanetView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  readonly explorer: Explorer;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly fog = new THREE.Fog(0x9fb8d8, 1e11, 1e12);

  private readonly globe = new THREE.Group();
  private planet: THREE.Mesh | null = null;
  private marker: THREE.LineLoop | null = null;
  private mesh: MeshPayload | null = null;
  private readonly atmosphere: THREE.Mesh;
  private readonly atmoUniforms = { uFade: { value: 1 } };
  private readonly stars: THREE.Points;
  private readonly sky = new Sky();
  private readonly terrain = new SurfaceTerrain();
  private readonly fauna = new Fauna();
  private readonly avatar = new Avatar();
  private sampler: SurfaceSampler | null = null;
  private readonly probe = newSample();

  private positions: Float32Array = new Float32Array(0);
  private colors: Uint8Array = new Uint8Array(0);
  private vertexCell: Int32Array = new Int32Array(0);
  private cellVertStart: Int32Array = new Int32Array(0);
  private triangleCell: Int32Array = new Int32Array(0);
  private cellRadius: Float32Array = new Float32Array(0);
  private faceRadius: Float32Array = new Float32Array(0);

  private subsolarLat = 0;
  private exUser = 30;
  private surfaceOn = false;
  private dirty = true;
  private raf = 0;
  private last = performance.now();
  private readonly resizeObserver: ResizeObserver;
  private readonly sunDir = new THREE.Vector3(1, 0, 0);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly basis = new THREE.Matrix4();
  private readonly e = new Float64Array(3);
  private readonly n = new Float64Array(3);
  private readonly fogColor = new THREE.Color();
  /** Frames per second, measured over the last second. */
  fps = 0;
  private frames = 0;
  private fpsT0 = performance.now();

  constructor(private readonly canvas: HTMLCanvasElement) {
    THREE.ColorManagement.enabled = false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x05070d);

    // Logarithmic depth: 10 cm in front of the player and the far side of the planet in one buffer.
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2e8);
    this.explorer = new Explorer(canvas, this.camera);

    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 2.7);
    this.scene.add(this.sunLight);
    // Ground bounce: brown-green, bright enough that the undersides of leaves are not black.
    this.hemi = new THREE.HemisphereLight(0xbcd2ff, 0x5a5440, 1.25);
    this.scene.add(this.hemi);
    this.scene.fog = this.fog;

    this.stars = makeStarField();
    this.scene.add(this.stars);
    this.scene.add(this.sky.mesh);
    this.atmosphere = makeAtmosphere(this.atmoUniforms);
    this.globe.add(this.atmosphere);
    this.scene.add(this.globe);
    this.scene.add(this.terrain.group);
    this.scene.add(this.fauna.group);
    this.avatar.root.visible = false;
    this.scene.add(this.avatar.root);
    this.setScale(6.371e6);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  set onMode(fn: ((mode: ExploreMode) => void) | undefined) {
    this.explorer.onMode = fn;
  }

  private setScale(R: number): void {
    this.globe.scale.setScalar(R);
    this.explorer.setRadius(R);
  }

  setMesh(mesh: MeshPayload): void {
    this.mesh = mesh;
    this.setScale(mesh.radiusKm * 1000);
    // A new world: forget the old surface until its data arrives.
    this.sampler = null;
    this.explorer.sampler = null;
    if (this.explorer.mode === 'walk') this.explorer.exitWalk();
    this.terrain.reset();
    this.fauna.clear();

    const n = mesh.count;
    const ringLen = mesh.ring.length;
    const vCount = n + ringLen;
    this.cellVertStart = new Int32Array(n + 1);
    this.vertexCell = new Int32Array(vCount);
    this.triangleCell = new Int32Array(ringLen);
    const index = new Uint32Array(ringLen * 3);
    let v = 0;
    let t = 0;
    for (let i = 0; i < n; i++) {
      const s = mesh.ringStart[i];
      const d = mesh.ringStart[i + 1] - s;
      this.cellVertStart[i] = v;
      const base = v;
      for (let k = 0; k <= d; k++) this.vertexCell[v++] = i;
      for (let k = 0; k < d; k++) {
        index[t * 3] = base;
        index[t * 3 + 1] = base + 1 + k;
        index[t * 3 + 2] = base + 1 + ((k + 1) % d);
        this.triangleCell[t++] = i;
      }
    }
    this.cellVertStart[n] = v;

    this.positions = new Float32Array(vCount * 3);
    this.colors = new Uint8Array(vCount * 3).fill(128);
    this.cellRadius = new Float32Array(n).fill(1);
    this.faceRadius = new Float32Array(mesh.faces.length / 3).fill(1);

    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3, true));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.1);

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    if (this.planet) {
      this.globe.remove(this.planet);
      this.planet.geometry.dispose();
      (this.planet.material as THREE.Material).dispose();
    }
    this.planet = new THREE.Mesh(geo, mat);
    this.globe.add(this.planet);
    this.writePositions();
    this.setMarker(-1);
  }

  /** Continuous surface for the close-up view; `cellRgb` paints a data layer instead of natural colours. */
  setSurface(sampler: SurfaceSampler, looks: BiomeLook[], seed: number, cellRgb: Uint8Array | null): void {
    this.sampler = sampler;
    this.explorer.sampler = sampler;
    this.terrain.setData(sampler, looks, seed, cellRgb);
    this.fauna.setWorld(sampler, looks, seed);
    this.dirty = true;
  }

  get hasSurface(): boolean {
    return this.sampler !== null;
  }

  /** Diagnostics for development. */
  debug(): Record<string, unknown> {
    const c = this.camera.position;
    return {
      frameMs: this.frameMs.map((v) => Math.round(v * 10) / 10),
      terrain: this.terrain.stats,
      animals: this.fauna.count,
      mode: this.explorer.mode,
      cam: [c.x, c.y, c.z].map(Math.round),
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  /** Displace land by elevation; the sea surface stays at the planet radius. */
  setRelief(elevation: Float32Array, seaLevel: number, exaggeration = 30): void {
    this.exUser = Math.max(1, exaggeration);
    const m = this.mesh;
    if (!m) return;
    const k = exaggeration / (m.radiusKm * 1000);
    for (let i = 0; i < m.count; i++) {
      const h = elevation[i] - seaLevel;
      this.cellRadius[i] = h > 0 ? 1 + h * k : 1;
    }
    const f = m.faces;
    for (let j = 0; j < this.faceRadius.length; j++) {
      this.faceRadius[j] = (this.cellRadius[f[j * 3]] + this.cellRadius[f[j * 3 + 1]] + this.cellRadius[f[j * 3 + 2]]) / 3;
    }
    this.writePositions();
  }

  private writePositions(): void {
    const m = this.mesh;
    if (!m || !this.planet) return;
    const P = this.positions;
    for (let i = 0; i < m.count; i++) {
      let v = this.cellVertStart[i];
      const r = this.cellRadius[i];
      P[v * 3] = m.pos[i * 3] * r;
      P[v * 3 + 1] = m.pos[i * 3 + 1] * r;
      P[v * 3 + 2] = m.pos[i * 3 + 2] * r;
      v++;
      for (let k = m.ringStart[i]; k < m.ringStart[i + 1]; k++, v++) {
        const face = m.ring[k];
        const fr = this.faceRadius[face];
        P[v * 3] = m.faceCenter[face * 3] * fr;
        P[v * 3 + 1] = m.faceCenter[face * 3 + 1] * fr;
        P[v * 3 + 2] = m.faceCenter[face * 3 + 2] * fr;
      }
    }
    const attr = this.planet.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    if (this.marker) this.setMarker(this.markerCell);
    this.dirty = true;
  }

  /** Per-cell RGB bytes (3 per cell). */
  setCellColors(rgb: Uint8Array): void {
    if (!this.planet) return;
    const C = this.colors;
    const vc = this.vertexCell;
    for (let v = 0; v < vc.length; v++) {
      const c = vc[v] * 3;
      C[v * 3] = rgb[c];
      C[v * 3 + 1] = rgb[c + 1];
      C[v * 3 + 2] = rgb[c + 2];
    }
    (this.planet.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.dirty = true;
  }

  /** Latitude (radians) where the sun is overhead; shows the seasons. */
  setSubsolarLatitude(lat: number): void {
    if (lat !== this.subsolarLat) {
      this.subsolarLat = lat;
      this.dirty = true;
    }
  }

  /** Cell under a client-space point, or -1. */
  pickCell(clientX: number, clientY: number): number {
    if (this.globe.visible && this.planet) {
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = this.raycaster.intersectObject(this.planet, false)[0];
      if (!hit || hit.faceIndex == null) return -1;
      return this.triangleCell[hit.faceIndex] ?? -1;
    }
    const d = this.explorer.rayToSurface(clientX, clientY);
    return d && this.sampler ? this.sampler.nearestCell(d[0], d[1], d[2]) : -1;
  }

  /** Cell the player stands on (or the camera looks at). */
  observerCell(): number {
    const o = this.explorer.observer();
    return this.sampler ? this.sampler.nearestCell(o[0], o[1], o[2]) : -1;
  }

  private markerCell = -1;
  /** Outline a cell (or remove the outline with -1). Shown on the globe only. */
  setMarker(cell: number): void {
    this.markerCell = cell;
    if (this.marker) {
      this.globe.remove(this.marker);
      this.marker.geometry.dispose();
      (this.marker.material as THREE.Material).dispose();
      this.marker = null;
    }
    const m = this.mesh;
    if (!m || cell < 0) {
      this.dirty = true;
      return;
    }
    const s = this.cellVertStart[cell] + 1;
    const e = this.cellVertStart[cell + 1];
    const pts = new Float32Array((e - s) * 3);
    for (let v = s; v < e; v++) {
      const o = (v - s) * 3;
      pts[o] = this.positions[v * 3] * 1.002;
      pts[o + 1] = this.positions[v * 3 + 1] * 1.002;
      pts[o + 2] = this.positions[v * 3 + 2] * 1.002;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.marker = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, fog: false }));
    this.marker.renderOrder = 10;
    this.globe.add(this.marker);
    this.dirty = true;
  }

  // ------------------------------------------------------------ explorer shortcuts

  descend(): void {
    this.explorer.descend();
  }

  ascend(): void {
    this.explorer.ascend();
  }

  setTimeOfDay(hours: number): void {
    this.explorer.tod = ((hours % 24) + 24) % 24;
    this.dirty = true;
  }

  setTimeFlows(on: boolean): void {
    this.explorer.timeFlows = on;
  }

  status(): ViewStatus {
    const st = this.explorer.status();
    let biome = -1;
    let tempC = NaN;
    if (this.sampler) {
      const o = this.explorer.observer();
      this.sampler.sample(o[0], o[1], o[2], 0, this.probe);
      biome = this.probe.biome === 255 ? -1 : this.probe.biome;
      tempC = this.probe.temp;
    }
    return { ...st, biome, tempC, surface: this.surfaceOn, animals: this.fauna.count, chunks: this.terrain.stats.chunks };
  }

  // ------------------------------------------------------------ frame

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Time spent in the last frame (ms): [total, terrain, render]. */
  frameMs = [0, 0, 0];

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.frame(now);
  };

  /** Run `n` frames now, 1/60 s apart (development: drive the view while the page is in the background). */
  runFrames(n: number): void {
    let t = this.last;
    for (let i = 0; i < n; i++) this.frame((t += 1000 / 60));
  }

  private frame(now: number): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const ex = this.explorer;
    const R = ex.radiusM;
    const sea = this.sampler?.seaLevel ?? 0;

    // Relief exaggeration fades out toward the ground, where the real scale matters.
    const alt0 = this.camera.position.length() - R - Math.max(0, sea);
    const exg = 1 + (this.exUser - 1) * smoothstep(20_000, 3_000_000, alt0);
    ex.exaggeration = exg;
    this.terrain.uniforms.uExag.value = exg;
    this.terrain.vegetationVisible = exg < 1.01;
    ex.update(dt);
    const cam = this.camera.position;
    const alt = cam.length() - R - Math.max(0, sea);

    const surfaceOn = this.terrain.ready && (alt < HEX_ALT || ex.mode === 'walk');
    if (surfaceOn !== this.surfaceOn) this.dirty = true;
    this.surfaceOn = surfaceOn;
    this.globe.visible = true;
    if (this.planet) this.planet.visible = !this.surfaceOn;
    if (this.marker) this.marker.visible = !this.surfaceOn;
    this.terrain.group.visible = this.surfaceOn;
    const tt = performance.now();
    if (this.surfaceOn) this.terrain.update(this.camera, ex.active || ex.mode === 'walk' ? 5 : 9);
    this.frameMs[1] = performance.now() - tt;
    this.terrain.uniforms.uTime.value = now / 1000;

    // Sun: overhead at the season's latitude and at the longitude where it is noon.
    const obs = ex.observer();
    const lonObs = Math.atan2(obs[2], obs[0]);
    const sunLon = lonObs - ((ex.tod - 12) / 24) * Math.PI * 2;
    const lat = this.subsolarLat;
    this.sunDir.set(Math.cos(lat) * Math.cos(sunLon), Math.sin(lat), Math.cos(lat) * Math.sin(sunLon));
    this.up.copy(cam).normalize();
    const sunE = this.sunDir.dot(this.up);
    const space = smoothstep(15_000, 120_000, alt);
    const day = smoothstep(-0.2, 0.15, sunE);

    this.sunLight.position.copy(this.sunDir);
    const groundSun = smoothstep(-0.08, 0.06, sunE);
    this.sunLight.intensity = 2.7 * (space + (1 - space) * groundSun);
    const warm = (1 - smoothstep(0.02, 0.3, sunE)) * (1 - space);
    this.sunLight.color.setRGB(1, 0.96 - 0.3 * warm, 0.88 - 0.5 * warm);
    this.hemi.position.copy(this.up);
    // Night keeps a bluish moonlight so the land stays readable.
    this.hemi.intensity = space * 1.25 + (1 - space) * (0.8 + 0.4 * day);
    this.hemi.color.setRGB(0.74 - 0.36 * (1 - day) * (1 - space), 0.82 - 0.32 * (1 - day) * (1 - space), 1);

    this.sky.update(cam, this.sunDir, this.up, space);
    this.stars.position.copy(cam);
    this.atmoUniforms.uFade.value = smoothstep(60_000, 400_000, alt);
    this.atmosphere.visible = this.atmoUniforms.uFade.value > 0.001;

    // Haze near the ground, gone by the edge of space.
    if (this.surfaceOn && alt < 80_000) {
      horizonColor(sunE, this.fogColor);
      this.fog.color.copy(this.fogColor);
      const far = 32_000 + alt * 22;
      this.fog.far = far / Math.max(1e-3, 1 - smoothstep(30_000, 80_000, alt));
      this.fog.near = far * 0.12;
    } else {
      this.fog.near = 1e11;
      this.fog.far = 1e12;
    }

    // Animals and the player's body.
    const faunaOn = this.surfaceOn && alt < FAUNA_ALT && exg < 1.01;
    const obsH = ex.mode === 'walk' ? ex.playerH : this.sampler ? this.sampler.heightAt(obs[0], obs[1], obs[2], 2) : 0;
    this.fauna.update(dt, now / 1000, obs, obsH, faunaOn);
    const walking = ex.mode === 'walk';
    this.avatar.root.visible = walking && ex.camDist >= 1.2;
    if (walking) {
      const p = ex.player;
      const r = R + ex.playerH;
      this.avatar.root.position.set(p[0] * r, p[1] * r, p[2] * r);
      tangentFrame(p, this.e, this.n, -ex.yaw);
      this.basis.makeBasis(
        new THREE.Vector3(this.e[0], this.e[1], this.e[2]),
        new THREE.Vector3(p[0], p[1], p[2]),
        new THREE.Vector3(this.n[0], this.n[1], this.n[2]),
      );
      this.avatar.root.quaternion.setFromRotationMatrix(this.basis);
      this.avatar.animate(dt, ex.speed, !ex.onGround && !ex.swimming && !ex.flying, ex.swimming);
    }

    const live = this.surfaceOn && alt < 60_000;
    if (this.dirty || ex.active || live || this.terrain.stats.pending > 0) {
      const tr = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.frameMs[2] = performance.now() - tr;
      this.dirty = false;
      ex.active = false;
      this.frames++;
    }
    this.frameMs[0] = performance.now() - t0;
    if (now - this.fpsT0 >= 1000) {
      this.fps = (this.frames * 1000) / (now - this.fpsT0);
      this.frames = 0;
      this.fpsT0 = now;
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.explorer.dispose();
    this.terrain.dispose();
    this.fauna.dispose();
    this.avatar.dispose();
    this.renderer.dispose();
  }
}

function makeAtmosphere(uniforms: { uFade: { value: number } }): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 wp = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-wp.xyz);
        gl_Position = projectionMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform float uFade;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        #include <logdepthbuf_fragment>
        float rim = pow(clamp(0.72 + dot(vNormal, vView), 0.0, 1.0), 4.0);
        gl_FragColor = vec4(0.35, 0.6, 1.0, 1.0) * rim * 0.9 * uFade;
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1.09, 64, 32), mat);
}
