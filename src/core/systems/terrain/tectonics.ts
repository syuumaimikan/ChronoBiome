import { deriveSeed, Rng } from '../../rng';
import type { RulePack } from '../../rules/schema';
import type { GeodesicMesh } from '../../world/geodesic';
import { MAX_PLATES, touch, type WorldState } from '../../world/state';
import { convergence, randomizeMotion } from './initial';
import { CONTINENTAL_KM, OCEANIC_CRUST_KM } from './isostasy';

/**
 * Plate tectonics on a fixed grid.
 *
 * Each plate accumulates rotation about its Euler pole; whenever that adds up
 * to one cell spacing, the plate is advected by one step with a
 * semi-Lagrangian gather: every cell in or next to the plate looks up where its
 * material came from. That makes the outcome at each cell one of:
 *   - plain motion (material of the same plate arrives),
 *   - seafloor spreading (the plate moved away and nothing arrived: new crust),
 *   - convergence with another plate: continental collision (crust stacks up
 *     into mountains), subduction under a continent or an older oceanic plate
 *     (the subducting crust is destroyed and a volcanic arc thickens the
 *     overriding plate).
 * Large plates occasionally rift, plates change course, collisions slow them
 * down, and plates drifting over fixed mantle hotspots leave island chains.
 */

export class TectonicsScratch {
  readonly oldOwner: Uint16Array;
  readonly oldT: Float32Array;
  readonly oldAge: Float32Array;
  readonly oldRelief: Float32Array;
  /** Crust (km) squeezed out of collision cells, spread to neighbours after each move. */
  readonly spill: Float32Array;
  /** Source cell each destination gathers from in the current move (-1: not near the plate). */
  readonly src: Int32Array;
  /** `stamp` of the last move that carried this cell's crust somewhere. */
  readonly used: Int32Array;
  stamp = 0;
  /** Breadth-first search state for spreading collision crust. */
  readonly queue: Int32Array;
  readonly seen: Int32Array;
  seenStamp = 0;
  readonly area: Int32Array = new Int32Array(MAX_PLATES);
  readonly collisions: Float64Array = new Float64Array(MAX_PLATES);
  readonly va = new Float64Array(3);
  readonly vb = new Float64Array(3);
  constructor(n: number) {
    this.oldOwner = new Uint16Array(n);
    this.oldT = new Float32Array(n);
    this.oldAge = new Float32Array(n);
    this.oldRelief = new Float32Array(n);
    this.spill = new Float32Array(n);
    this.src = new Int32Array(n);
    this.used = new Int32Array(n);
    this.queue = new Int32Array(Math.min(n, SPREAD_CAP));
    this.seen = new Int32Array(n);
  }
}

/** Reference speed for normalising boundary stress: 1°/Myr in radians per year. */
const REF_OMEGA = Math.PI / 180 / 1e6;

export interface TectonicEvents {
  moves: number;
  rifts: number;
  reorganisations: number;
  platesDied: number;
}

export function runTectonics(state: WorldState, rules: RulePack, dtYears: number, s: TectonicsScratch): TectonicEvents {
  const { mesh, plates, fields } = state;
  const R = rules.tectonics;
  const dtMyr = dtYears / 1e6;
  const rng = new Rng(deriveSeed(state.seed, 'tectonics', state.tick));
  const cellAngle = mesh.spacingKm / mesh.radiusKm;
  const ev: TectonicEvents = { moves: 0, rifts: 0, reorganisations: 0, platesDied: 0 };

  // ---- 1. motion
  s.collisions.fill(0);
  for (let p = 0; p < plates.count; p++) {
    if (!plates.alive[p]) continue;
    plates.pending[p] += Math.abs(plates.omega[p]) * dtYears;
    let guard = 0;
    while (plates.pending[p] >= cellAngle && guard++ < 32) {
      movePlate(state, rules, p, Math.sign(plates.omega[p]) * cellAngle, s);
      plates.pending[p] -= cellAngle;
      ev.moves++;
    }
    if (guard >= 32) plates.pending[p] = 0;
  }

  // ---- 2. collisions resist the mantle drive; the plate relaxes toward the
  // speed that balance allows (~20 Myr), so it slows while colliding and
  // speeds up again once free instead of grinding to a halt.
  const relax = Math.min(1, dtMyr / 20);
  for (let p = 0; p < plates.count; p++) {
    if (!plates.alive[p]) continue;
    const perMyr = dtMyr > 0 ? s.collisions[p] / dtMyr : 0;
    const target = plates.drive[p] * Math.max(0.3, 1 - R.collisionDrag * perMyr);
    plates.omega[p] += (target - plates.omega[p]) * relax;
  }

  // ---- 3. tidy plate outlines, then plate areas; consumed plates die
  const owner = fields.plate;
  absorbSlivers(state, s);
  s.area.fill(0);
  for (let i = 0; i < mesh.count; i++) s.area[owner[i]]++;
  for (let p = 0; p < plates.count; p++) {
    if (plates.alive[p] && s.area[p] === 0) {
      plates.alive[p] = 0;
      ev.platesDied++;
    }
  }
  while (plates.count > 0 && !plates.alive[plates.count - 1]) plates.count--;

  // ---- 4. reorganisation and rifting
  const [vMin, vMax] = rules.terrain.plateSpeedDegPerMyr;
  const liveNow = plates.count;
  for (let p = 0; p < liveNow; p++) {
    if (!plates.alive[p]) continue;
    if (rng.chance(dtMyr / R.reorganizeEveryMyr)) {
      randomizeMotion(state, p, rng, vMin, vMax);
      ev.reorganisations++;
    }
    if (s.area[p] / mesh.count >= R.riftMinAreaShare && rng.chance(dtMyr / R.riftEveryMyr)) {
      if (riftPlate(state, p, rng, vMin, vMax)) ev.rifts++;
    }
  }

  // ---- 5. hotspots, ageing, decay of uncompensated relief on the sea floor
  const T = fields.crustThickness;
  const relief = fields.relief;
  const sea = state.seaLevel;
  for (let h = 0; h < state.hotspots.length; h++) {
    const c = state.hotspots[h];
    const above = fields.elevation[c] - sea;
    if (above < R.hotspotMaxHeightM) relief[c] += Math.min(R.hotspotUpliftMPerMyr * dtMyr, R.hotspotMaxHeightM - above);
    T[c] = Math.min(R.maxCrustKm, T[c] + 0.15 * dtMyr);
  }
  const decay = Math.exp(-dtMyr / R.reliefDecayMyr);
  for (let i = 0; i < mesh.count; i++) {
    fields.crustAge[i] += dtMyr;
    // Uncompensated relief sinks back: volcanic edifices on the sea floor, and
    // any excess height carried onto thickened crust (which would otherwise
    // stack on top of the isostatic height of an orogen).
    if (T[i] < 12 || relief[i] > 0) relief[i] *= decay;
  }

  // ---- 6. boundary stress (convergence), used for trenches and display
  computeStress(state, s);

  touch(state, 'plate', 'crustThickness', 'crustAge', 'relief', 'stress');
  return ev;
}

/** Advect plate p by `angle` radians about its pole (one grid step). */
function movePlate(state: WorldState, rules: RulePack, p: number, angle: number, s: TectonicsScratch): void {
  const { mesh, plates, fields } = state;
  const R = rules.tectonics;
  const n = mesh.count;
  const owner = fields.plate;
  const T = fields.crustThickness;
  const age = fields.crustAge;
  const relief = fields.relief;
  s.oldOwner.set(owner);
  s.oldT.set(T);
  s.oldAge.set(age);
  s.oldRelief.set(relief);
  const oldOwner = s.oldOwner;

  // Inverse rotation (Rodrigues) to find where material at a cell came from.
  const kx = plates.pole[p * 3], ky = plates.pole[p * 3 + 1], kz = plates.pole[p * 3 + 2];
  const c = Math.cos(-angle), sn = Math.sin(-angle);
  const pos = mesh.pos;
  const maxT = R.maxCrustKm;
  const used = s.used;
  const stamp = ++s.stamp;
  const srcOf = s.src;

  // Pass 1: where does each cell's material come from? Also records which
  // cells' crust is carried away, so a vacated cell knows whether its old
  // crust has left (and must not be kept, or it would be copied).
  for (let j = 0; j < n; j++) {
    srcOf[j] = -1;
    let near = oldOwner[j] === p;
    if (!near) {
      for (let k = mesh.nbrStart[j]; k < mesh.nbrStart[j + 1]; k++) {
        if (oldOwner[mesh.nbr[k]] === p) { near = true; break; }
      }
      if (!near) continue;
    }
    const x = pos[j * 3], y = pos[j * 3 + 1], z = pos[j * 3 + 2];
    const dot = kx * x + ky * y + kz * z;
    const rx = x * c + (ky * z - kz * y) * sn + kx * dot * (1 - c);
    const ry = y * c + (kz * x - kx * z) * sn + ky * dot * (1 - c);
    const rz = z * c + (kx * y - ky * x) * sn + kz * dot * (1 - c);
    const src = walkToNearest(mesh, j, rx, ry, rz);
    srcOf[j] = src;
    if (oldOwner[src] === p && src !== j) used[src] = stamp;
  }

  // Pass 2: move.
  for (let j = 0; j < n; j++) {
    const src = srcOf[j];
    if (src < 0) continue;
    if (oldOwner[src] === p) {
      const q = oldOwner[j];
      const Tp = s.oldT[src];
      if (q === p) {
        owner[j] = p; T[j] = Tp; age[j] = s.oldAge[src]; relief[j] = s.oldRelief[src];
        continue;
      }
      // Contact with plate q at cell j. Only the part of p's motion that
      // closes on q is real convergence: a plate following another at the
      // same speed keeps stepping into the cells the leader just left, and
      // that must not build mountains or arcs.
      const closing = convergence(state, p, q, src, j, s.va, s.vb);
      const speed = Math.hypot(s.va[0], s.va[1], s.va[2]);
      const f = speed > 0 ? Math.min(1, Math.max(0, closing / speed)) : 0;
      const Tq = s.oldT[j];
      const contP = Tp >= CONTINENTAL_KM;
      const contQ = Tq >= CONTINENTAL_KM;
      if (contP && contQ) {
        // Continental collision: the thicker crust stays on top and the other is
        // thrust beneath it. Volume is conserved: part thickens this cell, the
        // rest (and anything above the thickness limit) widens the orogen.
        const pWins = Tp >= Tq;
        const stackedIn = f * R.collisionThickening * Math.min(Tp, Tq);
        const total = Math.max(Tp, Tq) + stackedIn;
        if (pWins) { owner[j] = p; age[j] = s.oldAge[src]; relief[j] = s.oldRelief[src]; }
        T[j] = Math.min(maxT, total);
        s.spill[j] += (Math.min(Tp, Tq) - stackedIn) + Math.max(0, total - maxT);
        s.collisions[p] += f;
        s.collisions[q] += f;
      } else if (contP && !contQ) {
        // q's oceanic crust dives under the advancing continent: Andean arc.
        owner[j] = p; T[j] = Math.min(maxT, Tp + f * R.arcThickeningKm); age[j] = s.oldAge[src]; relief[j] = s.oldRelief[src];
      } else if (!contP && contQ) {
        // p dives under q's continent.
        T[j] = Math.min(maxT, Tq + f * R.arcThickeningKm);
      } else if (s.oldAge[src] > s.oldAge[j]) {
        // Ocean–ocean: the older, denser plate subducts; the other grows an island arc.
        T[j] = Math.min(maxT, Tq + f * 0.7 * R.arcThickeningKm);
      } else {
        owner[j] = p; T[j] = Math.min(maxT, Tp + f * 0.7 * R.arcThickeningKm); age[j] = s.oldAge[src]; relief[j] = s.oldRelief[src];
      }
    } else if (oldOwner[j] === p) {
      // Vacated: nothing of p arrived. If p pulled away from its neighbour, or
      // the old crust here moved on with p, the cell gets new sea floor
      // (spreading, or the gap a following plate is about to fill). Otherwise
      // the gap is grid rounding and the crust, which went nowhere, stays.
      if (used[j] === stamp || isDivergentGap(state, p, j, oldOwner, s)) {
        owner[j] = p; T[j] = OCEANIC_CRUST_KM; age[j] = 0; relief[j] = 0;
      }
    }
  }

  // Crust thrust out of collision cells widens the orogen (see spreadCrust).
  for (let j = 0; j < n; j++) {
    const left = s.spill[j];
    if (left <= 0) continue;
    s.spill[j] = 0;
    spreadCrust(state, j, left, maxT, s);
  }
}

/**
 * Cells cut off from their plate — single cells left inside another plate where
 * subduction went the other way along a ragged boundary, and the one-cell trails
 * such a cell leaves as it moves — become part of the plate around them. The
 * crust stays; only which plate carries it changes. A cell is absorbed when at
 * most two of its neighbours share its plate and one other plate holds at
 * least four.
 */
function absorbSlivers(state: WorldState, s: TectonicsScratch): void {
  const { mesh, fields } = state;
  const owner = fields.plate;
  const old = s.oldOwner;
  old.set(owner);
  const counts = s.area; // reused as per-plate neighbour counts, cleared after each cell
  counts.fill(0);
  for (let i = 0; i < mesh.count; i++) {
    const a = mesh.nbrStart[i], b = mesh.nbrStart[i + 1];
    const mine = old[i];
    let same = 0;
    for (let k = a; k < b; k++) if (old[mesh.nbr[k]] === mine) same++;
    if (same > 2) continue;
    let best = -1, bestN = 0;
    for (let k = a; k < b; k++) {
      const q = old[mesh.nbr[k]];
      if (q === mine) continue;
      const c = ++counts[q];
      if (c > bestN || (c === bestN && q < best)) { bestN = c; best = q; }
    }
    for (let k = a; k < b; k++) counts[old[mesh.nbr[k]]] = 0;
    if (bestN >= 4) owner[i] = best;
  }
}

/** Most cells a single spill may search before giving up. */
const SPREAD_CAP = 800;

/**
 * Put `amount` km of crust squeezed out of a collision at cell `from` into the
 * nearest cells with room, so the orogen widens instead of losing rock:
 * breadth-first through continental crust, filling each cell up to the
 * thickness limit; if the continent around is full, the remainder builds new
 * continental margin out over the sea floor. Returns what could not be placed.
 */
function spreadCrust(state: WorldState, from: number, amount: number, maxT: number, s: TectonicsScratch): number {
  const { mesh, fields } = state;
  const T = fields.crustThickness;
  const queue = s.queue;
  const seen = s.seen;
  const mark = ++s.seenStamp;
  let left = amount;
  let head = 0, tail = 0;
  queue[tail++] = from;
  seen[from] = mark;
  while (head < tail && left > 1e-6) {
    const cell = queue[head++];
    const cont = T[cell] >= CONTINENTAL_KM;
    if (cell !== from && cont) {
      const put = Math.min(left, maxT - T[cell]);
      if (put > 0) { T[cell] += put; left -= put; }
    }
    // Spread only through the continent; sea floor at its edge is kept for later.
    if (!cont && cell !== from) continue;
    for (let k = mesh.nbrStart[cell]; k < mesh.nbrStart[cell + 1]; k++) {
      const nb = mesh.nbr[k];
      if (seen[nb] === mark || tail >= SPREAD_CAP) continue;
      seen[nb] = mark;
      queue[tail++] = nb;
    }
  }
  // Continent full: grow it outward over the adjacent sea floor, nearest first.
  for (let k = 0; k < tail && left > 1e-6; k++) {
    const cell = queue[k];
    if (T[cell] >= CONTINENTAL_KM) continue;
    const put = Math.min(left, MARGIN_KM - T[cell]);
    if (put > 0) { T[cell] += put; left -= put; }
  }
  return left;
}

/** Thickness of continental margin built out of crust that a full orogen cannot hold. */
const MARGIN_KM = 34;

/**
 * A cell vacated by plate p opens new sea floor only if p is really moving
 * away from an adjacent plate there. Gaps inside a plate or along transform
 * boundaries are artefacts of snapping rotations to the grid.
 */
function isDivergentGap(state: WorldState, p: number, j: number, oldOwner: Uint16Array, s: TectonicsScratch): boolean {
  const mesh = state.mesh;
  let most = 0;
  for (let k = mesh.nbrStart[j]; k < mesh.nbrStart[j + 1]; k++) {
    const nb = mesh.nbr[k];
    const q = oldOwner[nb];
    if (q === p) continue;
    const c = convergence(state, p, q, j, nb, s.va, s.vb);
    if (c < most) most = c;
  }
  return most < -0.1 * REF_OMEGA;
}

/** Greedy walk over the grid to the cell closest to a unit vector. */
export function walkToNearest(mesh: GeodesicMesh, start: number, x: number, y: number, z: number): number {
  const pos = mesh.pos;
  let cur = start;
  let best = pos[cur * 3] * x + pos[cur * 3 + 1] * y + pos[cur * 3 + 2] * z;
  for (let guard = 0; guard < 64; guard++) {
    let next = -1;
    for (let k = mesh.nbrStart[cur]; k < mesh.nbrStart[cur + 1]; k++) {
      const j = mesh.nbr[k];
      const d = pos[j * 3] * x + pos[j * 3 + 1] * y + pos[j * 3 + 2] * z;
      if (d > best) { best = d; next = j; }
    }
    if (next < 0) return cur;
    cur = next;
  }
  return cur;
}

/** Split plate p along a random great circle through its centroid; the halves move apart. */
function riftPlate(state: WorldState, p: number, rng: Rng, vMin: number, vMax: number): boolean {
  const { mesh, plates, fields } = state;
  let slot = -1;
  for (let q = 0; q < MAX_PLATES; q++) if (!plates.alive[q] && q !== p) { slot = q; break; }
  if (slot < 0) return false;

  const owner = fields.plate;
  const pos = mesh.pos;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < mesh.count; i++) {
    if (owner[i] !== p) continue;
    cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2];
  }
  const cl = Math.hypot(cx, cy, cz);
  if (cl < 1e-9) return false;
  cx /= cl; cy /= cl; cz /= cl;
  // Random tangent direction d at the centroid.
  let dx = rng.normal(), dy = rng.normal(), dz = rng.normal();
  const proj = dx * cx + dy * cy + dz * cz;
  dx -= proj * cx; dy -= proj * cy; dz -= proj * cz;
  const dl = Math.hypot(dx, dy, dz);
  if (dl < 1e-9) return false;
  dx /= dl; dy /= dl; dz /= dl;

  let moved = 0;
  for (let i = 0; i < mesh.count; i++) {
    if (owner[i] === p && pos[i * 3] * dx + pos[i * 3 + 1] * dy + pos[i * 3 + 2] * dz > 0) {
      owner[i] = slot;
      moved++;
    }
  }
  if (moved === 0) return false;

  // Rotation about a = c × d moves the centroid along +d (a × c = d), so the halves diverge.
  let ax = cy * dz - cz * dy, ay = cz * dx - cx * dz, az = cx * dy - cy * dx;
  ax += 0.25 * rng.normal(); ay += 0.25 * rng.normal(); az += 0.25 * rng.normal();
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  const speed = rng.range(vMin, vMax) * (Math.PI / 180 / 1e6);
  plates.alive[slot] = 1;
  plates.count = Math.max(plates.count, slot + 1);
  for (const [q, sign] of [[slot, 1], [p, -1]] as const) {
    plates.pole[q * 3] = ax; plates.pole[q * 3 + 1] = ay; plates.pole[q * 3 + 2] = az;
    plates.omega[q] = sign * speed;
    plates.drive[q] = sign * speed;
    plates.pending[q] = 0;
  }
  return true;
}

/** Signed convergence at plate boundaries, normalised by 2°/Myr. */
export function computeStress(state: WorldState, s: TectonicsScratch): void {
  const { mesh, fields } = state;
  const owner = fields.plate;
  const out = fields.stress;
  for (let i = 0; i < mesh.count; i++) {
    const p = owner[i];
    let best = 0;
    for (let k = mesh.nbrStart[i]; k < mesh.nbrStart[i + 1]; k++) {
      const j = mesh.nbr[k];
      const q = owner[j];
      if (q === p) continue;
      const c = convergence(state, p, q, i, j, s.va, s.vb) / (2 * REF_OMEGA);
      if (Math.abs(c) > Math.abs(best)) best = c;
    }
    out[i] = Math.max(-1, Math.min(1, best));
  }
}
