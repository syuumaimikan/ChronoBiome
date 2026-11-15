import type { FieldName, WorldFields } from '../core/world/state';
import type { TownBrief, WorldInfo } from '../worker/protocol';

/**
 * Map layers: which fields a layer needs and how a cell value becomes a colour.
 * Colours are written straight into an RGB byte array (3 bytes per cell).
 */

export type LayerId =
  | 'biome' | 'elevation' | 'plates' | 'crust' | 'crustAge' | 'temperature' | 'tempMean' | 'moisture'
  | 'territory' | 'population' | 'landUse' | 'richness' | 'mana' | 'range';

/** Extra data some layers paint from (not world fields). */
export interface PaintContext {
  /** Density of one species per cell (range layer). */
  range: Float32Array | null;
  towns: TownBrief[];
}

/** Drainage (cells of rain) above which a land cell is drawn as a river. */
const RIVER_MIN_FLOW = 10;

/** Blend river blue into land cells with large drainage. */
function paintRivers(out: Uint8Array, flow: Float32Array, elevation: Float32Array, sea: number): void {
  const lo = Math.log(RIVER_MIN_FLOW);
  const span = Math.log(200) - lo;
  for (let i = 0; i < flow.length; i++) {
    const f = flow[i];
    if (f < RIVER_MIN_FLOW || elevation[i] < sea) continue;
    const t = Math.min(0.85, 0.45 + (0.4 * (Math.log(f) - lo)) / span);
    const o = i * 3;
    out[o] = out[o] + (44 - out[o]) * t;
    out[o + 1] = out[o + 1] + (110 - out[o + 1]) * t;
    out[o + 2] = out[o + 2] + (190 - out[o + 2]) * t;
  }
}

export interface LegendStop {
  color: string;
  label: string;
}

export interface LayerDef {
  id: LayerId;
  name: string;
  fields: FieldName[];
  /** Continuous legend (gradient) or categorical entries. */
  legend: (world: WorldInfo, fields: Partial<WorldFields>, seaLevel: number, ctx: PaintContext) => { gradient?: string; stops: LegendStop[] };
  paint: (out: Uint8Array, fields: Partial<WorldFields>, world: WorldInfo, seaLevel: number, ctx: PaintContext) => void;
  /** Group in the layer picker. */
  group?: 'nature' | 'people';
}

/** Muted relief underneath human/biological overlays. */
function base(out: Uint8Array, e: Float32Array, sea: number): void {
  for (let i = 0; i < e.length; i++) {
    const o = i * 3;
    if (e[i] < sea) { out[o] = 36; out[o + 1] = 52; out[o + 2] = 74; }
    else {
      const h = Math.min(1, (e[i] - sea) / 4000);
      const g = 104 + 60 * h;
      out[o] = g; out[o + 1] = g; out[o + 2] = g - 6;
    }
  }
}

function mix(out: Uint8Array, o: number, r: number, g: number, b: number, t: number): void {
  out[o] += (r - out[o]) * t;
  out[o + 1] += (g - out[o + 1]) * t;
  out[o + 2] += (b - out[o + 2]) * t;
}

const POP: Stop[] = [
  [0, 120, 120, 112],
  [0.5, 220, 200, 120],
  [5, 236, 150, 60],
  [50, 214, 70, 50],
  [500, 120, 20, 60],
];
const RICH: Stop[] = [
  [0, 110, 110, 104],
  [2, 140, 150, 110],
  [6, 90, 170, 90],
  [12, 30, 140, 90],
  [20, 20, 90, 120],
];
const MANA: Stop[] = [
  [0, 40, 40, 60],
  [0.3, 70, 60, 140],
  [0.7, 140, 90, 220],
  [1.2, 220, 160, 250],
  [2, 255, 240, 255],
];
const popRamp = ramp(POP);
const richRamp = ramp(RICH);
const manaRamp = ramp(MANA);

type Stop = [number, number, number, number]; // value, r, g, b

function ramp(stops: Stop[]) {
  return (v: number, out: Uint8Array, o: number) => {
    if (v <= stops[0][0]) {
      out[o] = stops[0][1]; out[o + 1] = stops[0][2]; out[o + 2] = stops[0][3];
      return;
    }
    for (let i = 1; i < stops.length; i++) {
      const b = stops[i];
      if (v <= b[0]) {
        const a = stops[i - 1];
        const t = (v - a[0]) / (b[0] - a[0]);
        out[o] = a[1] + (b[1] - a[1]) * t;
        out[o + 1] = a[2] + (b[2] - a[2]) * t;
        out[o + 2] = a[3] + (b[3] - a[3]) * t;
        return;
      }
    }
    const l = stops[stops.length - 1];
    out[o] = l[1]; out[o + 1] = l[2]; out[o + 2] = l[3];
  };
}

const css = (s: Stop) => `rgb(${s[1]},${s[2]},${s[3]})`;
const gradient = (stops: Stop[]) => {
  const lo = stops[0][0], hi = stops[stops.length - 1][0];
  return `linear-gradient(to right, ${stops.map((s) => `${css(s)} ${(((s[0] - lo) / (hi - lo)) * 100).toFixed(1)}%`).join(', ')})`;
};

const OCEAN: Stop[] = [
  [-8000, 10, 24, 58],
  [-4000, 22, 52, 102],
  [-1000, 40, 92, 150],
  [0, 78, 140, 186],
];
const LAND: Stop[] = [
  [0, 70, 128, 72],
  [400, 112, 156, 84],
  [1200, 176, 170, 104],
  [2500, 150, 116, 80],
  [4000, 122, 104, 96],
  [5500, 236, 236, 240],
];
const TEMP: Stop[] = [
  [-40, 74, 32, 122],
  [-25, 52, 82, 192],
  [-10, 92, 160, 228],
  [0, 226, 240, 250],
  [8, 176, 220, 150],
  [16, 244, 220, 108],
  [24, 240, 150, 62],
  [32, 206, 62, 46],
  [40, 128, 20, 40],
];
const TEMP_LEGEND = () => ({
  gradient: gradient(TEMP),
  stops: [
    { color: css(TEMP[0]), label: '-40℃' },
    { color: css(TEMP[3]), label: '0℃' },
    { color: css(TEMP[8]), label: '40℃' },
  ],
});
const MOIST: Stop[] = [
  [0, 186, 144, 90],
  [0.25, 216, 196, 120],
  [0.5, 120, 176, 90],
  [0.75, 40, 128, 90],
  [1, 30, 80, 140],
];

const oceanRamp = ramp(OCEAN);
const landRamp = ramp(LAND);
const tempRamp = ramp(TEMP);
const moistRamp = ramp(MOIST);

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const PLATE_HUES = [12, 48, 95, 160, 200, 235, 275, 320, 30, 140, 185, 255, 300, 345, 70, 115];
function plateColor(p: number, continental: boolean): [number, number, number] {
  const h = PLATE_HUES[p % PLATE_HUES.length] + 7 * Math.floor(p / PLATE_HUES.length);
  const s = continental ? 0.45 : 0.6;
  const l = continental ? 0.64 : 0.36;
  return hsl(h, s, l);
}

const CRUST: Stop[] = [
  [5, 24, 40, 92],
  [10, 46, 90, 150],
  [18, 120, 150, 120],
  [32, 196, 176, 120],
  [50, 176, 100, 70],
  [70, 240, 230, 225],
];
const AGE: Stop[] = [
  [0, 230, 60, 50],
  [20, 240, 160, 60],
  [50, 230, 220, 110],
  [90, 80, 170, 150],
  [150, 40, 70, 140],
];
const crustRamp = ramp(CRUST);
const ageRamp = ramp(AGE);
const CONTINENTAL_KM = 18;

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export const LAYERS: LayerDef[] = [
  {
    id: 'biome',
    name: 'バイオーム',
    fields: ['biome', 'flow', 'elevation'],
    legend: (world, fields) => {
      const present = new Set<number>(fields.biome ?? []);
      return {
        stops: [
          ...world.biomes.filter((_, i) => present.has(i)).map((b) => ({ color: b.color, label: b.name })),
          { color: 'rgb(44,110,190)', label: '大河' },
        ],
      };
    },
    paint: (out, f, world, sea) => {
      const cols = world.biomes.map((b) => hexToRgb(b.color));
      const biome = f.biome!;
      for (let i = 0; i < biome.length; i++) {
        const c = cols[biome[i]] ?? [255, 0, 255];
        out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
      }
      paintRivers(out, f.flow!, f.elevation!, sea);
    },
  },
  {
    id: 'elevation',
    name: '標高',
    fields: ['elevation', 'flow'],
    legend: () => ({
      gradient: gradient([...OCEAN, ...LAND]),
      stops: [
        { color: css(OCEAN[0]), label: '-8000 m' },
        { color: css(LAND[0]), label: '海面' },
        { color: css(LAND[LAND.length - 1]), label: '5500 m+' },
      ],
    }),
    paint: (out, f, _w, sea) => {
      const e = f.elevation!;
      for (let i = 0; i < e.length; i++) {
        const h = e[i] - sea;
        if (h < 0) oceanRamp(h, out, i * 3);
        else landRamp(h, out, i * 3);
      }
      paintRivers(out, f.flow!, e, sea);
    },
  },
  {
    id: 'plates',
    name: 'プレート',
    fields: ['plate', 'crustThickness'],
    legend: () => ({
      stops: [
        { color: `rgb(${plateColor(0, true).join(',')})`, label: '大陸地殻（明）' },
        { color: `rgb(${plateColor(0, false).join(',')})`, label: '海洋地殻（暗）' },
        { color: 'transparent', label: '色相 = プレート' },
      ],
    }),
    paint: (out, f) => {
      const plate = f.plate!;
      const T = f.crustThickness!;
      const cache = new Map<number, [number, number, number]>();
      for (let i = 0; i < plate.length; i++) {
        const key = plate[i] * 2 + (T[i] >= CONTINENTAL_KM ? 1 : 0);
        let c = cache.get(key);
        if (!c) {
          c = plateColor(plate[i], (key & 1) === 1);
          cache.set(key, c);
        }
        out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
      }
    },
  },
  {
    id: 'crust',
    name: '地殻の厚さ',
    fields: ['crustThickness'],
    legend: () => ({
      gradient: gradient(CRUST),
      stops: [{ color: css(CRUST[0]), label: '5 km（海洋）' }, { color: css(CRUST[3]), label: '32 km' }, { color: css(CRUST[5]), label: '70 km（造山帯）' }],
    }),
    paint: (out, f) => {
      const T = f.crustThickness!;
      for (let i = 0; i < T.length; i++) crustRamp(T[i], out, i * 3);
    },
  },
  {
    id: 'crustAge',
    name: '海洋底の年齢',
    fields: ['crustAge', 'crustThickness'],
    legend: () => ({
      gradient: gradient(AGE),
      stops: [{ color: css(AGE[0]), label: '0（海嶺）' }, { color: css(AGE[2]), label: '5000万年' }, { color: css(AGE[4]), label: '1.5億年' }],
    }),
    paint: (out, f) => {
      const A = f.crustAge!;
      const T = f.crustThickness!;
      for (let i = 0; i < A.length; i++) {
        if (T[i] >= CONTINENTAL_KM) { out[i * 3] = 92; out[i * 3 + 1] = 92; out[i * 3 + 2] = 98; }
        else ageRamp(A[i], out, i * 3);
      }
    },
  },
  {
    id: 'temperature',
    name: '気温（現在）',
    fields: ['temperature'],
    legend: TEMP_LEGEND,
    paint: (out, f) => {
      const t = f.temperature!;
      for (let i = 0; i < t.length; i++) tempRamp(t[i], out, i * 3);
    },
  },
  {
    id: 'tempMean',
    name: '年平均気温',
    fields: ['tempMean'],
    legend: TEMP_LEGEND,
    paint: (out, f) => {
      const t = f.tempMean!;
      for (let i = 0; i < t.length; i++) tempRamp(t[i], out, i * 3);
    },
  },
  {
    id: 'moisture',
    name: '湿潤度',
    fields: ['moisture', 'elevation'],
    legend: () => ({ gradient: gradient(MOIST), stops: [{ color: css(MOIST[0]), label: '乾燥' }, { color: css(MOIST[4]), label: '湿潤' }] }),
    paint: (out, f, _w, sea) => {
      const m = f.moisture!;
      const e = f.elevation!;
      for (let i = 0; i < m.length; i++) {
        if (e[i] < sea) { out[i * 3] = 52; out[i * 3 + 1] = 70; out[i * 3 + 2] = 96; }
        else moistRamp(m[i], out, i * 3);
      }
    },
  },
  {
    id: 'territory',
    name: '国と領土',
    group: 'people',
    fields: ['territory', 'elevation', 'landUse'],
    legend: (_w, _f, _s, ctx) => {
      const seen = new Map<number, { color: string; name: string; pop: number }>();
      for (const t of ctx.towns) {
        const p = seen.get(t.polity);
        if (p) p.pop += t.pop;
        else if (t.polity >= 0) seen.set(t.polity, { color: t.color, name: t.capital ? t.name : '', pop: t.pop });
      }
      const list = [...seen.values()].sort((a, b) => b.pop - a.pop).slice(0, 8);
      return {
        stops: list.length
          ? [...list.map((p) => ({ color: p.color, label: p.name ? `${p.name}の国` : '国' })), { color: 'rgb(60,40,30)', label: '遺跡' }]
          : [{ color: 'transparent', label: 'まだ国はない' }],
      };
    },
    paint: (out, f, _w, sea, ctx) => {
      base(out, f.elevation!, sea);
      const col = new Map<number, [number, number, number]>();
      for (const t of ctx.towns) if (!col.has(t.polity)) col.set(t.polity, hexToRgb(t.color));
      const T = f.territory!;
      const U = f.landUse!;
      for (let i = 0; i < T.length; i++) {
        const o = i * 3;
        if (U[i] === 3) mix(out, o, 60, 40, 30, 0.7);
        const c = T[i] >= 0 ? col.get(T[i]) : undefined;
        if (!c) continue;
        mix(out, o, c[0], c[1], c[2], U[i] === 2 ? 0.95 : 0.62);
        if (U[i] === 2) { out[o] = Math.min(255, out[o] + 40); out[o + 1] = Math.min(255, out[o + 1] + 40); out[o + 2] = Math.min(255, out[o + 2] + 40); }
      }
    },
  },
  {
    id: 'population',
    name: '人口密度',
    group: 'people',
    fields: ['population', 'elevation'],
    legend: () => ({
      gradient: gradient(POP),
      stops: [{ color: css(POP[0]), label: '0' }, { color: css(POP[2]), label: '5 人/km²' }, { color: css(POP[4]), label: '500 人/km²' }],
    }),
    paint: (out, f, _w, sea) => {
      base(out, f.elevation!, sea);
      const P = f.population!;
      const tmp = new Uint8Array(3);
      for (let i = 0; i < P.length; i++) {
        if (P[i] <= 0.01) continue;
        const o = i * 3;
        popRamp(P[i], tmp, 0);
        mix(out, o, tmp[0], tmp[1], tmp[2], Math.min(0.95, 0.45 + 0.15 * Math.log10(1 + P[i] * 10)));
      }
    },
  },
  {
    id: 'landUse',
    name: '土地利用',
    group: 'people',
    fields: ['landUse', 'biome', 'elevation', 'flow'],
    legend: () => ({
      stops: [
        { color: 'rgb(222,196,96)', label: '農地' },
        { color: 'rgb(230,90,70)', label: '市街地' },
        { color: 'rgb(70,50,40)', label: '遺跡' },
        { color: 'rgb(120,140,110)', label: '自然' },
      ],
    }),
    paint: (out, f, world, sea) => {
      const cols = world.biomes.map((b) => hexToRgb(b.color));
      const B = f.biome!;
      const U = f.landUse!;
      for (let i = 0; i < B.length; i++) {
        const c = cols[B[i]] ?? [128, 128, 128];
        const o = i * 3;
        // Wild land is drawn desaturated so human marks stand out.
        const g = (c[0] + c[1] + c[2]) / 3;
        out[o] = (c[0] + g) / 2; out[o + 1] = (c[1] + g) / 2; out[o + 2] = (c[2] + g) / 2;
        if (U[i] === 1) mix(out, o, 222, 196, 96, 0.85);
        else if (U[i] === 2) mix(out, o, 230, 90, 70, 0.95);
        else if (U[i] === 3) mix(out, o, 70, 50, 40, 0.85);
      }
      paintRivers(out, f.flow!, f.elevation!, sea);
    },
  },
  {
    id: 'richness',
    name: '種の多様性',
    fields: ['richness', 'elevation'],
    legend: () => ({
      gradient: gradient(RICH),
      stops: [{ color: css(RICH[0]), label: '0 種' }, { color: css(RICH[2]), label: '6' }, { color: css(RICH[4]), label: '20 種+' }],
    }),
    paint: (out, f) => {
      const R = f.richness!;
      for (let i = 0; i < R.length; i++) richRamp(R[i], out, i * 3);
    },
  },
  {
    id: 'mana',
    name: 'マナ濃度',
    fields: ['mana'],
    legend: () => ({
      gradient: gradient(MANA),
      stops: [{ color: css(MANA[0]), label: '枯渇' }, { color: css(MANA[2]), label: '平常' }, { color: css(MANA[4]), label: '霊脈' }],
    }),
    paint: (out, f) => {
      const M = f.mana!;
      for (let i = 0; i < M.length; i++) manaRamp(M[i], out, i * 3);
    },
  },
  {
    id: 'range',
    name: '種の分布',
    fields: ['elevation'],
    legend: (_w, _f, _s, ctx) => ({
      stops: ctx.range ? [{ color: 'rgb(250,210,60)', label: '多い' }, { color: 'rgb(160,120,40)', label: '少ない' }] : [{ color: 'transparent', label: '生物の詳細から「分布を見る」' }],
    }),
    paint: (out, f, _w, sea, ctx) => {
      base(out, f.elevation!, sea);
      const D = ctx.range;
      if (!D) return;
      let mx = 0;
      for (let i = 0; i < D.length; i++) mx = Math.max(mx, D[i]);
      if (mx <= 0) return;
      for (let i = 0; i < D.length; i++) {
        if (D[i] <= 0) continue;
        const t = Math.sqrt(D[i] / mx);
        mix(out, i * 3, 160 + 90 * t, 120 + 90 * t, 40 + 20 * t, 0.55 + 0.4 * t);
      }
    },
  },
];

export function layerById(id: LayerId): LayerDef {
  return LAYERS.find((l) => l.id === id) ?? LAYERS[0];
}
