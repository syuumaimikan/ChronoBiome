import type { Rng } from '../../rng';
import type { RulePack } from '../../rules/schema';
import { chronicle, touch, type WorldState } from '../../world/state';
import { moonPhase } from '../astrology/astrology';
import type { Ecology } from '../biosphere/ecology';
import { planSpell, type SpellNode, type SpellPlan } from './spell';

/**
 * Executing a spell on the world. Effects go through the same fields the
 * other systems use: temperature and moisture through decaying climate
 * modifiers, terrain through relief, populations through ecology densities,
 * settlements through temporary boons. At most MAX_CELLS cells are touched.
 */

const MAX_CELLS = 400;

export interface CastResult {
  ok: boolean;
  errors: string[];
  manaUsed: number;
  misfire: boolean;
  cells: number;
  text: string;
  plan: SpellPlan | null;
}

/** Affinity of an element with the land around a cell. */
export function elementAffinity(state: WorldState, cell: number, el: string): number {
  const f = state.fields;
  const t = f.tempMean[cell], m = f.moisture[cell];
  const h = f.elevation[cell] - state.seaLevel;
  const volcanic = Math.abs(f.stress[cell]) > 0.2 ? 1 : 0;
  switch (el) {
    case '火': return 0.7 + 0.02 * Math.max(0, t) + 0.4 * volcanic;
    case '水': return h < 0 ? 1.5 : 0.5 + m;
    case '地': return 0.8 + Math.min(0.6, Math.max(0, h) / 4000);
    case '風': return 0.8 + Math.min(0.5, Math.max(0, h) / 5000) + (f.continentality[cell] < 0.2 ? 0.2 : 0);
    case '生命': return 0.5 + Math.min(1, m) * (t > 0 ? 1 : 0.4);
    case '精神': return 1;
    case '時空': return 0.6;
    default: return 0.8;
  }
}

/** Cells within `radius` hops of a centre (breadth first, capped). */
export function disc(state: WorldState, center: number, radius: number): number[] {
  const m = state.mesh;
  const out = [center];
  const seen = new Set(out);
  let frontier = [center];
  for (let d = 0; d < radius && out.length < MAX_CELLS; d++) {
    const next: number[] = [];
    for (const c of frontier) {
      for (let k = m.nbrStart[c]; k < m.nbrStart[c + 1]; k++) {
        const q = m.nbr[k];
        if (!seen.has(q)) {
          seen.add(q);
          out.push(q);
          next.push(q);
          if (out.length >= MAX_CELLS) break;
        }
      }
    }
    frontier = next;
  }
  return out;
}

export function castSpell(
  state: WorldState,
  rules: RulePack,
  eco: Ecology,
  nodes: SpellNode[],
  cell: number,
  skill: number,
  rng: Rng,
  caster: string,
  /** Mana the caster can draw besides the field (crystals). */
  extraMana = 0,
): CastResult {
  const fail = (errors: string[], plan: SpellPlan | null = null): CastResult => ({ ok: false, errors, manaUsed: 0, misfire: false, cells: 0, text: '', plan });
  if (!rules.magic.enabled) return fail(['この世界のルールでは魔法は存在しません']);
  if (!(cell >= 0 && cell < state.mesh.count)) return fail(['対象の場所がありません']);
  const plan = planSpell(nodes, {
    skill,
    potency: rules.magic.potency,
    elements: rules.magic.elements,
    affinity: (el) => elementAffinity(state, cell, el),
  });
  if (!plan.ok) return fail(plan.errors, plan);
  // Conditions read the real sky.
  const phase = moonPhase(state.system, state.time);
  let condPower = 1;
  for (const c of plan.conds) {
    const met = c === 'fullmoon' ? Math.abs(phase - 0.5) < 0.06 : c === 'newmoon' ? phase < 0.06 || phase > 0.94 : c === 'always' ? true : c === 'threshold' ? true : rng.chance(0.15);
    if (!met) return fail([`条件「${c}」が満たされていません（月齢 ${(phase * 29.5).toFixed(1)} 日）`], plan);
    condPower *= 1.4;
  }
  const area = disc(state, cell, plan.radius);
  // Mana: the field around the target plus whatever the caster brings.
  const f = state.fields;
  let available = extraMana;
  for (const c of area) available += f.mana[c] * 100;
  const arcane = rules.astrology.arcane ? state.magic.arcane : 1;
  const cost = plan.cost / arcane;
  if (available < cost) return fail([`マナが足りません（必要 ${cost.toFixed(0)}、周囲 ${available.toFixed(0)}）`], plan);
  // Draw from the field first, evenly.
  let need = Math.max(0, cost - extraMana);
  const perCell = need / area.length / 100;
  for (const c of area) {
    const take = Math.min(f.mana[c], perCell);
    f.mana[c] -= take;
    need -= take * 100;
  }
  touch(state, 'mana');
  const misfire = !rng.chance(plan.stability);
  let power = plan.power * condPower * (misfire ? -rng.range(0.5, 1.5) : 1);
  if (misfire && rng.chance(0.5)) power *= 2;
  const decay = 1 / Math.max(0.05, plan.years);
  const texts: string[] = [];
  for (const e of plan.effects) {
    const sign = e.op === 'lower' ? -1 : 1;
    const amt = e.amount * sign * power;
    switch (e.field) {
      case 'temperature':
        for (const c of area) state.mods.temp[c] += amt;
        state.mods.decay = Math.max(state.mods.decay, decay);
        state.mods.dirty = true;
        texts.push(`気温 ${amt > 0 ? '+' : ''}${amt.toFixed(1)}℃`);
        break;
      case 'moisture':
        for (const c of area) state.mods.moist[c] += amt;
        state.mods.decay = Math.max(state.mods.decay, decay);
        state.mods.dirty = true;
        texts.push(`湿り気 ${amt > 0 ? '+' : ''}${amt.toFixed(2)}`);
        break;
      case 'elevation':
        for (const c of area) f.relief[c] += amt * (c === cell ? 1 : 0.5);
        state.mods.reliefDirty = true;
        texts.push(`地形 ${amt > 0 ? '+' : ''}${amt.toFixed(0)} m`);
        break;
      case 'mana':
        for (const c of area) f.mana[c] = Math.max(0, f.mana[c] + amt * 0.01);
        texts.push(`マナ ${amt > 0 ? '+' : ''}${amt.toFixed(1)}`);
        break;
      case 'density':
      case 'growth':
      case 'health':
      case 'defense':
      case 'price':
      case 'morale': {
        if (plan.target === 'population') {
          const regions = new Set(area.map((c) => eco.cellRegion[c]));
          const bio = state.bio;
          const mul = Math.max(0, 1 + amt);
          for (const id of bio.living) {
            const sp = bio.species.get(id)!;
            if (sp.sapient) continue;
            for (const r of regions) bio.density[sp.slot * eco.R + r] *= mul;
          }
          texts.push(`生物の個体数 ×${mul.toFixed(2)}`);
          break;
        }
        const hit = state.civ.settlements.filter((s) => area.includes(s.cell));
        for (const s of hit) {
          if (e.field === 'growth') s.buffs.food += amt;
          else if (e.field === 'health') s.buffs.health += amt;
          else if (e.field === 'defense') s.buffs.defense += amt;
          else if (e.field === 'morale') s.buffs.morale += amt;
          else if (e.field === 'price') for (let g = 0; g < s.price.length; g++) s.price[g] *= Math.max(0.2, 1 + amt * 0.1);
        }
        texts.push(`${hit.length} 集落の${e.field === 'growth' ? '実り' : e.field === 'health' ? '健康' : e.field === 'defense' ? '守り' : e.field === 'morale' ? '士気' : '物価'} ${amt > 0 ? '+' : ''}${amt.toFixed(2)}`);
        break;
      }
    }
  }
  const text = `${caster}が呪文を唱えた：${plan.summary}${misfire ? '……しかし暴発した！' : ''}（消費マナ ${cost.toFixed(0)}）→ ${texts.join('、')}`;
  if (misfire || plan.radius >= 3) chronicle(state, 'magic', text, { cell });
  return { ok: true, errors: [], manaUsed: cost, misfire, cells: area.length, text, plan };
}
