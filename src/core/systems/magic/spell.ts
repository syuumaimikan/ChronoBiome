import type { Rng } from '../../rng';

/**
 * Spells as typed data-flow pipelines built from small parts
 * (source → element(s) → form → target → effect(s), with modifiers and
 * conditions anywhere). The cost in mana follows from what the spell does —
 * effect size × area × duration × how well the element suits the land — so
 * any combination is valid and stronger spells are heavier. A type checker
 * rejects parts that do not connect, and the interpreter has a hard step
 * limit, so spells can never hang the simulation.
 *
 * Golem routines reuse the same node vocabulary with sensors and actions.
 */

export type SourceKind = 'ambient' | 'crystal' | 'life' | 'star';
export type FormKind = 'touch' | 'bolt' | 'area' | 'ward' | 'enchant' | 'ritual';
export type TargetKind = 'cell' | 'population' | 'settlement' | 'field';
export type EffectField = 'temperature' | 'moisture' | 'elevation' | 'growth' | 'health' | 'defense' | 'mana' | 'density' | 'price' | 'morale';
export type EffectOp = 'raise' | 'lower' | 'move';
export type ModKind = 'amplify' | 'extend' | 'range' | 'delay' | 'split' | 'chain' | 'invert';
export type CondKind = 'always' | 'fullmoon' | 'newmoon' | 'eclipse' | 'conjunction' | 'threshold';
export type SenseKind = 'ore' | 'enemy' | 'stock' | 'mana' | 'crop';
export type ActKind = 'mine' | 'haul' | 'farm' | 'guard' | 'trade' | 'build';

export type SpellNode =
  | { k: 'source'; what: SourceKind }
  | { k: 'element'; el: string }
  | { k: 'form'; shape: FormKind }
  | { k: 'target'; what: TargetKind }
  | { k: 'effect'; op: EffectOp; field: EffectField; amount: number }
  | { k: 'mod'; m: ModKind; x: number }
  | { k: 'cond'; when: CondKind; arg?: number }
  | { k: 'sense'; what: SenseKind; above: boolean; value: number }
  | { k: 'act'; what: ActKind };

export const NODE_LABEL = {
  source: { ambient: '周囲のマナ', crystal: '魔晶', life: '生命力', star: '星の力' },
  form: { touch: '接触', bolt: '投射', area: '範囲', ward: '結界', enchant: '付与', ritual: '儀式' },
  target: { cell: '土地', population: '生物群', settlement: '集落', field: 'マナ場' },
  field: {
    temperature: '気温', moisture: '湿り気', elevation: '地形', growth: '実り', health: '健康', defense: '守り', mana: 'マナ', density: '個体数', price: '物価', morale: '士気',
  },
  op: { raise: '上げる', lower: '下げる', move: '動かす' },
  mod: { amplify: '増幅', extend: '持続', range: '射程', delay: '遅延', split: '分裂', chain: '連鎖', invert: '反転' },
  cond: { always: '常に', fullmoon: '満月のとき', newmoon: '新月のとき', eclipse: '食のとき', conjunction: '惑星の合のとき', threshold: '閾値を超えたとき' },
  sense: { ore: '鉱石', enemy: '敵', stock: '在庫', mana: 'マナ', crop: '作物' },
  act: { mine: '採掘', haul: '運搬', farm: '耕作', guard: '警護', trade: '売買', build: '建築' },
} as const;

/** Which fields each built-in element can act on. Unknown (rule-pack) elements may touch anything at lower affinity. */
const ELEMENT_FIELDS: Record<string, EffectField[]> = {
  火: ['temperature', 'elevation', 'health', 'defense'],
  水: ['moisture', 'temperature', 'growth', 'health'],
  地: ['elevation', 'defense', 'growth'],
  風: ['moisture', 'temperature', 'price'],
  生命: ['growth', 'health', 'density'],
  精神: ['defense', 'price', 'morale'],
  時空: ['mana', 'growth', 'price', 'morale'],
};

const TARGET_FIELDS: Record<TargetKind, EffectField[]> = {
  cell: ['temperature', 'moisture', 'elevation', 'mana'],
  population: ['density', 'growth', 'health'],
  settlement: ['health', 'defense', 'price', 'morale', 'growth'],
  field: ['mana'],
};

/** Mana per unit of effect per cell (before area and duration). */
const UNIT_COST: Record<EffectField, number> = {
  temperature: 3, moisture: 20, elevation: 0.08, growth: 25, health: 30, defense: 30, mana: 1.2, density: 40, price: 15, morale: 20,
};

const FORM_RADIUS: Record<FormKind, number> = { touch: 0, bolt: 0, area: 1, ward: 1, enchant: 0, ritual: 3 };
const FORM_YEARS: Record<FormKind, number> = { touch: 0.1, bolt: 0.05, area: 0.5, ward: 3, enchant: 5, ritual: 20 };

export interface SpellPlan {
  ok: boolean;
  errors: string[];
  cost: number;
  stability: number;
  radius: number;
  years: number;
  power: number;
  conds: CondKind[];
  effects: { op: EffectOp; field: EffectField; amount: number }[];
  target: TargetKind;
  elements: string[];
  summary: string;
}

export interface SpellContext {
  /** Caster skill 0..1 (a settlement's magic level, or the player's). */
  skill: number;
  potency: number;
  /** Elements allowed by the rule pack. */
  elements: string[];
  /** Affinity 0.3..1.5 of an element at the target. */
  affinity?: (el: string) => number;
}

/** Type-check a spell and compute its cost and stability. */
export function planSpell(nodes: SpellNode[], ctx: SpellContext): SpellPlan {
  const errors: string[] = [];
  const order = ['source', 'element', 'form', 'target', 'effect'];
  let stage = 0;
  let source: SourceKind | null = null;
  const elements: string[] = [];
  let form: FormKind | null = null;
  let target: TargetKind | null = null;
  const effects: { op: EffectOp; field: EffectField; amount: number }[] = [];
  const conds: CondKind[] = [];
  let amp = 1, extend = 1, range = 0, split = 1, chain = 0, invert = false, delay = 0;
  for (const n of nodes) {
    if (n.k === 'mod') {
      const x = Math.max(0, Math.min(5, n.x));
      if (n.m === 'amplify') amp *= 1 + x;
      else if (n.m === 'extend') extend *= 1 + x;
      else if (n.m === 'range') range += Math.round(x);
      else if (n.m === 'split') split *= 1 + Math.round(x);
      else if (n.m === 'chain') chain += Math.round(x);
      else if (n.m === 'invert') invert = !invert;
      else if (n.m === 'delay') delay += x;
      continue;
    }
    if (n.k === 'cond') {
      if (conds.length >= 2) errors.push('条件は 2 つまでです');
      conds.push(n.when);
      continue;
    }
    if (n.k === 'sense' || n.k === 'act') {
      errors.push('センサーと行動はゴーレムの行動ルーチン専用です');
      continue;
    }
    const idx = order.indexOf(n.k);
    if (idx < stage) errors.push(`「${n.k}」は ${order[stage]} より前に置きます`);
    stage = Math.max(stage, idx);
    if (n.k === 'source') {
      if (source) errors.push('源は 1 つだけです');
      source = n.what;
    } else if (n.k === 'element') {
      if (!ctx.elements.includes(n.el)) errors.push(`属性「${n.el}」はこの世界にありません`);
      elements.push(n.el);
    } else if (n.k === 'form') {
      if (form) errors.push('形は 1 つだけです');
      form = n.shape;
    } else if (n.k === 'target') {
      if (target) errors.push('対象は 1 つだけです');
      target = n.what;
    } else if (n.k === 'effect') {
      effects.push({ op: n.op, field: n.field, amount: Math.max(-1000, Math.min(1000, n.amount)) });
    }
  }
  if (!source) errors.push('源がありません');
  if (!elements.length) errors.push('属性がありません');
  if (!form) errors.push('形がありません');
  if (!target) errors.push('対象がありません');
  if (!effects.length) errors.push('作用がありません');
  for (const e of effects) {
    if (target && !TARGET_FIELDS[target].includes(e.field)) errors.push(`${NODE_LABEL.target[target]}に「${NODE_LABEL.field[e.field]}」の作用はつながりません`);
    if (elements.length && !elements.some((el) => !ELEMENT_FIELDS[el] || ELEMENT_FIELDS[el].includes(e.field))) {
      errors.push(`属性 ${elements.join('・')} では「${NODE_LABEL.field[e.field]}」を動かせません`);
    }
    if (e.op === 'move' && e.field !== 'moisture' && e.field !== 'temperature' && e.field !== 'mana') errors.push(`「動かす」は気温・湿り気・マナだけです`);
  }
  if (form === 'ritual' && source === 'ambient' && amp > 3) errors.push('周囲のマナだけで強い儀式は組めません（魔晶か星の力を使う）');
  const radius = (form ? FORM_RADIUS[form] : 0) + range;
  const cells = 1 + 3 * radius * (radius + 1); // hexagonal disc
  const years = (form ? FORM_YEARS[form] : 0.1) * extend;
  const affinity = elements.reduce((s, el) => s * (ctx.affinity ? ctx.affinity(el) : ELEMENT_FIELDS[el] ? 1 : 0.7), 1) ** (1 / Math.max(1, elements.length));
  const sourceMul = source === 'crystal' ? 0.8 : source === 'life' ? 0.9 : source === 'star' ? 0.6 : 1;
  const condMul = conds.some((c) => c !== 'always') ? 0.7 : 1;
  let cost = 0;
  for (const e of effects) cost += Math.abs(e.amount) * UNIT_COST[e.field];
  cost *= cells * split * (1 + chain * 0.6) * Math.pow(Math.max(0.05, years), 0.7) * amp * sourceMul * condMul * (delay > 0 ? 0.9 : 1);
  cost /= Math.max(0.2, affinity) * ctx.potency;
  const complexity = nodes.length + (amp > 2 ? 2 : 0) + chain + (split > 1 ? 1 : 0) + (form === 'ritual' ? 3 : 0);
  const stability = Math.max(0.05, Math.min(0.99, 1 - (complexity - ctx.skill * 10) / 12));
  const power = amp * (invert ? -1 : 1);
  const summary = errors.length ? '' : describeSpell(elements, form!, target!, effects, power, radius, years);
  return { ok: errors.length === 0, errors, cost, stability, radius, years, power, conds, effects, target: target ?? 'cell', elements, summary };
}

function describeSpell(elements: string[], form: FormKind, target: TargetKind, effects: SpellPlan['effects'], power: number, radius: number, years: number): string {
  const fx = effects
    .map((e) => `${NODE_LABEL.field[e.field]}を${Math.abs(e.amount * power).toFixed(e.field === 'elevation' ? 0 : 1)}${e.op === 'lower' !== power < 0 ? '下げる' : e.op === 'move' ? '動かす' : '上げる'}`)
    .join('、');
  return `${elements.join('と')}の${NODE_LABEL.form[form]}：${NODE_LABEL.target[target]}の${fx}（半径 ${radius} 区画、${years < 1 ? `${Math.round(years * 365)} 日` : `${years.toFixed(0)} 年`}）`;
}

// ---------------------------------------------------------------- golem routines

export interface RoutineResult {
  act: ActKind | null;
  steps: number;
}

/**
 * Run a golem routine once: rules are checked in order ("if sensor then act"),
 * the first that fires decides the action. At most 64 steps.
 */
export function runRoutine(nodes: SpellNode[], read: (s: SenseKind) => number): RoutineResult {
  let steps = 0;
  let ok = true;
  for (const n of nodes) {
    if (++steps > 64) break;
    if (n.k === 'sense') {
      const v = read(n.what);
      ok = ok && (n.above ? v > n.value : v < n.value);
    } else if (n.k === 'act') {
      if (ok) return { act: n.what, steps };
      ok = true;
    }
  }
  return { act: null, steps };
}

export function checkRoutine(nodes: SpellNode[]): string[] {
  const errs: string[] = [];
  if (!nodes.some((n) => n.k === 'act')) errs.push('行動がありません');
  for (const n of nodes) if (n.k !== 'sense' && n.k !== 'act') errs.push('行動ルーチンにはセンサーと行動だけを置きます');
  if (nodes.length > 32) errs.push('部品は 32 個までです');
  return errs;
}

// ---------------------------------------------------------------- spell invention

/** Compose a spell for a need, from the parts a culture knows. */
export function inventSpell(need: 'rain' | 'harvest' | 'heal' | 'ward' | 'cool' | 'warm', elements: string[], rng: Rng): { name: string; nodes: SpellNode[] } {
  const has = (e: string) => elements.includes(e);
  const pickEl = (prefer: string) => (has(prefer) ? prefer : rng.pick(elements));
  const amp = rng.chance(0.4) ? [{ k: 'mod', m: 'amplify', x: rng.range(0.2, 1.2) } as SpellNode] : [];
  const cond = rng.chance(0.35) ? [{ k: 'cond', when: rng.pick(['fullmoon', 'newmoon', 'conjunction'] as const) } as SpellNode] : [];
  switch (need) {
    case 'rain':
      return { name: '雨乞い', nodes: [{ k: 'source', what: 'ambient' }, { k: 'element', el: pickEl('水') }, { k: 'form', shape: 'ritual' }, { k: 'target', what: 'cell' }, { k: 'effect', op: 'raise', field: 'moisture', amount: 0.15 }, ...cond, ...amp] };
    case 'harvest':
      return { name: '豊穣の祈り', nodes: [{ k: 'source', what: 'life' }, { k: 'element', el: pickEl('生命') }, { k: 'form', shape: 'enchant' }, { k: 'target', what: 'settlement' }, { k: 'effect', op: 'raise', field: 'growth', amount: 0.2 }, ...cond, ...amp] };
    case 'heal':
      return { name: '癒やしの祈祷', nodes: [{ k: 'source', what: 'life' }, { k: 'element', el: pickEl('生命') }, { k: 'form', shape: 'area' }, { k: 'target', what: 'settlement' }, { k: 'effect', op: 'raise', field: 'health', amount: 0.3 }, ...amp] };
    case 'ward':
      return { name: '守護結界', nodes: [{ k: 'source', what: 'crystal' }, { k: 'element', el: pickEl('地') }, { k: 'form', shape: 'ward' }, { k: 'target', what: 'settlement' }, { k: 'effect', op: 'raise', field: 'defense', amount: 0.4 }, ...amp] };
    case 'cool':
      return { name: '冷気の帳', nodes: [{ k: 'source', what: 'ambient' }, { k: 'element', el: pickEl('風') }, { k: 'form', shape: 'ritual' }, { k: 'target', what: 'cell' }, { k: 'effect', op: 'lower', field: 'temperature', amount: 1.5 }, ...cond] };
    case 'warm':
      return { name: '陽炎の環', nodes: [{ k: 'source', what: 'star' }, { k: 'element', el: pickEl('火') }, { k: 'form', shape: 'ritual' }, { k: 'target', what: 'cell' }, { k: 'effect', op: 'raise', field: 'temperature', amount: 1.5 }, ...cond] };
  }
}

/** A default golem routine for a settlement's needs. */
export function defaultRoutine(rng: Rng): SpellNode[] {
  const r: SpellNode[] = [
    { k: 'sense', what: 'enemy', above: true, value: 0.5 }, { k: 'act', what: 'guard' },
    { k: 'sense', what: 'crop', above: false, value: 0.9 }, { k: 'act', what: 'farm' },
    { k: 'sense', what: 'ore', above: true, value: 0 }, { k: 'act', what: 'mine' },
  ];
  if (rng.chance(0.5)) r.push({ k: 'sense', what: 'stock', above: true, value: 1.5 }, { k: 'act', what: 'trade' });
  r.push({ k: 'act', what: 'build' });
  return r;
}
