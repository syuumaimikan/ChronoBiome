import type { ComponentChildren } from 'preact';
import { formatYears } from '../core/lens';

/** Compact Japanese number: 1.2万, 3.4億. */
export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(a >= 1e9 ? 0 : 1)}億`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(a >= 1e5 ? 0 : 1)}万`;
  if (a >= 100) return Math.round(v).toLocaleString('ja-JP');
  if (a >= 1) return v.toFixed(1).replace(/\.0$/, '');
  if (a === 0) return '0';
  return v.toPrecision(2);
}

export function fmtMass(kg: number): string {
  if (kg >= 1000) return `${fmtNum(kg / 1000)} t`;
  if (kg >= 1) return `${fmtNum(kg)} kg`;
  if (kg >= 0.001) return `${(kg * 1000).toPrecision(2)} g`;
  return `${(kg * 1e6).toPrecision(2)} mg`;
}

export function years(t: number): string {
  return formatYears(t);
}

/** Colour of a species from its hue/shade (as in the 3D view). */
export function speciesColor(hue: number, shade: number, clade: string): string {
  const bird = clade === 'bird';
  const reptile = clade === 'reptile' || clade === 'amphibian';
  const h = bird || reptile ? hue : 0.06 + 0.06 * Math.sin(hue * 6.283);
  const s = bird ? 0.35 + 0.4 * hue : reptile ? 0.35 : 0.22 + 0.2 * shade;
  const l = 0.22 + 0.42 * shade;
  return `hsl(${(h * 360).toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100 + 8).toFixed(0)}%)`;
}

export function Meter({ value, color }: { value: number; color?: string }) {
  return (
    <span class="meter" aria-hidden="true">
      <span style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, background: color }} />
    </span>
  );
}

export function Section({ title, children, right }: { title: string; children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <section class="sec">
      <h3>
        {title}
        {right && <span class="sec-right">{right}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A small line chart; `log` plots log10(1 + v). */
export function Sparkline({ values, color = 'var(--accent)', height = 34, log = false, label }: { values: number[]; color?: string; height?: number; log?: boolean; label?: string }) {
  if (values.length < 2) return null;
  const v = log ? values.map((x) => Math.log10(1 + Math.max(0, x))) : values;
  let lo = Infinity, hi = -Infinity;
  for (const x of v) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const W = 300;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${(height - 2 - ((x - lo) / (hi - lo)) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <div class="spark" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
        <polyline points={pts} fill="none" stroke={color} stroke-width="1.6" vector-effect="non-scaling-stroke" />
      </svg>
      {label && <span>{label}</span>}
    </div>
  );
}

/** Horizontal bars for a few labelled counts. */
export function Bars({ items, color = 'var(--accent)' }: { items: [string, number][]; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i[1]));
  return (
    <ul class="bars">
      {items.map(([k, v]) => (
        <li key={k}>
          <span class="bars-k">{k}</span>
          <span class="bars-bar"><span style={{ width: `${(v / max) * 100}%`, background: color }} /></span>
          <span class="bars-v">{fmtNum(v)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Start a download of text (or a blob) the user asked for. */
export function download(name: string, data: string | Blob, type = 'text/plain'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type: `${type};charset=utf-8` }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
