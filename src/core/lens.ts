/**
 * Time lenses. Every system always runs; a lens only sets how many years one
 * tick represents (and therefore which approximations each system uses).
 */
export const LENSES = [
  { id: 'cosmic', name: '宇宙', dtYears: 1e7, note: '恒星進化・軌道の長期変動' },
  { id: 'geologic', name: '地質', dtYears: 1e6, note: 'プレート・侵食・炭素循環' },
  { id: 'evolution', name: '進化', dtYears: 1e4, note: '氷期・種分化' },
  { id: 'history', name: '歴史', dtYears: 1, note: '個体数・経済・技術' },
  { id: 'present', name: '現在', dtYears: 1 / 365, note: '日々の天候・市場' },
] as const;

export type LensId = (typeof LENSES)[number]['id'];

export function lensById(id: LensId) {
  const l = LENSES.find((x) => x.id === id);
  if (!l) throw new Error(`unknown lens ${id}`);
  return l;
}

/** Human-readable span of time in Japanese units (年・万年・億年). */
export function formatYears(years: number): string {
  const y = Math.abs(years);
  if (y === 0) return '0年';
  if (y >= 1e8) return `${trim(years / 1e8)}億年`;
  if (y >= 1e4) return `${trim(years / 1e4)}万年`;
  if (y >= 1) return `${Math.floor(years).toLocaleString('ja-JP')}年`;
  return `${Math.round(years * 365)}日`;
}

/** Calendar-style display for the present lens: "123年 45日". */
export function formatDate(years: number): string {
  const whole = Math.floor(years);
  const day = Math.floor((years - whole) * 365) + 1;
  return `${formatYears(whole || 0)} ${day}日目`;
}

function trim(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}
