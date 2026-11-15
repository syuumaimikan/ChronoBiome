import { hashCombine } from '../../hash';
import { Rng } from '../../rng';
import { geocentricLatitude, geocentricLongitude, type StarSystem } from '../../universe/system';

/**
 * Astrology from the real (simulated) sky: an ephemeris of the star, moons and
 * planets seen from the home world, aspects between them, eclipses and comets,
 * constellations drawn from the background stars, birth charts, and the
 * solstice alignment of monuments. Cultures read meaning into it (morale,
 * religions); with arcane rules the configuration also moves mana.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

export const ASPECTS = [
  { id: 'conjunction', name: '合', angle: 0, weight: 1 },
  { id: 'sextile', name: 'セクスタイル', angle: 60, weight: 0.3 },
  { id: 'square', name: 'スクエア', angle: 90, weight: -0.6 },
  { id: 'trine', name: 'トライン', angle: 120, weight: 0.6 },
  { id: 'opposition', name: '衝', angle: 180, weight: -0.8 },
] as const;
export type AspectId = (typeof ASPECTS)[number]['id'];

export const SIGN_ELEMENTS = ['火', '地', '風', '水'] as const;

const MOTIFS = [
  '狩人', '竜', '天秤', '双魚', '冠', '舟', '弓', '狼', '大樹', '鏡', '塔', '鍵', '角獣', '蛇', '鷲', '杯', '車輪', '琴', '鎌', '牡牛',
  '乙女', '獅子', '蠍', '山羊', '水瓶', '蟹', '鯨', '鶴', '亀', '槍', '炉', '翼', '門', '糸車', '鈴', '仮面', '羊飼い', '巨人', '王座', '泉',
];

export interface SkyBody {
  id: number;
  name: string;
  /** Ecliptic longitude / latitude seen from home (radians). */
  lon: number;
  lat: number;
  kind: 'star' | 'moon' | 'planet';
  color: string;
}

export function ephemeris(sys: StarSystem, t: number): SkyBody[] {
  const out: SkyBody[] = [{ id: -1, name: sys.starName, lon: geocentricLongitude(sys, -1, t), lat: 0, kind: 'star', color: '#ffe8a0' }];
  for (const b of sys.bodies) {
    if (b.home) continue;
    out.push({ id: b.id, name: b.name, lon: geocentricLongitude(sys, b.id, t), lat: geocentricLatitude(sys, b.id, t), kind: b.kind === 'moon' ? 'moon' : 'planet', color: b.color });
  }
  return out;
}

/** 0 = new moon, 0.5 = full moon (main moon). */
export function moonPhase(sys: StarSystem, t: number): number {
  if (!sys.moons.length) return 0;
  const d = geocentricLongitude(sys, sys.moons[0], t) - geocentricLongitude(sys, -1, t);
  return (((d / TAU) % 1) + 1) % 1;
}

export interface Aspect {
  a: number;
  b: number;
  type: AspectId;
  name: string;
  /** Degrees from exact. */
  off: number;
}

export function aspects(bodies: SkyBody[], orbDeg: number): Aspect[] {
  const out: Aspect[] = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      let d = Math.abs(bodies[i].lon - bodies[j].lon) / DEG;
      if (d > 180) d = 360 - d;
      for (const a of ASPECTS) {
        const off = Math.abs(d - a.angle);
        if (off <= orbDeg) out.push({ a: bodies[i].id, b: bodies[j].id, type: a.id, name: a.name, off });
      }
    }
  }
  return out;
}

export function signOf(lon: number): number {
  return Math.floor((((lon / TAU) % 1) + 1) % 1 * 12) % 12;
}

// ---------------------------------------------------------------- constellations

export interface Constellation {
  name: string;
  stars: number[];
  lines: [number, number][];
  lon: number;
  lat: number;
  zodiac: boolean;
}

/** Constellations a culture draws (its seed picks motifs and how stars are grouped). */
export function constellations(sys: StarSystem, cultureSeed: number): Constellation[] {
  const rng = new Rng(hashCombine(cultureSeed, 0xc0475));
  const motifs = [...MOTIFS];
  const takeName = () => motifs.splice(rng.int(motifs.length), 1)[0] + '座';
  const stars = sys.stars;
  const used = new Set<number>();
  const out: Constellation[] = [];
  const angDist = (i: number, j: number) => {
    const a = stars[i], b = stars[j];
    const c = Math.sin(a.lat) * Math.sin(b.lat) + Math.cos(a.lat) * Math.cos(b.lat) * Math.cos(a.lon - b.lon);
    return Math.acos(Math.max(-1, Math.min(1, c)));
  };
  const link = (members: number[]) => {
    // Minimum spanning tree: the lines a culture would draw between neighbours.
    const lines: [number, number][] = [];
    const inTree = [members[0]];
    const rest = members.slice(1);
    while (rest.length) {
      let best = 0, bi = 0, bd = Infinity;
      for (let r = 0; r < rest.length; r++) for (const t of inTree) {
        const d = angDist(rest[r], t);
        if (d < bd) { bd = d; best = r; bi = t; }
      }
      lines.push([bi, rest[best]]);
      inTree.push(rest.splice(best, 1)[0]);
    }
    return lines;
  };
  // The zodiac: twelve thirty-degree sectors of the ecliptic.
  for (let k = 0; k < 12; k++) {
    const lo = k * 30 * DEG, hi = (k + 1) * 30 * DEG;
    const members = stars
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.lon >= lo && s.lon < hi && Math.abs(s.lat) < 14 * DEG)
      .sort((a, b) => a.s.mag - b.s.mag)
      .slice(0, 4 + rng.int(4))
      .map((x) => x.i);
    members.forEach((i) => used.add(i));
    out.push({ name: takeName(), stars: members, lines: members.length > 1 ? link(members) : [], lon: (k + 0.5) * 30 * DEG, lat: 0, zodiac: true });
  }
  // Others: grow groups from the brightest unused stars.
  const order = stars.map((s, i) => ({ s, i })).filter(({ i }) => !used.has(i)).sort((a, b) => a.s.mag - b.s.mag);
  for (const { i } of order) {
    if (out.length >= 30 || used.has(i)) continue;
    const near = order.filter(({ i: j }) => !used.has(j) && j !== i && angDist(i, j) < 14 * DEG).slice(0, 3 + rng.int(4)).map((x) => x.i);
    if (near.length < 2) continue;
    const members = [i, ...near];
    members.forEach((m) => used.add(m));
    out.push({ name: takeName(), stars: members, lines: link(members), lon: stars[i].lon, lat: stars[i].lat, zodiac: false });
  }
  return out;
}

// ---------------------------------------------------------------- events

export interface SkyEvent {
  time: number;
  kind: 'solar_eclipse' | 'lunar_eclipse' | 'conjunction' | 'comet';
  text: string;
  bodies: number[];
}

/** Notable sky events in [t0, t1). Long spans are sampled, so only some events are found. */
export function skyEvents(sys: StarSystem, seed: number, t0: number, t1: number, max = 24): SkyEvent[] {
  const out: SkyEvent[] = [];
  const span = t1 - t0;
  if (span <= 0) return out;
  const windows: [number, number][] = [];
  if (span <= 2) windows.push([t0, t1]);
  else {
    // Sample a few one-year windows spread over the span.
    const n = Math.min(4, Math.ceil(span));
    for (let k = 0; k < n; k++) {
      const s = t0 + (span * (k + (hashCombine(seed, Math.floor(t0) + k) >>> 0) / 4294967296)) / n;
      windows.push([s, Math.min(t1, s + 1)]);
    }
  }
  const moon = sys.moons[0];
  for (const [a, b] of windows) {
    if (moon !== undefined) {
      const step = 0.4 / 365;
      let prev = Infinity;
      let prevT = a;
      let falling = false;
      for (let t = a; t < b && out.length < max; t += step) {
        const d = angleBetween(geocentricLongitude(sys, moon, t), geocentricLongitude(sys, -1, t));
        const full = Math.abs(Math.PI - d);
        const m = Math.min(d, full);
        if (m > prev && falling && prev < 1.2 * DEG) {
          const beta = Math.abs(geocentricLatitude(sys, moon, prevT));
          if (beta < 0.9 * DEG) {
            const solar = angleBetween(geocentricLongitude(sys, moon, prevT), geocentricLongitude(sys, -1, prevT)) < Math.PI / 2;
            out.push({
              time: prevT,
              kind: solar ? 'solar_eclipse' : 'lunar_eclipse',
              text: solar ? `日食：${sys.bodies[moon].name}が${sys.starName}を覆い隠した` : `月食：${sys.bodies[moon].name}が赤く翳った`,
              bodies: [moon, -1],
            });
          }
        }
        falling = m < prev;
        prev = m;
        prevT = t;
      }
    }
    // Great conjunctions of the two brightest planets.
    const planets = sys.bodies.filter((x) => !x.home && x.kind !== 'moon').sort((x, y) => y.radius / y.orbit.a - x.radius / x.orbit.a).slice(0, 2);
    if (planets.length === 2) {
      const step = 5 / 365;
      for (let t = a; t < b && out.length < max; t += step) {
        const d = angleBetween(geocentricLongitude(sys, planets[0].id, t), geocentricLongitude(sys, planets[1].id, t));
        if (d < 1 * DEG) {
          out.push({ time: t, kind: 'conjunction', text: `大会合：${planets[0].name}と${planets[1].name}が重なって輝いた`, bodies: [planets[0].id, planets[1].id] });
          t += 0.5;
        }
      }
    }
    // Comets: a few bright ones per century.
    for (let y = Math.floor(a); y < b; y++) {
      const h = (hashCombine(seed ^ 0xc0e7, y) >>> 0) / 4294967296;
      if (h < 0.04 && y >= a) out.push({ time: y + h * 25, kind: 'comet', text: '尾を引く大彗星が夜空に現れた', bodies: [] });
    }
  }
  return out.sort((x, y) => x.time - y.time).slice(0, max);
}

function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % TAU;
  if (d > Math.PI) d = TAU - d;
  return d;
}

// ---------------------------------------------------------------- birth charts

export interface BirthChart {
  sun: number;
  moon: number;
  asc: number;
  element: string;
  aspects: Aspect[];
  /** Value modifiers (aggression, commerce, piety, tradition, science), −0.1..0.1. */
  traits: number[];
  text: string;
}

/** Birth chart for a moment and longitude (degrees). `signs` are the culture's zodiac names. */
export function birthChart(sys: StarSystem, t: number, lonDeg: number, signs: string[], orbDeg = 6): BirthChart {
  const eph = ephemeris(sys, t);
  const sunLon = eph[0].lon;
  const moonB = eph.find((b) => b.kind === 'moon');
  const sun = signOf(sunLon);
  const moon = moonB ? signOf(moonB.lon) : sun;
  // Ascendant: the sign rising in the east at the moment of birth (day fraction + longitude).
  const dayFrac = t * 365.25 - Math.floor(t * 365.25);
  const asc = signOf(sunLon + TAU * dayFrac + lonDeg * DEG + Math.PI / 2);
  const count = [0, 0, 0, 0];
  count[sun % 4] += 2;
  count[moon % 4] += 1.5;
  count[asc % 4] += 1;
  const el = count.indexOf(Math.max(...count));
  const asp = aspects(eph, orbDeg);
  const harmony = asp.reduce((s, a) => s + (ASPECTS.find((x) => x.id === a.type)?.weight ?? 0), 0);
  // Fire → bold, earth → steady, air → curious, water → devout.
  const traits = [
    el === 0 ? 0.08 : 0, el === 2 ? 0.05 : 0, el === 3 ? 0.08 : 0, el === 1 ? 0.08 : 0, el === 2 ? 0.08 : 0,
  ].map((v, i) => v + (i === 0 ? -0.01 * harmony : 0));
  const sn = (k: number) => signs[k] ?? `第${k + 1}宮`;
  const text = `太陽 ${sn(sun)}・月 ${sn(moon)}・上昇宮 ${sn(asc)}（${SIGN_ELEMENTS[el]}の気質）${asp.length ? `、${asp.slice(0, 3).map((a) => a.name).join('・')}` : ''}`;
  return { sun, moon, asc, element: SIGN_ELEMENTS[el], aspects: asp, traits, text };
}

// ---------------------------------------------------------------- alignment

/** Azimuth (degrees from north) of sunrise at the summer solstice; NaN in polar day/night. */
export function solsticeSunriseAzimuth(latRad: number, tiltDeg: number): number {
  const c = Math.sin(tiltDeg * DEG) / Math.cos(latRad);
  if (Math.abs(c) >= 1) return NaN;
  return Math.acos(c) / DEG;
}

/** Arcane mana multiplier from the current configuration (0.6..1.8). */
export function arcaneFactor(sys: StarSystem, t: number, orbDeg: number): number {
  const asp = aspects(ephemeris(sys, t), orbDeg);
  let s = 0;
  for (const a of asp) s += (ASPECTS.find((x) => x.id === a.type)?.weight ?? 0) * (1 - a.off / orbDeg);
  const phase = moonPhase(sys, t);
  const full = 1 - Math.abs(phase - 0.5) * 2;
  return Math.max(0.6, Math.min(1.8, 1 + 0.08 * s + 0.25 * (full - 0.5)));
}
