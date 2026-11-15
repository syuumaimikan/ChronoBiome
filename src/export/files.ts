import { GOODS } from '../core/systems/society/data';
import type { LlmSettings } from '../llm/llm';
import type { MeshPayload } from '../worker/protocol';
import { cartridgeRuntime } from './cartridgeRuntime';

/**
 * Exports that need the render thread: the map raster and the World
 * Cartridge (a single offline HTML file with a small text RPG).
 */

/** Index of the mesh cell nearest to a unit direction, walking greedily from `start`. */
export function nearestCell(mesh: Pick<MeshPayload, 'pos' | 'nbrStart' | 'nbr'>, x: number, y: number, z: number, start: number): number {
  const P = mesh.pos, ns = mesh.nbrStart, nb = mesh.nbr;
  let c = start;
  let best = P[c * 3] * x + P[c * 3 + 1] * y + P[c * 3 + 2] * z;
  for (let guard = 0; guard < 4096; guard++) {
    let next = -1;
    for (let k = ns[c]; k < ns[c + 1]; k++) {
      const n = nb[k];
      const d = P[n * 3] * x + P[n * 3 + 1] * y + P[n * 3 + 2] * z;
      if (d > best) {
        best = d;
        next = n;
      }
    }
    if (next < 0) break;
    c = next;
  }
  return c;
}

/** Equirectangular pixels (RGBA) of per-cell colours; lat +90 at the top, lon −180 at the left. */
export function mapPixels(rgb: Uint8Array, mesh: Pick<MeshPayload, 'pos' | 'nbrStart' | 'nbr'>, width: number): Uint8ClampedArray {
  const H = Math.round(width / 2);
  const out = new Uint8ClampedArray(width * H * 4);
  let rowStart = 0;
  for (let py = 0; py < H; py++) {
    const lat = Math.PI / 2 - ((py + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    let c = rowStart;
    for (let px = 0; px < width; px++) {
      const lon = -Math.PI + ((px + 0.5) / width) * Math.PI * 2;
      // Same convention as the geodesic grid: y up, lon = atan2(z, x).
      c = nearestCell(mesh, cl * Math.cos(lon), sl, cl * Math.sin(lon), c);
      if (px === 0) rowStart = c;
      const o = (py * width + px) * 4;
      out[o] = rgb[c * 3];
      out[o + 1] = rgb[c * 3 + 1];
      out[o + 2] = rgb[c * 3 + 2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The map as a canvas, with a faint 30° graticule. */
export function mapCanvas(rgb: Uint8Array, mesh: MeshPayload, width = 2048): HTMLCanvasElement {
  const H = Math.round(width / 2);
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(width, H);
  img.data.set(mapPixels(rgb, mesh, width));
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = Math.max(1, width / 2048);
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = ((lon + 180) / 360) * width;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H);
    g.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * H;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(width, y);
    g.stroke();
  }
  return cv;
}

interface WorldExport {
  seed: number;
  star: { name: string };
  ruins: { cell: number; lat?: number; lon?: number }[];
  [k: string]: unknown;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Data placed in a <script type="application/json">: never let it close the tag. */
function scriptJson(v: unknown): string {
  // U+2028/2029 are valid in JSON but end lines in older JS parsers.
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

/**
 * A single self-contained HTML file: the world's data, the map and a small
 * text RPG runtime. The LLM settings are carried only as defaults the player
 * can change (endpoint and model, nothing secret).
 */
export function buildCartridge(world: WorldExport, mesh: Pick<MeshPayload, 'lat' | 'lon'> | null, mapDataUrl: string | null, llm: LlmSettings): string {
  if (mesh) {
    for (const r of world.ruins) {
      r.lat = (mesh.lat[r.cell] * 180) / Math.PI;
      r.lon = (mesh.lon[r.cell] * 180) / Math.PI;
    }
  }
  const data = { ...world, goods: GOODS.map((g) => ({ id: g.id, name: g.name })) };
  const gm = { kind: llm.kind, endpoint: llm.endpoint, model: llm.model };
  const title = `${world.star.name}の世界 — ChronoBiome カートリッジ`;
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${CARTRIDGE_CSS}</style></head><body>`,
    '<div id="app"><p>読み込み中…</p></div>',
    `<script type="application/json" id="world">${scriptJson(data)}</script>`,
    `<script type="application/json" id="map">${scriptJson(mapDataUrl)}</script>`,
    `<script type="application/json" id="gm">${scriptJson(gm)}</script>`,
    `<script>(${cartridgeRuntime.toString()})();</script>`,
    '</body></html>',
  ].join('\n');
}

const CARTRIDGE_CSS = `
:root{--bg:#f6f1e7;--fg:#2a241c;--muted:#7a6f60;--card:#fffaf0;--line:#d9cdb8;--accent:#8a4b1f;--good:#2f7a3a;--bad:#a8322a}
@media (prefers-color-scheme:dark){:root{--bg:#16130f;--fg:#eee4d2;--muted:#a59a88;--card:#211d17;--line:#3b342a;--accent:#e0a060;--good:#7fcf8a;--bad:#ef7d6f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "Hiragino Mincho ProN","Yu Mincho",serif}
#app{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:4px 0}h2{font-size:17px;margin:16px 0 6px;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}.small{font-size:13px}.good{color:var(--good)}.bad{color:var(--bad)}
.bar{display:flex;flex-wrap:wrap;gap:12px;padding:8px 12px;background:var(--card);border:1px solid var(--line);border-radius:8px;font-family:system-ui,sans-serif;font-size:13px}
.log{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-height:160px;max-height:46vh;overflow:auto;margin:10px 0}
.log p{margin:4px 0}.log .gm{font-style:italic;color:var(--accent)}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
button{font:inherit;font-family:system-ui,sans-serif;font-size:14px;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}
table{border-collapse:collapse;width:100%;font-family:system-ui,sans-serif;font-size:13px}td,th{padding:3px 6px;border-bottom:1px solid var(--line);text-align:left}
.map{position:relative;margin:8px 0}.map img{width:100%;display:block;border-radius:6px}.map i{position:absolute;width:7px;height:7px;margin:-3px;border-radius:50%;background:#fff;border:1px solid #000}
.map i.here{background:#ff4;width:11px;height:11px;margin:-5px}.map i.ruin{background:#a66;border-radius:0}
input,select{font:inherit;font-size:14px;padding:5px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}
@media (max-width:600px){#app{padding:12px}}
`;
