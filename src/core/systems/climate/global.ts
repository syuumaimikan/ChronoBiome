import { orbitalElements, presentEpoch, solarConstant, type StarSystem } from '../../universe/system';

/**
 * Global climate (milestone 3): a one-dimensional energy-balance model
 * (Budyko–Sellers) by latitude, driven by the star's luminosity, the orbit
 * (Milankovitch cycles), CO2 and the ice–albedo feedback, plus a carbon cycle.
 *
 * The rule pack's equator/pole temperatures stay the baseline: the model only
 * adds the anomaly relative to the world's first moment, so a pack keeps its
 * character while its climate can drift into ice ages or hothouses.
 *
 *   Q(φ)·(1 − α(T)) = A + B·T + D·(T − T̄),   A = A0 − 5.35·ln(CO2 / 280)
 *   Q(φ) = S/4 · (1 + s2·P2(sin φ)),          s2 = −5/8 · P2(cos obliquity)
 *
 * Carbon: volcanic outgassing balanced by silicate weathering, which speeds up
 * when it is warm — a thermostat that offsets most of a slow brightening of
 * the star over millions of years — plus fossil-fuel emissions from
 * civilisations, taken up by the ocean over centuries.
 */

export const BANDS = 36;
const A0 = 203.3;
const B = 2.09;
const D = 3.8;

export interface GlobalClimate {
  /** Natural CO2 (ppm) set by the weathering thermostat. */
  co2Natural: number;
  /** CO2 added by civilisations and not yet absorbed (ppm). */
  co2Excess: number;
  co2Base: number;
  /** Greenhouse forcing from gases other than CO2 (methane under a young star), W/m². */
  otherForcing: number;
  /** Solar constant now, at the start, and under a present-day Sun (the rule pack's reference) (W/m²). */
  solar: number;
  solar0: number;
  solarRef: number;
  /** Per-system phase of the slow tectonic outgassing cycles. */
  phase: number;
  tiltDeg: number;
  ecc: number;
  /** Area-weighted mean temperature change since the start (°C). */
  meanAnomaly: number;
  /** Anomaly per latitude band, south to north. */
  bandAnomaly: Float32Array;
  /** Land ice volume (ocean-volume units: metres × cells) and its value at the start. */
  iceVolume: number;
  iceVolume0: number;
  /** Ice-covered share of the land. */
  iceShare: number;
  /** Emission rate set by civilisations (ppm/yr) and the cumulative total. */
  emissionRate: number;
  emittedTotal: number;
  /** Pulses from eruptions / impacts waiting to be added (ppm) and a temporary cooling (°C). */
  pulse: number;
  aerosolCooling: number;
  /** Reference band temperatures from the energy-balance model at t = 0. */
  readonly ref: Float32Array;
  readonly cur: Float32Array;
}

export function createGlobalClimate(sys: StarSystem, tiltDeg: number, co2Base: number): GlobalClimate {
  const orb = { tiltDeg, ecc: 0.028 };
  // The rule pack's climate describes the world under a star like today's Sun
  // with `co2Base`: anomalies are measured against that.
  const solarRef = solarConstant(sys, presentEpoch(sys), orb.ecc);
  const solar0 = solarConstant(sys, 0, orb.ecc);
  const ref = new Float32Array(BANDS);
  ebm(solarRef, tiltDeg, co2Base, 0, ref);
  const c: GlobalClimate = {
    co2Natural: co2Base,
    co2Excess: 0,
    co2Base,
    otherForcing: 0,
    solar: solar0,
    solar0,
    solarRef,
    phase: sys.starMass * 1000,
    tiltDeg,
    ecc: orb.ecc,
    meanAnomaly: 0,
    bandAnomaly: new Float32Array(BANDS),
    iceVolume: 0,
    iceVolume0: -1,
    iceShare: 0,
    emissionRate: 0,
    emittedTotal: 0,
    pulse: 0,
    aerosolCooling: 0,
    ref,
    cur: new Float32Array(BANDS),
  };
  const t = thermostat(c, 0, 1);
  c.co2Natural = t.co2;
  c.otherForcing = t.other;
  return c;
}

/**
 * Long-term greenhouse: silicate weathering offsets most of the star's slow
 * brightening by drawing CO2 down (and, under a faint young star, a CO2 and
 * methane greenhouse keeps the oceans liquid), with slow tectonic swings in
 * outgassing that bring hothouses and ice ages. CO2 cannot fall below ~10 ppm,
 * so a star that grows too bright eventually overwhelms the thermostat.
 */
function thermostat(c: GlobalClimate, time: number, landFactor: number): { co2: number; other: number } {
  const dSolar = ((c.solar - c.solarRef) / 4) * 0.7;
  const offset = dSolar < 0 ? 0.97 : 0.88;
  const tectonic = 2.2 * Math.sin((2 * Math.PI * time) / 1.5e8 + c.phase) + 1.3 * Math.sin((2 * Math.PI * time) / 3.3e7 + 2.1 * c.phase);
  const want = -offset * dSolar - 2.7 * Math.log(landFactor) + (time > 0 ? tectonic : 0);
  const co2 = Math.max(10, Math.min(40_000, c.co2Base * Math.exp(want / 5.35)));
  const got = 5.35 * Math.log(co2 / c.co2Base);
  return { co2, other: Math.max(0, want - got) };
}

export function co2(c: GlobalClimate): number {
  return c.co2Natural + c.co2Excess;
}

/** Steady-state energy-balance temperatures per band (°C) with ice–albedo feedback. */
export function ebm(solar: number, tiltDeg: number, co2ppm: number, forcing: number, out: Float32Array): void {
  const beta = (tiltDeg * Math.PI) / 180;
  const cb = Math.cos(beta);
  const s2 = -(5 / 8) * ((3 * cb * cb - 1) / 2);
  // Forcing beyond ~+60 W/m² would boil the oceans (a runaway greenhouse): the
  // linear model is capped there instead of returning thousands of degrees.
  const A = A0 - Math.min(60, 5.35 * Math.log(Math.max(1, co2ppm) / 280) + forcing);
  const Q = solar / 4;
  let wsum = 0;
  for (let b = 0; b < BANDS; b++) wsum += Math.cos(bandLat(b));
  // Start warm and iterate the albedo to convergence.
  for (let b = 0; b < BANDS; b++) out[b] = 15;
  for (let it = 0; it < 40; it++) {
    let mean = 0;
    for (let b = 0; b < BANDS; b++) mean += out[b] * Math.cos(bandLat(b));
    mean /= wsum;
    for (let b = 0; b < BANDS; b++) {
      const x = Math.sin(bandLat(b));
      const q = Q * (1 + s2 * ((3 * x * x - 1) / 2));
      const T = out[b];
      const alpha = T <= -10 ? 0.62 : T >= 0 ? 0.3 : 0.62 - (0.32 * (T + 10)) / 10;
      out[b] = Math.min(110, 0.5 * out[b] + 0.5 * ((q * (1 - alpha) - A + D * mean) / (B + D)));
    }
  }
}

export function bandLat(b: number): number {
  return ((-90 + (b + 0.5) * (180 / BANDS)) * Math.PI) / 180;
}

/** Interpolated anomaly at a latitude (radians). */
export function anomalyAt(c: GlobalClimate, lat: number): number {
  const f = ((lat * 180) / Math.PI + 90) / (180 / BANDS) - 0.5;
  const b0 = Math.max(0, Math.min(BANDS - 1, Math.floor(f)));
  const b1 = Math.min(BANDS - 1, b0 + 1);
  const t = Math.max(0, Math.min(1, f - b0));
  return c.bandAnomaly[b0] * (1 - t) + c.bandAnomaly[b1] * t - c.aerosolCooling;
}

/**
 * Advance the carbon cycle and orbit, re-solve the energy balance. Returns
 * true when temperatures changed enough to rewrite the climate fields.
 */
export function stepGlobalClimate(c: GlobalClimate, sys: StarSystem, baseTiltDeg: number, time: number, dtYears: number, landShare: number, landShare0: number): boolean {
  // Orbital cycles are only resolved when a tick is shorter than them; coarser
  // lenses see their average.
  if (dtYears < 20_000) {
    const o = orbitalElements(sys, baseTiltDeg, time);
    c.tiltDeg = o.tiltDeg;
    c.ecc = o.ecc;
  } else {
    c.tiltDeg = baseTiltDeg;
    c.ecc = 0.028;
  }
  c.solar = solarConstant(sys, time, c.ecc);

  // Silicate-weathering thermostat (faster with more exposed land).
  const landFactor = Math.max(0.3, landShare / Math.max(0.05, landShare0));
  const th = thermostat(c, time, landFactor);
  const k = 1 - Math.exp(-dtYears / 4e5);
  c.co2Natural += (th.co2 - c.co2Natural) * k;
  c.otherForcing += (th.other - c.otherForcing) * k;
  if (c.pulse > 0) {
    c.co2Natural += c.pulse;
    c.pulse = 0;
  }
  // Anthropogenic CO2: emitted, then taken up by the ocean and biosphere.
  c.co2Excess += c.emissionRate * dtYears;
  c.emittedTotal += c.emissionRate * dtYears;
  c.co2Excess *= Math.exp(-dtYears / 900);
  c.aerosolCooling *= Math.exp(-dtYears / 3);

  ebm(c.solar, c.tiltDeg, co2(c), c.otherForcing, c.cur);
  let changed = false;
  let mean = 0, w = 0;
  for (let b = 0; b < BANDS; b++) {
    const a = c.cur[b] - c.ref[b];
    if (Math.abs(a - c.bandAnomaly[b]) > 0.05) changed = true;
    c.bandAnomaly[b] = a;
    const cw = Math.cos(bandLat(b));
    mean += a * cw;
    w += cw;
  }
  c.meanAnomaly = mean / w - c.aerosolCooling;
  return changed || c.aerosolCooling > 0.05;
}
