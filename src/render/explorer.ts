import * as THREE from 'three';
import type { SurfaceSampler } from './surface/sampler';
import { tangentFrame } from './surface/vegetation';

/**
 * Camera and player control, in planet-centred metres.
 *
 * - orbit: a Google-Earth-like camera around a focus point on the surface.
 *   Drag pans, the wheel zooms, right-drag (or Shift+drag) turns and tilts.
 *   Close to the ground the view tilts toward the horizon by itself; zooming
 *   all the way in sets the player down.
 * - walk: third-person (or first-person when zoomed in) open-world control.
 *   WASD moves, Shift runs, Space jumps, F toggles flight, drag looks around,
 *   Esc or zooming far out returns to orbit.
 */

export type ExploreMode = 'orbit' | 'walk';

export interface ExploreStatus {
  mode: ExploreMode;
  /** Camera height above sea level, m. */
  altitudeM: number;
  /** Ground under the focus / player, m above sea level. */
  groundM: number;
  latDeg: number;
  lonDeg: number;
  flying: boolean;
  swimming: boolean;
  /** Local solar time, hours. */
  tod: number;
  speed: number;
}

const WALK = 4.2;
const RUN = 11;
const SWIM = 2.2;
const FLY = 60;
const FLY_FAST = 900;
const GRAVITY = 22;
const JUMP = 7.5;
const EYE = 1.62;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Explorer {
  mode: ExploreMode = 'orbit';
  radiusM = 6.371e6;
  sampler: SurfaceSampler | null = null;
  /** Relief exaggeration in effect at the current altitude. */
  exaggeration = 1;

  // orbit state
  readonly focus = new Float64Array([0.35, 0.45, 0.82].map((v, _, a) => v / Math.hypot(a[0], a[1], a[2])));
  dist = 2.4 * 6.371e6;
  heading = 0;
  tiltUser = 0;
  private flyTarget: Float64Array | null = null;
  private flyDist = 0;
  private flyRate = 4;
  /** Set the player down when the current flight ends. */
  private landing = false;

  // walk state
  readonly player = new Float64Array(3);
  playerH = 0;
  private vz = 0;
  yaw = 0;
  camYaw = 0;
  camPitch = 0.28;
  camDist = 7;
  flying = false;
  swimming = false;
  onGround = true;
  speed = 0;

  /** Local solar time (hours) and its rate (hours per real second) while walking. */
  tod = 10;
  todRate = 24 / (14 * 60);
  timeFlows = true;

  readonly keys = new Set<string>();
  private drag: { x: number; y: number; button: number; shift: boolean } | null = null;
  private readonly e = new Float64Array(3);
  private readonly n = new Float64Array(3);
  private readonly up = new THREE.Vector3();
  /** Called when the mode changes. */
  onMode?: (mode: ExploreMode) => void;
  /** True while something moves (the view must keep rendering). */
  active = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly camera: THREE.PerspectiveCamera) {
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', this.onDblClick);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  setRadius(r: number): void {
    if (Math.abs(r - this.radiusM) < 1) return;
    this.dist *= r / this.radiusM;
    this.radiusM = r;
  }

  // ------------------------------------------------------------ ground

  private sea(): number {
    return this.sampler?.seaLevel ?? 0;
  }

  /** Visible surface radius at a direction (sea surface over water, exaggerated land). */
  private surfaceR(x: number, y: number, z: number, minWave: number): number {
    const R = this.radiusM;
    if (!this.sampler) return R;
    const sea = this.sampler.seaLevel;
    const h = this.sampler.heightAt(x, y, z, minWave);
    return R + sea + Math.max(0, h - sea) * this.exaggeration;
  }

  // ------------------------------------------------------------ input

  /** Keys typed into a text field are not movement. */
  private typing(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    if (t.tagName === 'INPUT') {
      const type = (t as HTMLInputElement).type;
      return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button';
    }
    return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
  }

  private onDown = (e: PointerEvent): void => {
    this.drag = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey || e.ctrlKey };
    this.canvas.setPointerCapture?.(e.pointerId);
    this.flyTarget = null;
    this.landing = false;
  };

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (this.mode === 'walk') {
      this.camYaw += dx * 0.0045;
      this.camPitch = Math.max(-0.45, Math.min(1.45, this.camPitch + dy * 0.0035));
      this.active = true;
      return;
    }
    if (d.button === 2 || d.button === 1 || d.shift) {
      this.heading += dx * 0.005;
      this.tiltUser = Math.max(-1.3, Math.min(1.4, this.tiltUser + dy * 0.004));
    } else {
      const h = this.canvas.clientHeight || 1;
      const mpp = (2 * this.dist * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
      this.pan(-dx * mpp, dy * mpp);
    }
    this.active = true;
  };

  private onUp = (e: PointerEvent): void => {
    this.drag = null;
    this.canvas.releasePointerCapture?.(e.pointerId);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const dy = Math.max(-300, Math.min(300, e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY));
    this.flyTarget = null;
    this.landing = false;
    if (this.mode === 'walk') {
      this.camDist = Math.max(0.5, Math.min(90, this.camDist * Math.exp(dy * 0.0015)));
      if (this.camDist >= 90 && dy > 0) this.exitWalk();
    } else {
      // Without surface data the planet is only the coarse cell mesh: stay in orbit.
      const minD = this.sampler ? 12 : 0.04 * this.radiusM;
      const next = this.dist * Math.exp(dy * 0.0022);
      if (next < minD && dy < 0 && this.sampler) {
        this.enterWalk();
      } else {
        this.dist = Math.max(minD, Math.min(5 * this.radiusM, next));
      }
    }
    this.active = true;
  };

  /** Double-click: fly toward the clicked point. */
  private onDblClick = (e: MouseEvent): void => {
    if (this.mode !== 'orbit') return;
    const hit = this.rayToSurface(e.clientX, e.clientY);
    if (!hit) return;
    this.flyTo(hit, Math.max(15, this.dist * 0.35), 4);
  };

  private flyTo(target: Float64Array, dist: number, rate: number): void {
    const l = Math.hypot(target[0], target[1], target[2]);
    for (let i = 0; i < 3; i++) target[i] /= l;
    this.flyTarget = target;
    this.flyDist = dist;
    this.flyRate = rate;
    this.active = true;
  }

  /** Fly down to the focus point and set the player down there. */
  descend(): void {
    if (!this.sampler || this.mode === 'walk') return;
    this.flyTo(new Float64Array(this.focus), 14, 1.5);
    this.landing = true;
  }

  /** Leave the ground and fly up to a view of the whole planet. */
  ascend(): void {
    if (this.mode === 'walk') this.exitWalk();
    this.landing = false;
    this.flyTo(new Float64Array(this.focus), 2.4 * this.radiusM, 1.3);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.typing(e)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (this.mode === 'walk') {
      // A focused button or slider would otherwise also react to Space and the arrows.
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && t !== this.canvas) t.blur?.();
      if (k === ' ' || k.startsWith('Arrow')) e.preventDefault();
    }
    if (k === 'Escape' && this.mode === 'walk') this.exitWalk();
    if (k === 'f' && this.mode === 'walk') {
      this.flying = !this.flying;
      this.vz = 0;
    }
    if (k === 'Enter' && this.mode === 'orbit' && this.dist < 20_000 && this.sampler && !e.repeat) this.enterWalk();
    this.keys.add(k);
    this.active = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.delete(k);
  };

  /** Point on the sea-level sphere under a client position. */
  rayToSurface(clientX: number, clientY: number): Float64Array | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const o = rc.ray.origin, d = rc.ray.direction;
    const r = this.radiusM + Math.max(0, this.sea());
    const b = o.dot(d);
    const c = o.lengthSq() - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    const l = Math.hypot(x, y, z);
    return new Float64Array([x / l, y / l, z / l]);
  }

  // ------------------------------------------------------------ modes

  enterWalk(): void {
    if (!this.sampler) return;
    this.player.set(this.focus);
    this.playerH = Math.max(this.sampler.heightAt(this.player[0], this.player[1], this.player[2], 0), this.sea() - 1.25);
    this.vz = 0;
    this.yaw = this.heading;
    this.camYaw = this.heading;
    this.camPitch = 0.28;
    this.camDist = 7;
    this.flying = false;
    this.mode = 'walk';
    this.onMode?.('walk');
  }

  exitWalk(): void {
    this.focus.set(this.player);
    this.dist = Math.max(300, this.camDist * 4);
    this.heading = this.camYaw;
    this.tiltUser = 0;
    this.mode = 'orbit';
    this.onMode?.('orbit');
  }

  // ------------------------------------------------------------ motion

  private pan(right: number, forward: number): void {
    const R = this.radiusM;
    tangentFrame(this.focus, this.e, this.n, 0);
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    const fx = this.n[0] * c + this.e[0] * s, fy = this.n[1] * c + this.e[1] * s, fz = this.n[2] * c + this.e[2] * s;
    const rx = this.e[0] * c - this.n[0] * s, ry = this.e[1] * c - this.n[1] * s, rz = this.e[2] * c - this.n[2] * s;
    let ang = Math.hypot(right, forward) / R;
    const k = ang > 0.6 ? 0.6 / ang : 1;
    ang *= k;
    const x = this.focus[0] + ((rx * right + fx * forward) * k) / R;
    const y = this.focus[1] + ((ry * right + fy * forward) * k) / R;
    const z = this.focus[2] + ((rz * right + fz * forward) * k) / R;
    const l = Math.hypot(x, y, z);
    this.focus[0] = x / l; this.focus[1] = y / l; this.focus[2] = z / l;
  }

  /** Advance one frame and place the camera. */
  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    const moving = this.keys.size > 0 || this.drag !== null || this.flyTarget !== null;
    if (this.mode === 'walk') this.updateWalk(dt);
    else this.updateOrbit(dt);
    if (this.mode === 'walk' && this.timeFlows) this.tod = (this.tod + dt * this.todRate) % 24;
    this.active = this.active || moving || this.mode === 'walk';
  }

  private updateOrbit(dt: number): void {
    const R = this.radiusM;
    // Keyboard panning and turning.
    const k = this.keys;
    const f = (k.has('w') || k.has('ArrowUp') ? 1 : 0) - (k.has('s') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('d') || k.has('ArrowRight') ? 1 : 0) - (k.has('a') || k.has('ArrowLeft') ? 1 : 0);
    if (f || s) this.pan(s * this.dist * 0.9 * dt, f * this.dist * 0.9 * dt);
    if (k.has('q')) this.heading -= dt * 1.2;
    if (k.has('e')) this.heading += dt * 1.2;
    if (this.flyTarget) {
      const t = 1 - Math.exp(-dt * this.flyRate);
      for (let i = 0; i < 3; i++) this.focus[i] += (this.flyTarget[i] - this.focus[i]) * t;
      const l = Math.hypot(this.focus[0], this.focus[1], this.focus[2]);
      for (let i = 0; i < 3; i++) this.focus[i] /= l;
      this.dist *= Math.pow(this.flyDist / this.dist, t);
      const dx = this.focus[0] - this.flyTarget[0], dy = this.focus[1] - this.flyTarget[1], dz = this.focus[2] - this.flyTarget[2];
      if (Math.hypot(dx, dy, dz) * R < 1 && Math.abs(this.dist / this.flyDist - 1) < 0.03) {
        this.flyTarget = null;
        if (this.landing) {
          this.landing = false;
          this.enterWalk();
          return;
        }
      }
    }

    const up = this.focus;
    tangentFrame(up, this.e, this.n, 0);
    const c = Math.cos(this.heading), sn = Math.sin(this.heading);
    const fx = this.n[0] * c + this.e[0] * sn, fy = this.n[1] * c + this.e[1] * sn, fz = this.n[2] * c + this.e[2] * sn;
    const sr = this.surfaceR(up[0], up[1], up[2], Math.max(1, this.dist * 0.01));
    const auto = 1.15 * (1 - smoothstep(2500, 450_000, this.dist));
    const tilt = Math.max(0, Math.min(1.45, auto + this.tiltUser));
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    let px = up[0] * sr + this.dist * (up[0] * ct - fx * st);
    let py = up[1] * sr + this.dist * (up[1] * ct - fy * st);
    let pz = up[2] * sr + this.dist * (up[2] * ct - fz * st);
    // Keep the camera above the ground.
    const pl = Math.hypot(px, py, pz);
    const g = this.surfaceR(px / pl, py / pl, pz / pl, Math.max(1, this.dist * 0.01)) + 3;
    if (pl < g) {
      px *= g / pl; py *= g / pl; pz *= g / pl;
    }
    this.camera.position.set(px, py, pz);
    // Screen-up: the heading when looking straight down, the zenith when looking at the horizon.
    this.camera.up.set(up[0] * st + fx * ct, up[1] * st + fy * ct, up[2] * st + fz * ct);
    this.camera.lookAt(up[0] * sr, up[1] * sr, up[2] * sr);
  }

  private updateWalk(dt: number): void {
    const S = this.sampler;
    if (!S) return;
    const R = this.radiusM;
    const sea = S.seaLevel;
    const k = this.keys;
    const f = (k.has('w') || k.has('ArrowUp') ? 1 : 0) - (k.has('s') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('d') || k.has('ArrowRight') ? 1 : 0) - (k.has('a') || k.has('ArrowLeft') ? 1 : 0);
    const fast = k.has('Shift');
    if (k.has('q')) this.camYaw -= dt * 1.8;
    if (k.has('e')) this.camYaw += dt * 1.8;

    const p = this.player;
    tangentFrame(p, this.e, this.n, 0);
    const c = Math.cos(this.camYaw), sn = Math.sin(this.camYaw);
    const fx = this.n[0] * c + this.e[0] * sn, fy = this.n[1] * c + this.e[1] * sn, fz = this.n[2] * c + this.e[2] * sn;
    const rx = this.e[0] * c - this.n[0] * sn, ry = this.e[1] * c - this.n[1] * sn, rz = this.e[2] * c - this.n[2] * sn;

    const ground = S.heightAt(p[0], p[1], p[2], 0);
    this.swimming = !this.flying && ground < sea - 1.2;
    const speed = this.flying ? (fast ? FLY_FAST : FLY) : this.swimming ? SWIM : fast ? RUN : WALK;
    let target = 0;
    if (f || s) {
      const len = Math.hypot(f, s);
      const step = (speed * dt) / len;
      const x = p[0] + ((fx * f + rx * s) * step) / R;
      const y = p[1] + ((fy * f + ry * s) * step) / R;
      const z = p[2] + ((fz * f + rz * s) * step) / R;
      const l = Math.hypot(x, y, z);
      p[0] = x / l; p[1] = y / l; p[2] = z / l;
      target = speed;
      // Face the direction of travel.
      const want = this.camYaw + Math.atan2(s, f);
      let dh = want - this.yaw;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      this.yaw += Math.max(-10 * dt, Math.min(10 * dt, dh));
    }
    this.speed += (target - this.speed) * Math.min(1, dt * 10);

    const g2 = S.heightAt(p[0], p[1], p[2], 0);
    if (this.flying) {
      const v = (k.has(' ') ? 1 : 0) - (k.has('c') || k.has('Control') ? 1 : 0);
      this.playerH += v * speed * 0.6 * dt;
      this.playerH = Math.max(this.playerH, Math.max(g2, sea - 0.5));
      this.onGround = false;
    } else if (g2 < sea - 1.2) {
      this.playerH = sea - 1.25;
      this.vz = 0;
      this.onGround = false;
    } else {
      if (this.onGround && k.has(' ')) {
        this.vz = JUMP;
        this.onGround = false;
      }
      this.vz -= GRAVITY * dt;
      this.playerH += this.vz * dt;
      // Snap down slopes while walking; land after jumps.
      if (this.playerH <= g2 || (this.onGround && this.playerH - g2 < 0.6)) {
        this.playerH = g2;
        this.vz = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }
    }

    // Camera behind and above the player.
    tangentFrame(p, this.e, this.n, 0);
    const up = this.up.set(p[0], p[1], p[2]);
    const head = R + this.playerH + EYE;
    const tx = p[0] * head, ty = p[1] * head, tz = p[2] * head;
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const fx2 = this.n[0] * Math.cos(this.camYaw) + this.e[0] * Math.sin(this.camYaw);
    const fy2 = this.n[1] * Math.cos(this.camYaw) + this.e[1] * Math.sin(this.camYaw);
    const fz2 = this.n[2] * Math.cos(this.camYaw) + this.e[2] * Math.sin(this.camYaw);
    const d = this.camDist;
    if (d < 1.2) {
      // First person: look from the eyes.
      this.camera.position.set(tx, ty, tz);
      this.camera.up.copy(up);
      this.camera.lookAt(tx + (fx2 * cp - p[0] * sp) * 10, ty + (fy2 * cp - p[1] * sp) * 10, tz + (fz2 * cp - p[2] * sp) * 10);
      return;
    }
    let cx = tx + (-fx2 * cp + p[0] * sp) * d;
    let cy = ty + (-fy2 * cp + p[1] * sp) * d;
    let cz = tz + (-fz2 * cp + p[2] * sp) * d;
    const cl = Math.hypot(cx, cy, cz);
    const ux = cx / cl, uy = cy / cl, uz = cz / cl;
    const gc = R + Math.max(S.heightAt(ux, uy, uz, 0.5), sea) + 0.4;
    if (cl < gc) {
      cx = ux * gc; cy = uy * gc; cz = uz * gc;
    }
    this.camera.position.set(cx, cy, cz);
    this.camera.up.copy(up);
    this.camera.lookAt(tx, ty, tz);
  }

  /** Direction (unit) of what the observer stands on or looks at. */
  observer(): Float64Array {
    return this.mode === 'walk' ? this.player : this.focus;
  }

  status(): ExploreStatus {
    const o = this.observer();
    const sea = this.sea();
    const g = this.sampler ? this.sampler.heightAt(o[0], o[1], o[2], 0) - sea : 0;
    return {
      mode: this.mode,
      altitudeM: this.camera.position.length() - this.radiusM - sea,
      groundM: g,
      latDeg: (Math.asin(Math.max(-1, Math.min(1, o[1]))) * 180) / Math.PI,
      lonDeg: (Math.atan2(o[2], o[0]) * 180) / Math.PI,
      flying: this.flying,
      swimming: this.swimming,
      tod: this.tod,
      speed: this.speed,
    };
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
