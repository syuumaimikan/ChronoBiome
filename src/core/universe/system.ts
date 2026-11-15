import { Rng } from '../rng';

/**
 * The star system: a main-sequence star whose luminosity grows with age,
 * planets on Kepler orbits (analytic: any instant without integration),
 * the home world's moons, and a fixed background of stars for the sky.
 *
 * Units: AU, years, solar masses / luminosities, degrees for display.
 */

export interface Orbit {
  /** Semi-major axis (AU). */
  a: number;
  e: number;
  /** Inclination, longitude of ascending node, argument of periapsis, mean anomaly at t=0 (radians). */
  i: number;
  node: number;
  peri: number;
  m0: number;
  /** Orbital period (years). */
  period: number;
}

export type BodyKind = 'rocky' | 'ocean' | 'desert' | 'ice' | 'gas' | 'icegiant' | 'moon';

export interface Body {
  id: number;
  name: string;
  kind: BodyKind;
  /** Earth masses / radii. */
  mass: number;
  radius: number;
  orbit: Orbit;
  /** Parent body id (-1 = the star). */
  parent: number;
  /** Mean surface temperature (°C) from insolation alone (no greenhouse except for the home world). */
  tempC: number;
  /** Life could be sustained with domes / terraforming (0 = hopeless … 1 = like home). */
  habitability: number;
  home: boolean;
  /** Display colour. */
  color: string;
}

export interface BackgroundStar {
  /** Ecliptic longitude / latitude, radians. */
  lon: number;
  lat: number;
  /** Apparent magnitude (smaller = brighter). */
  mag: number;
}

export interface StarSystem {
  starName: string;
  /** Solar masses. */
  starMass: number;
  /** Luminosity now relative to the star's zero-age value scaled to the Sun today. */
  baseLuminosity: number;
  /** Main-sequence lifetime (years). */
  lifetime: number;
  /** Age of the star when the world formed (years). */
  ageAtFormation: number;
  bodies: Body[];
  homeId: number;
  moons: number[];
  stars: BackgroundStar[];
}

const NAME_A = ['ア', 'カ', 'サ', 'タ', 'ナ', 'ハ', 'マ', 'ラ', 'ヴェ', 'ソ', 'ル', 'ミ', 'ケ', 'ト', 'ノ', 'セ', 'イ', 'オ'];
const NAME_B = ['ル', 'リス', 'ナ', 'ラ', 'ドン', 'ティス', 'メル', 'ゴ', 'ネ', 'ヴァ', 'ロス', 'キア', 'ス', 'ン', 'デ'];

function bodyName(rng: Rng): string {
  return rng.pick(NAME_A) + rng.pick(NAME_B) + (rng.chance(0.4) ? rng.pick(NAME_B) : '');
}

/** Build the system for a world: the home planet sits where it receives about Earth's sunlight. */
export function generateSystem(seed: number, homeName = '本星'): StarSystem {
  const rng = new Rng(seed).fork('star-system');
  const starMass = rng.range(0.85, 1.15);
  // Main sequence: L ∝ M^3.5 (in units of the present Sun), lifetime ∝ M^-2.5.
  const baseLuminosity = Math.pow(starMass, 3.5);
  const lifetime = 1e10 * Math.pow(starMass, -2.5);
  // Planets form within the star's first ~100 Myr, so the world starts under a
  // faint young star that brightens by ~40 % over its main-sequence life.
  const ageAtFormation = rng.range(0.003, 0.012) * lifetime;
  // Home orbit: present-day-equivalent insolation of ≈ 1 Earth at ~4.6 Gyr.
  const homeA = Math.sqrt(baseLuminosity);
  const bodies: Body[] = [];
  const count = 5 + rng.int(4);
  // Geometric spacing (Titius–Bode-like), the home world among them.
  const homeIndex = 1 + rng.int(2);
  const ratio = rng.range(1.5, 1.9);
  for (let k = 0; k < count; k++) {
    const a = homeA * Math.pow(ratio, k - homeIndex) * rng.range(0.92, 1.08);
    const home = k === homeIndex;
    const frost = a > 2.7 * homeA;
    const kind: BodyKind = home
      ? 'ocean'
      : frost
        ? k % 3 === 2 ? 'icegiant' : rng.chance(0.65) ? 'gas' : 'ice'
        : a < homeA ? rng.chance(0.5) ? 'rocky' : 'desert' : rng.chance(0.6) ? 'desert' : 'rocky';
    const mass = home ? 1 : kind === 'gas' ? rng.range(40, 400) : kind === 'icegiant' ? rng.range(10, 25) : rng.range(0.05, 2.5);
    const radius = home ? 1 : kind === 'gas' ? rng.range(8, 12) : kind === 'icegiant' ? rng.range(3.5, 4.2) : Math.pow(mass, 0.28);
    const period = Math.pow(a, 1.5) / Math.sqrt(starMass);
    bodies.push({
      id: bodies.length,
      name: home ? homeName : bodyName(rng),
      kind,
      mass,
      radius,
      orbit: {
        a,
        e: home ? 0.017 : rng.range(0, 0.12),
        i: home ? 0 : rng.range(0, 0.06),
        node: rng.range(0, Math.PI * 2),
        peri: rng.range(0, Math.PI * 2),
        m0: rng.range(0, Math.PI * 2),
        period,
      },
      parent: -1,
      tempC: 0,
      habitability: 0,
      home,
      color: KIND_COLOR[kind],
    });
  }
  const homeId = homeIndex;
  // Moons of the home world: 0–3, the first large enough for eclipses and tides.
  const moons: number[] = [];
  const nMoons = rng.chance(0.85) ? 1 + (rng.chance(0.35) ? 1 : 0) + (rng.chance(0.15) ? 1 : 0) : 0;
  for (let m = 0; m < nMoons; m++) {
    const aKm = 384_400 * rng.range(0.6, 1.6) * (1 + m * 1.4);
    const periodDays = 27.3 * Math.pow(aKm / 384_400, 1.5);
    const id = bodies.length;
    bodies.push({
      id,
      name: bodyName(rng),
      kind: 'moon',
      mass: m === 0 ? rng.range(0.008, 0.02) : rng.range(0.0005, 0.004),
      radius: m === 0 ? rng.range(0.22, 0.3) : rng.range(0.05, 0.15),
      orbit: { a: aKm / 1.496e8, e: rng.range(0.01, 0.07), i: rng.range(0.03, 0.12), node: rng.range(0, 6.28), peri: rng.range(0, 6.28), m0: rng.range(0, 6.28), period: periodDays / 365.25 },
      parent: homeId,
      tempC: 0,
      habitability: 0,
      home: false,
      color: '#c9c4b8',
    });
    moons.push(id);
  }
  // Background stars for constellations (seeded, fixed in the ecliptic frame).
  const stars: BackgroundStar[] = [];
  for (let s = 0; s < 420; s++) {
    const u = rng.range(-1, 1);
    stars.push({ lon: rng.range(0, Math.PI * 2), lat: Math.asin(u), mag: 1 + 5 * Math.pow(rng.next(), 0.6) });
  }
  const sys: StarSystem = {
    starName: bodyName(rng),
    starMass,
    baseLuminosity,
    lifetime,
    ageAtFormation,
    bodies,
    homeId,
    moons,
    stars,
  };
  updateBodyClimates(sys, 0);
  return sys;
}

const KIND_COLOR: Record<BodyKind, string> = {
  rocky: '#a08d7a',
  ocean: '#3f7cc0',
  desert: '#c9945e',
  ice: '#cfe2ee',
  gas: '#d8b58a',
  icegiant: '#8fc4d8',
  moon: '#c9c4b8',
};

/** Star luminosity (relative to the present Sun) at world time t (years since the world formed). */
export function luminosity(sys: StarSystem, worldYears: number): number {
  const age = sys.ageAtFormation + worldYears;
  const x = age / sys.lifetime;
  // Faint young star: L(t) ≈ L0 / (1 + 0.4 (1 − t/t☉)), brightening on the main sequence,
  // then swelling quickly toward the red-giant branch at the end of its life.
  const ms = sys.baseLuminosity / Math.max(0.3, 1 + 0.4 * (1 - x / 0.46));
  if (x < 0.9) return ms;
  return ms * (1 + Math.pow((x - 0.9) / 0.1, 3) * 50);
}

/** Has the star left the main sequence (its world doomed)? */
export function starStage(sys: StarSystem, worldYears: number): 'main' | 'subgiant' | 'giant' {
  const x = (sys.ageAtFormation + worldYears) / sys.lifetime;
  return x < 0.9 ? 'main' : x < 1 ? 'subgiant' : 'giant';
}

/** Mean anomaly → eccentric anomaly (Newton). */
function eccentricAnomaly(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

/** Heliocentric (or planetocentric for moons) ecliptic position in AU at world time t (years). */
export function bodyPosition(body: Body, t: number, out = new Float64Array(3)): Float64Array {
  const o = body.orbit;
  const M = o.m0 + (2 * Math.PI * t) / o.period;
  const E = eccentricAnomaly(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), o.e);
  const xv = o.a * (Math.cos(E) - o.e);
  const yv = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r = Math.hypot(xv, yv);
  const cn = Math.cos(o.node), sn = Math.sin(o.node), ci = Math.cos(o.i), si = Math.sin(o.i);
  const u = v + o.peri;
  const cu = Math.cos(u), su = Math.sin(u);
  out[0] = r * (cn * cu - sn * su * ci);
  out[1] = r * (sn * cu + cn * su * ci);
  out[2] = r * (su * si);
  return out;
}

/** Position of any body around the star (moons: parent + offset). */
export function heliocentric(sys: StarSystem, id: number, t: number, out = new Float64Array(3)): Float64Array {
  const b = sys.bodies[id];
  bodyPosition(b, t, out);
  if (b.parent >= 0) {
    const p = heliocentric(sys, b.parent, t, new Float64Array(3));
    out[0] += p[0]; out[1] += p[1]; out[2] += p[2];
  }
  return out;
}

/** Ecliptic longitude (radians, 0..2π) of a body seen from the home world. */
export function geocentricLongitude(sys: StarSystem, id: number, t: number): number {
  const h = heliocentric(sys, sys.homeId, t);
  if (id < 0) return norm(Math.atan2(-h[1], -h[0])); // the star
  const p = heliocentric(sys, id, t);
  return norm(Math.atan2(p[1] - h[1], p[0] - h[0]));
}

/** Ecliptic latitude of a body seen from home (for eclipses). */
export function geocentricLatitude(sys: StarSystem, id: number, t: number): number {
  const h = heliocentric(sys, sys.homeId, t);
  const p = heliocentric(sys, id, t);
  const dx = p[0] - h[0], dy = p[1] - h[1], dz = p[2] - h[2];
  return Math.atan2(dz, Math.hypot(dx, dy));
}

function norm(a: number): number {
  return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

/**
 * Orbital forcing of the home world (Milankovitch): obliquity and
 * eccentricity oscillate with ≈ 41 kyr and ≈ 100/400 kyr periods.
 */
export function orbitalElements(sys: StarSystem, baseTiltDeg: number, t: number): { tiltDeg: number; ecc: number; precession: number } {
  const ph = sys.starMass * 1000; // per-system phase offset
  const tiltDeg = baseTiltDeg + 1.2 * Math.sin((2 * Math.PI * t) / 41_000 + ph);
  const ecc = Math.max(0, 0.028 + 0.018 * Math.sin((2 * Math.PI * t) / 100_000 + ph * 1.3) + 0.012 * Math.sin((2 * Math.PI * t) / 405_000 + ph * 0.7));
  const precession = ((2 * Math.PI * t) / 23_000 + ph * 0.3) % (2 * Math.PI);
  return { tiltDeg, ecc, precession };
}

/** World time at which the star shines as the Sun does today (46 % of its life). */
export function presentEpoch(sys: StarSystem): number {
  return Math.max(0, 0.46 * sys.lifetime - sys.ageAtFormation);
}

/** Solar constant at the home world (W/m²), including eccentricity. */
export function solarConstant(sys: StarSystem, t: number, ecc: number): number {
  const a = sys.bodies[sys.homeId].orbit.a;
  return (1361 * luminosity(sys, t)) / (a * a * Math.sqrt(1 - ecc * ecc));
}

/** Equilibrium temperatures and habitability of every body (for space colonisation). */
export function updateBodyClimates(sys: StarSystem, t: number): void {
  const L = luminosity(sys, t);
  for (const b of sys.bodies) {
    const a = b.parent >= 0 ? sys.bodies[b.parent].orbit.a : b.orbit.a;
    const albedo = b.kind === 'ice' || b.kind === 'icegiant' ? 0.6 : b.kind === 'gas' ? 0.45 : b.kind === 'moon' ? 0.12 : 0.3;
    const teq = 278.6 * Math.pow(L, 0.25) * Math.pow(1 - albedo, 0.25) / Math.sqrt(a) - 273.15;
    const greenhouse = b.home ? 33 : b.kind === 'desert' && b.mass > 0.5 ? 20 : 0;
    b.tempC = teq + greenhouse;
    if (b.kind === 'gas' || b.kind === 'icegiant') b.habitability = 0;
    else {
      const tScore = Math.exp(-Math.pow((b.tempC - 15) / 45, 2));
      const gScore = Math.exp(-Math.pow(Math.log(Math.max(0.01, b.mass)), 2) / 3);
      b.habitability = b.home ? 1 : Math.max(0.02, tScore * gScore * (b.kind === 'moon' ? 0.4 : 0.8));
    }
  }
}

/** Light-time/Δv-style transfer cost between home and a body (relative units; 1 ≈ home→moon). */
export function transferCost(sys: StarSystem, id: number, t: number): number {
  const b = sys.bodies[id];
  if (b.parent === sys.homeId) return 1;
  const h = heliocentric(sys, sys.homeId, t);
  const p = heliocentric(sys, id, t);
  const d = Math.hypot(p[0] - h[0], p[1] - h[1], p[2] - h[2]);
  const aRatio = b.orbit.a / sys.bodies[sys.homeId].orbit.a;
  // Hohmann Δv grows with the orbit ratio; the current distance stands for the launch window.
  const base = 3 + 4 * Math.abs(Math.log(aRatio));
  const minD = Math.abs(b.orbit.a - sys.bodies[sys.homeId].orbit.a);
  return base * (1 + 0.6 * (d - minD) / Math.max(0.1, b.orbit.a + sys.bodies[sys.homeId].orbit.a));
}
