import { deriveSeed, Rng } from '../rng';
import type { Simulation } from '../sim';
import { castSpell } from '../systems/magic/cast';
import type { SpellNode } from '../systems/magic/spell';
import type { PlayerState, Settlement } from '../systems/society/civState';
import { ARTIFACT_NAMES, fmt } from '../systems/society/civ';
import { BUILDINGS, F, GOODS, ROLE_NAMES, TECH, TECHS } from '../systems/society/data';
import { distanceKm } from '../world/topology';
import { chronicle } from '../world/state';

/**
 * What the player can do in the world (milestones 12–12.5): be born into a
 * town as one of its people (incarnation), keep a field journal of species,
 * dig up artifacts, trade at the market price, pay for buildings, travel,
 * and cast spells. Deeds are written into the person's record and the
 * chronicle, so later lives find what earlier ones left.
 *
 * Also the Lab's scenario injections (catastrophes on demand).
 */

export type Incarnation = 'merchant' | 'mage' | 'explorer' | 'general';

export type Action =
  | { kind: 'incarnate'; role: Incarnation }
  | { kind: 'observe'; species: number }
  | { kind: 'excavate'; cell: number }
  | { kind: 'trade'; good: number; amount: number }
  | { kind: 'build'; building: number }
  | { kind: 'travel'; settlement: number }
  | { kind: 'cast'; nodes: SpellNode[]; cell: number };

function rngFor(sim: Simulation, label: string): Rng {
  return new Rng(deriveSeed(sim.state.seed, label, sim.state.tick * 7919 + sim.state.civ.nextId));
}

export function ensurePlayer(sim: Simulation): PlayerState {
  const civ = sim.state.civ;
  civ.player ??= { person: -1, settlement: -1, wealth: 0, inventory: [], past: [], journal: { observed: {} } };
  return civ.player;
}

function home(sim: Simulation, p: PlayerState): Settlement | undefined {
  return sim.state.civ.settlements.find((s) => s.id === p.settlement);
}

function personOf(sim: Simulation, p: PlayerState) {
  return sim.state.civ.persons.find((x) => x.id === p.person);
}

export function act(sim: Simulation, a: Action): { ok: boolean; text: string } {
  const st = sim.state;
  const civ = st.civ;
  const p = ensurePlayer(sim);
  const me = personOf(sim, p);
  const alive = !!me && me.died < 0;
  const deed = (text: string) => {
    if (me && alive) me.deeds.push(text);
  };
  switch (a.kind) {
    case 'incarnate': {
      if (!civ.settlements.length) return { ok: false, text: 'まだ人の住む町がありません。' };
      if (me && alive) return { ok: false, text: `いまは${me.name}として生きています。` };
      const rng = rngFor(sim, 'incarnate');
      // Born somewhere among the larger towns; the dice and the stars decide.
      const towns = [...civ.settlements].sort((x, y) => y.pop - x.pop).slice(0, 12);
      const s = rng.pick(towns);
      const roleText = { merchant: '商人', mage: '魔術師', explorer: '開拓者', general: '兵士' }[a.role];
      const person = sim.civilization.person(st, 'player', s, rng, `${s.name}に${roleText}の子として生まれた`);
      if (me) p.past.push(me.id);
      p.person = person.id;
      p.settlement = s.id;
      const perCapita = s.wealth / Math.max(1, s.pop);
      p.wealth = Math.round(20 + 400 * Math.min(5, perCapita) * (a.role === 'merchant' ? 2 : 1) * (0.5 + rng.next()));
      p.inventory = [];
      chronicle(st, 'civ', `${s.name}に${person.name}が生まれた（${person.chart}）。`, { cell: s.cell, polity: s.polity });
      return { ok: true, text: `あなたは${s.name}の${person.name}として生まれた。${person.chart}。所持金 ${p.wealth}。` };
    }
    case 'observe': {
      const sp = st.bio.species.get(a.species);
      if (!sp) return { ok: false, text: 'その生き物は記録にありません。' };
      const was = p.journal.observed[sp.id] ?? 0;
      p.journal.observed[sp.id] = Math.min(3, was + 1);
      const lv = p.journal.observed[sp.id];
      if (was === 0) deed(`新種「${sp.name}」を図鑑に記録した`);
      return { ok: true, text: lv === 1 ? `「${sp.name}」を図鑑に記録した。` : lv === 2 ? `「${sp.name}」の暮らしぶり（食性・適温）がわかってきた。` : `「${sp.name}」のことは調べ尽くした（系統と弱点まで記録）。` };
    }
    case 'excavate': {
      const m = st.mesh;
      const near = new Set([a.cell]);
      for (let k = m.nbrStart[a.cell]; k < m.nbrStart[a.cell + 1]; k++) near.add(m.nbr[k]);
      const art = civ.artifacts.find((x) => !x.found && near.has(x.cell) && x.depth < 8);
      if (!art) {
        const deep = civ.artifacts.find((x) => !x.found && near.has(x.cell));
        return { ok: false, text: deep ? `何かが埋まっているが、深さ ${deep.depth.toFixed(1)} m は掘り切れない。` : 'ここには何も埋まっていないようだ。' };
      }
      art.found = true;
      // Deciphering happens at home, or at the nearest town.
      let town = home(sim, p);
      if (!town) {
        let best = Infinity;
        for (const s of civ.settlements) {
          const d = distanceKm(m, s.cell, a.cell);
          if (d < best) { best = d; town = s; }
        }
      }
      art.decipherAt = town?.id ?? -1;
      p.inventory.push(art.id);
      deed(`${art.from}の遺跡から${ARTIFACT_NAMES[art.kind]}を掘り出した`);
      chronicle(st, 'civ', `${me && alive ? me.name : '旅人'}が${art.from}の遺跡から${ARTIFACT_NAMES[art.kind]}を発掘した：「${art.text}」`, { cell: art.cell });
      return { ok: true, text: `${ARTIFACT_NAMES[art.kind]}を発掘した：「${art.text}」${town ? `。${town.name}の学者が解読を始める。` : ''}` };
    }
    case 'trade': {
      const s = home(sim, p);
      if (!s || !alive) return { ok: false, text: '町に住む人として転生すると売買できます。' };
      const g = GOODS[a.good];
      if (!g) return { ok: false, text: 'その品物はありません。' };
      const price = s.price[a.good];
      if (a.amount > 0) {
        const cost = price * a.amount;
        if (cost > p.wealth) return { ok: false, text: `お金が足りません（${cost.toFixed(0)} 必要）。` };
        if (s.stock[a.good] < a.amount) return { ok: false, text: `${s.name}の市場には${g.name}が ${s.stock[a.good].toFixed(0)} しかありません。` };
        s.stock[a.good] -= a.amount;
        p.wealth -= cost;
        s.wealth += cost;
        return { ok: true, text: `${g.name}を ${a.amount} 単位、${cost.toFixed(0)} で買った。` };
      }
      const amount = -a.amount;
      const gain = price * amount * 0.9;
      s.stock[a.good] += amount;
      p.wealth += gain;
      if (gain > 500) deed(`${s.name}の市場で${g.name}を商った`);
      return { ok: true, text: `${g.name}を ${amount} 単位、${gain.toFixed(0)} で売った。` };
    }
    case 'build': {
      const s = home(sim, p);
      if (!s || !alive) return { ok: false, text: '町に住む人として転生すると建物を寄進できます。' };
      const b = BUILDINGS[a.building];
      if (!b) return { ok: false, text: 'その建物はありません。' };
      if (b.tech && s.tech[TECH[b.tech].index] < 0.3) return { ok: false, text: `「${TECH[b.tech].name}」の技術がまだありません。` };
      const cost = b.cost * 20;
      if (p.wealth < cost) return { ok: false, text: `資金が足りません（${cost} 必要）。` };
      p.wealth -= cost;
      s.buildings[b.index]++;
      deed(`${s.name}に${b.name}を建てた`);
      chronicle(st, 'civ', `${me!.name}の寄進で${s.name}に${b.name}が建った。`, { cell: s.cell, polity: s.polity });
      sim.civilization.invalidate();
      return { ok: true, text: `${s.name}に${b.name}を建てた。` };
    }
    case 'travel': {
      const s = civ.settlements.find((x) => x.id === a.settlement);
      if (!s || !alive) return { ok: false, text: '移り住む先がありません。' };
      p.settlement = s.id;
      me!.settlement = s.id;
      deed(`${s.name}へ移り住んだ`);
      return { ok: true, text: `${s.name}へ移り住んだ。` };
    }
    case 'cast': {
      const rng = rngFor(sim, 'player-cast');
      const s = home(sim, p);
      const mage = alive && me!.deeds[0]?.includes('魔術師');
      const skill = Math.min(0.95, 0.35 + (mage ? 0.35 : 0) + (s ? 0.1 * s.fx[F.magic] : 0));
      const r = castSpell(st, sim.rules, sim.ecology, a.nodes, a.cell, skill, rng, me && alive ? me.name : '神', 0);
      if (!r.ok) return { ok: false, text: r.errors.join('、') };
      if (r.misfire) deed('呪文を暴発させた');
      else deed('呪文を唱えた');
      sim.climate.invalidate();
      return { ok: true, text: r.text };
    }
  }
}

// ---------------------------------------------------------------- scenarios

import { SCENARIOS, type ScenarioKind } from './scenarios';
export { SCENARIOS, type ScenarioKind };

export function injectScenario(sim: Simulation, kind: ScenarioKind, cell: number): string {
  const st = sim.state;
  const civ = st.civ;
  const g = st.climate;
  const rng = rngFor(sim, 'scenario-' + kind);
  const m = st.mesh;
  if (!(cell >= 0 && cell < m.count)) cell = rng.int(m.count);
  switch (kind) {
    case 'impact': {
      const lost = sim.ecology.impact(st, 0.85 + 0.15 * rng.next(), cell, rng);
      return `小惑星が衝突した。種の ${(lost * 100).toFixed(0)}% が絶滅し、衝突の冬が来る。`;
    }
    case 'supervolcano': {
      g.aerosolCooling += 7;
      g.pulse += 500;
      let dead = 0;
      for (const s of civ.settlements) {
        const km = distanceKm(m, cell, s.cell);
        const k = km < 800 ? 0.85 : km < 2500 ? 0.25 : 0.04;
        dead += s.pop * k;
        s.pop *= 1 - k;
      }
      st.events.push({ kind: 'eruption', time: st.time, cell, magnitude: 1 });
      chronicle(st, 'disaster', `超巨大火山が噴火した。空は灰に覆われ、${dead > 0 ? `約${fmt(dead)}人が亡くなった` : '大地が焼けた'}。`, { cell });
      return '超巨大噴火が起きた。';
    }
    case 'pandemic': {
      const s = [...civ.settlements].sort((a, b) => b.pop - a.pop)[0];
      if (!s) return '人の町がないので、疫病は広がりようがない。';
      const id = civ.nextId++;
      const r0 = 4 + 3 * rng.next();
      civ.pathogens.push({ id, name: '大災厄熱', born: st.time, r0, lethality: 0.25 + 0.2 * rng.next(), origin: s.name, deaths: 0, cases: 0, host: '不明' });
      s.immune = 0;
      sim.civilization.infect(s, id, r0);
      chronicle(st, 'disaster', `${s.name}で恐ろしい新しい病「大災厄熱」が流行し始めた。`, { cell: s.cell, polity: s.polity });
      return `${s.name}で大疫病が始まった。`;
    }
    case 'solar_flare': {
      let hit = 0;
      for (const s of civ.settlements) {
        if (s.fx[F.energy] < 4) continue;
        hit++;
        s.wealth *= 0.4;
        for (let i = 0; i < TECHS.length; i++) if (TECHS[i].era >= 8 && s.tech[i] > 0.3) s.tech[i] *= 0.6;
      }
      chronicle(st, 'disaster', `巨大な太陽嵐が惑星を襲い、${hit ? `${hit}の都市で送電網と通信が焼け落ちた` : 'オーロラが赤道まで降りた'}。`);
      return `太陽嵐が到達した（影響を受けた都市 ${hit}）。`;
    }
    case 'ice_age': {
      g.co2Natural *= 0.45;
      g.otherForcing = 0;
      g.aerosolCooling += 2;
      chronicle(st, 'climate', '温室効果ガスが急に減り、急激な寒冷化が始まった。');
      sim.climate.invalidate();
      return '寒冷化が始まった。';
    }
    case 'golden_age': {
      for (const s of civ.settlements) {
        s.buffs.food += 0.3;
        s.buffs.morale += 0.4;
        s.progress += 200 * Math.pow(s.pop / 1000, 0.5);
      }
      chronicle(st, 'civ', '豊かな実りと学問の隆盛——黄金時代が訪れた。');
      return '黄金時代が始まった。';
    }
    case 'red_giant': {
      const sys = st.system;
      const x = (sys.ageAtFormation + st.time) / sys.lifetime;
      if (x < 0.9) sys.ageAtFormation = 0.9 * sys.lifetime - st.time;
      chronicle(st, 'sky', `主星${sys.starName}の中心で水素が尽き、星がゆっくりと膨らみ始めた。この星に残された時間は長くない。`);
      sim.climate.invalidate();
      return '主星が膨張を始めた。';
    }
  }
}

export function playerSummary(sim: Simulation) {
  const st = sim.state;
  const civ = st.civ;
  const p = civ.player;
  if (!p) return null;
  const me = civ.persons.find((x) => x.id === p.person);
  const s = civ.settlements.find((x) => x.id === p.settlement);
  return {
    name: me?.name ?? '神（観測者）',
    role: me ? ROLE_NAMES[me.role] : '観測者',
    born: me?.born ?? 0,
    age: me ? (me.died >= 0 ? me.died : st.time) - me.born : 0,
    lifespan: me?.lifespan ?? 0,
    chart: me?.chart ?? '',
    settlement: s?.name ?? '—',
    cell: s?.cell ?? -1,
    wealth: Math.round(p.wealth),
    inventory: p.inventory.map((id) => {
      const a = civ.artifacts.find((x) => x.id === id);
      return a ? `${a.from}の${ARTIFACT_NAMES[a.kind]}${a.progress >= 1 ? '（解読済み）' : a.decipherAt >= 0 ? `（解読 ${(a.progress * 100).toFixed(0)}%）` : ''}` : '失われた品';
    }),
    past: p.past.map((id) => civ.persons.find((x) => x.id === id)).filter((x) => !!x).map((x) => ({ name: x!.name, role: ROLE_NAMES[x!.role], deeds: x!.deeds })),
    deeds: me?.deeds ?? [],
    quests: civ.quests.slice(-12).reverse().map((q) => ({ id: q.id, title: q.title, text: q.text, status: q.status, cell: q.cell })),
    observed: Object.keys(p.journal.observed).length,
    alive: !!me && me.died < 0,
  };
}
