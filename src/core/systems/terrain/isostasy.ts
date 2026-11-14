import type { RulePack } from '../../rules/schema';
import { touch, type WorldState } from '../../world/state';

/**
 * Elevation is not stored as truth: it is derived from the crust.
 *
 *   elevation = k·T − Z0 − w(T)·s·√min(age, 100) + relief + trench
 *
 * - k·T − Z0: Airy isostasy. Crust (ρ≈2.8) floats on mantle (ρ≈3.3), so each
 *   km of crust raises the surface by (1 − 2.8/3.3) km ≈ 151.5 m. With Z0 =
 *   3660 m, 7 km oceanic crust sits at −2600 m (mid-ocean ridge) and 30 km
 *   continental crust at about +900 m.
 * - s·√age: half-space cooling. Sea floor sinks as it ages and cools
 *   (≈ 350 m·√Myr), which makes ridges and abyssal plains emerge by itself.
 *   w(T) applies it to oceanic crust only.
 * - trench: flexure of oceanic plates at converging boundaries.
 */

export const ISOSTASY_M_PER_KM = 151.5;
export const ISOSTASY_DATUM_M = 3660;
export const THERMAL_SUBSIDENCE_M = 350;
export const OCEANIC_CRUST_KM = 7;
/** Crust thicker than this behaves as continental (buoyant, does not subduct). */
export const CONTINENTAL_KM = 18;

/**
 * Weight of thermal subsidence: 1 for oceanic crust, 0 for thick continental
 * crust, linear in between so that sediment-thickened margins change smoothly.
 */
export function thermalWeight(thicknessKm: number): number {
  if (thicknessKm <= OCEANIC_CRUST_KM) return 1;
  if (thicknessKm >= 25) return 0;
  return (25 - thicknessKm) / (25 - OCEANIC_CRUST_KM);
}

/** Approximate d(elevation)/d(thickness) in m per km, including the thermal term. */
export function elevationPerKm(thicknessKm: number, ageMyr: number): number {
  const thermal = thicknessKm > OCEANIC_CRUST_KM && thicknessKm < 25
    ? (THERMAL_SUBSIDENCE_M * Math.sqrt(Math.min(Math.max(ageMyr, 0), 100))) / (25 - OCEANIC_CRUST_KM)
    : 0;
  return ISOSTASY_M_PER_KM + thermal;
}

/** Elevation implied by crust thickness and age alone (no relief, no trench). */
export function baseElevation(thicknessKm: number, ageMyr: number): number {
  return (
    ISOSTASY_M_PER_KM * thicknessKm -
    ISOSTASY_DATUM_M -
    thermalWeight(thicknessKm) * THERMAL_SUBSIDENCE_M * Math.sqrt(Math.min(Math.max(ageMyr, 0), 100))
  );
}

export function deriveElevation(state: WorldState, rules: RulePack): void {
  const f = state.fields;
  const n = state.mesh.count;
  const trench = rules.terrain.trenchDepthM;
  for (let i = 0; i < n; i++) {
    const T = f.crustThickness[i];
    let e = baseElevation(T, f.crustAge[i]) + f.relief[i];
    const s = f.stress[i];
    if (s > 0 && T < 12) e -= trench * Math.min(1, s);
    f.elevation[i] = Math.max(-11500, Math.min(9500, e));
  }
  touch(state, 'elevation');
}

/** Ocean volume (metres × cells) below a given sea level. */
export function oceanVolume(elevation: Float32Array, seaLevel: number): number {
  let v = 0;
  for (let i = 0; i < elevation.length; i++) {
    const d = seaLevel - elevation[i];
    if (d > 0) v += d;
  }
  return v;
}

/** Find the sea level that holds the conserved water volume (bisection near the previous level). */
export function solveSeaLevel(state: WorldState): number {
  const e = state.fields.elevation;
  const V = state.waterVolume;
  // Volume grows with sea level: bracket around the previous level, widening if needed.
  let lo = state.seaLevel - 200;
  let hi = state.seaLevel + 200;
  while (lo > -12000 && oceanVolume(e, lo) > V) lo -= 1000;
  while (hi < 10000 && oceanVolume(e, hi) < V) hi += 1000;
  while (hi - lo > 0.05) {
    const mid = (lo + hi) / 2;
    if (oceanVolume(e, mid) < V) lo = mid;
    else hi = mid;
  }
  state.seaLevel = (lo + hi) / 2;
  return state.seaLevel;
}
