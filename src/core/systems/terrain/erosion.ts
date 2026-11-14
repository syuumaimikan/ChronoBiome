import { MinHeap } from '../../minheap';
import type { RulePack } from '../../rules/schema';
import { touch, type WorldState } from '../../world/state';
import { CONTINENTAL_KM, elevationPerKm, ISOSTASY_M_PER_KM } from './isostasy';

/** Erosion never thins continental crust below this. */
const CONT_FLOOR_KM = CONTINENTAL_KM + 1;

/**
 * Rivers, erosion and deposition.
 *
 * 1. Priority-flood from the sea gives every land cell a downstream receiver,
 *    so all water reaches the ocean; closed basins are filled (lakes).
 * 2. Rain (moisture) is accumulated downstream: the drainage of each cell.
 * 3. Stream-power erosion E = K·√A·S removes crust; the sediment travels down
 *    the river, fills lakes on the way and is dropped at the mouth, where it
 *    builds deltas and continental shelves. Hillslopes relax toward their
 *    neighbours.
 *
 * Erosion works on crust thickness, so isostatic rebound is automatic:
 * removing 1 km of rock lowers the surface by only ≈ 150 m.
 */
export class ErosionScratch {
  readonly heap: MinHeap;
  readonly filled: Float32Array;
  readonly recv: Int32Array;
  readonly order: Int32Array;
  readonly visited: Uint8Array;
  readonly acc: Float64Array;
  readonly sed: Float64Array;
  readonly tmp: Float32Array;
  /** Number of land cells in `order`, from the sea upstream. */
  count = 0;
  constructor(n: number) {
    this.heap = new MinHeap(n);
    this.filled = new Float32Array(n);
    this.recv = new Int32Array(n);
    this.order = new Int32Array(n);
    this.visited = new Uint8Array(n);
    this.acc = new Float64Array(n);
    this.sed = new Float64Array(n);
    this.tmp = new Float32Array(n);
  }
}

/** Compute receivers, drainage order and filled surface (no erosion). */
export function routeDrainage(state: WorldState, s: ErosionScratch): void {
  const { mesh, fields } = state;
  const e = fields.elevation;
  const sea = state.seaLevel;
  const n = mesh.count;
  const { heap, filled, recv, order, visited } = s;
  visited.fill(0);
  heap.size = 0;
  let count = 0;
  let anyOcean = false;
  for (let i = 0; i < n; i++) {
    if (e[i] >= sea) continue;
    anyOcean = true;
    visited[i] = 1;
    filled[i] = sea;
    recv[i] = -1;
    for (let k = mesh.nbrStart[i]; k < mesh.nbrStart[i + 1]; k++) {
      if (e[mesh.nbr[k]] >= sea) {
        heap.push(sea, i);
        break;
      }
    }
  }
  if (!anyOcean) {
    let m = 0;
    for (let i = 1; i < n; i++) if (e[i] < e[m]) m = i;
    visited[m] = 1;
    filled[m] = e[m];
    recv[m] = -1;
    heap.push(e[m], m);
  }
  while (heap.size > 0) {
    const c = heap.pop();
    const fc = filled[c];
    for (let k = mesh.nbrStart[c]; k < mesh.nbrStart[c + 1]; k++) {
      const nb = mesh.nbr[k];
      if (visited[nb]) continue;
      visited[nb] = 1;
      filled[nb] = Math.max(e[nb], fc + 0.1);
      recv[nb] = c;
      order[count++] = nb;
      heap.push(filled[nb], nb);
    }
  }
  s.count = count;

  // Drainage: accumulate rain from upstream (reverse flood order).
  const acc = s.acc;
  acc.fill(0);
  for (let k = 0; k < count; k++) {
    const i = order[k];
    acc[i] = Math.max(0.02, fields.moisture[i]);
  }
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k];
    const r = recv[i];
    if (r >= 0) acc[r] += acc[i];
  }
  const flow = fields.flow;
  flow.fill(0);
  for (let k = 0; k < count; k++) {
    const i = order[k];
    flow[i] = acc[i];
  }
  touch(state, 'flow');
}

/** Erode land and deposit sediment over `dtYears`. Call routeDrainage first. */
export function erode(state: WorldState, rules: RulePack, dtYears: number, s: ErosionScratch): void {
  if (dtYears <= 0) return;
  const { mesh, fields } = state;
  const E = rules.erosion;
  const e = fields.elevation;
  const T = fields.crustThickness;
  const sea = state.seaLevel;
  const { filled, recv, order, acc, sed } = s;
  const M = ISOSTASY_M_PER_KM;
  const dx = mesh.spacingKm * 1000;
  const cellArea = (4 * Math.PI * (mesh.radiusKm * 1000) ** 2) / mesh.count;
  const maxT = rules.tectonics.maxCrustKm;
  sed.fill(0);

  for (let k = s.count - 1; k >= 0; k--) {
    const i = order[k];
    const r = recv[i];
    if (r < 0) continue;
    const lakeDepth = filled[i] - e[i];
    if (lakeDepth > 1) {
      // Closed basin: sediment settles and fills the lake.
      const dep = Math.min(sed[i], (0.5 * lakeDepth) / M);
      T[i] += dep;
      sed[i] -= dep;
    } else {
      const slope = (filled[i] - filled[r]) / dx;
      let cut = (E.streamPowerK * Math.sqrt(acc[i] * cellArea) * slope * dtYears) / 1000; // km of rock
      const head = e[i] - Math.max(e[r], sea);
      cut = Math.min(cut, head > 0 ? (0.8 * head) / M : 0);
      // Planing a continent down to base level leaves continental crust: buoyant
      // granite does not become sea floor however low the sea stands.
      if (T[i] >= CONTINENTAL_KM) cut = Math.min(cut, T[i] - CONT_FLOOR_KM);
      if (cut > 0) {
        T[i] -= cut;
        sed[i] += cut;
      }
    }
    if (e[r] < sea) depositAtMouth(state, r, sed[i], E.depositShareAtMouth, maxT);
    else sed[r] += sed[i];
  }

  // Hillslope relaxation on land. What creeps off the coast settles on the
  // adjacent sea floor instead of vanishing.
  const rate = Math.min(0.5, E.hillslopeRatePerMyr * (dtYears / 1e6));
  if (rate > 0) {
    const tmp = s.tmp;
    tmp.fill(0);
    for (let i = 0; i < mesh.count; i++) {
      if (e[i] < sea) continue;
      let sum = 0;
      const a = mesh.nbrStart[i], b = mesh.nbrStart[i + 1];
      const deg = b - a;
      for (let k = a; k < b; k++) {
        const nb = mesh.nbr[k];
        if (e[nb] < sea) {
          sum += sea;
          tmp[nb] += (rate * (e[i] - sea)) / deg / M;
        } else sum += e[nb];
      }
      tmp[i] += (rate * (sum / deg - e[i])) / M;
    }
    for (let i = 0; i < mesh.count; i++) {
      if (tmp[i] === 0) continue;
      const b = T[i];
      const floor = b >= CONTINENTAL_KM ? Math.min(b, CONT_FLOOR_KM) : 3;
      T[i] = Math.max(floor, Math.min(maxT, b + tmp[i]));
    }
  }
  touch(state, 'crustThickness');
}

/**
 * Drop sediment at a river mouth. A cell only fills up to just below sea level
 * (its accommodation space); what does not fit spills to the deepest
 * neighbouring sea cell, building a shelf outward and finally reaching the
 * deep ocean, which can take any amount.
 */
function depositAtMouth(state: WorldState, mouth: number, amount: number, share: number, maxT: number): void {
  const { mesh, fields } = state;
  const sea = state.seaLevel;
  let cell = mouth;
  let left = amount;
  let first = true;
  for (let hop = 0; hop < 8 && left > 1e-9; hop++) {
    const room = depositRoom(state, cell, sea);
    const want = first ? left * share : left;
    const put = Math.min(want, room, maxT - fields.crustThickness[cell]);
    if (put > 0) {
      fields.crustThickness[cell] += put;
      fields.elevation[cell] += put * elevationPerKm(fields.crustThickness[cell], fields.crustAge[cell]);
      left -= put;
    }
    first = false;
    // Move on to the deepest neighbouring sea cell.
    let next = -1;
    let deepest = sea;
    for (let k = mesh.nbrStart[cell]; k < mesh.nbrStart[cell + 1]; k++) {
      const j = mesh.nbr[k];
      if (fields.elevation[j] < deepest) {
        deepest = fields.elevation[j];
        next = j;
      }
    }
    if (next < 0) break;
    cell = next;
  }
  // What does not fit on the shelf becomes a thin pelagic blanket on the deep
  // sea floor, which is eventually subducted and recycled into the mantle.
  // Leaving it in place would pile it into fake continents, so it leaves the
  // crust budget here.
}

/** Thickness (km) that can be added before the cell reaches 20 m below sea level. */
function depositRoom(state: WorldState, cell: number, sea: number): number {
  const f = state.fields;
  const gap = sea - 20 - f.elevation[cell];
  if (gap <= 0) return 0;
  return gap / elevationPerKm(f.crustThickness[cell], f.crustAge[cell]);
}
