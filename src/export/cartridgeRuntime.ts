/**
 * The World Cartridge's game: a small text RPG on top of an exported world.
 * It is serialised with Function.prototype.toString into a single HTML file,
 * so it must use nothing outside its own body (no imports, no module scope).
 *
 * The player trades between real towns at their real prices, meets the
 * world's real animals on the road, explores ruins down to their guardians,
 * fills a field journal and reads the chronicle. An optional local LLM acts
 * as game master and narrates each result.
 */
export function cartridgeRuntime(): void {
  interface Good { id: string; name: string }
  interface Town { id: number; name: string; lat: number; lon: number; pop: number; polity?: string; era: string; prices: Record<string, number>; buildings: string[]; founded: number }
  interface Species { id: number; name: string; sci: string; clade: string; habitat: string; diet: string; massKg: number; died: number; pop: number; sapient: boolean }
  interface Ruin { name: string; cell: number; lat?: number; lon?: number; time: number; era: string; polity: string; guardian?: string }
  interface World {
    seed: number;
    time: number;
    star: { name: string };
    goods: Good[];
    settlements: Town[];
    species: Species[];
    ruins: Ruin[];
    polities: { name: string; gov: string; pop: number; fell: number }[];
    religions: { name: string; deity: string; doctrine: string; followers: number }[];
    chronicle: { time: number; kind: string; text: string }[];
    artifacts: { kind: string; cell: number; text: string; tech: string | null; found: boolean }[];
    persons: { name: string; role: string; deeds: string[] }[];
    spells: { name: string }[];
  }
  interface Gm { kind: string; endpoint: string; model: string }
  interface Fight { name: string; hp: number; atk: number; boss: boolean }
  interface Save {
    day: number;
    at: number;
    ruin: number;
    floor: number;
    gold: number;
    hp: number;
    maxHp: number;
    lv: number;
    xp: number;
    cargo: Record<string, number>;
    seen: number[];
    relics: string[];
    cleared: number[];
    log: { t: string; c: string }[];
    gm: Gm;
    rng: number;
  }

  const byId = (id: string) => document.getElementById(id);
  const W = JSON.parse(byId('world')!.textContent || '{}') as World;
  const MAP = JSON.parse(byId('map')?.textContent || 'null') as string | null;
  const GM0 = JSON.parse(byId('gm')?.textContent || '{}') as Gm;
  const app = byId('app')!;
  const KEY = 'chronobiome.cartridge.' + W.seed + '.' + Math.round(W.time);
  const CAP = 60;
  const towns = W.settlements.slice().sort((a, b) => b.pop - a.pop);
  const living = W.species.filter((s) => s.died < 0 && s.habitat === 'land' && !s.sapient && s.massKg >= 0.05);
  const goodName: Record<string, string> = {};
  for (const g of W.goods) goodName[g.id] = g.name;

  const h = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const fmt = (n: number) => (n >= 1e8 ? (n / 1e8).toFixed(1) + '億' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : String(Math.round(n)));
  const yrs = (t: number) => (t >= 1e8 ? (t / 1e8).toFixed(2) + '億年' : t >= 1e4 ? (t / 1e4).toFixed(1) + '万年' : Math.round(t) + '年');

  function fresh(): Save {
    return {
      day: 1, at: towns.length ? 0 : -1, ruin: -1, floor: 0, gold: 120, hp: 20, maxHp: 20, lv: 1, xp: 0, cargo: {}, seen: [], relics: [], cleared: [], log: [],
      gm: { kind: GM0.kind || 'none', endpoint: GM0.endpoint || 'http://localhost:11434', model: GM0.model || 'llama3.2' }, rng: (W.seed ^ 0x9e3779b9) >>> 0,
    };
  }
  let S: Save = fresh();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) S = Object.assign(fresh(), JSON.parse(raw));
  } catch {
    // No storage (private window): the game simply does not persist.
  }
  let view = 'none';
  let busy = false;
  let downed = false;

  function save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(S));
    } catch {
      // Not persisted.
    }
  }
  function rand(): number {
    let t = (S.rng = (S.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)];
  const roll = (n: number) => 1 + Math.floor(rand() * n);
  function say(t: string, c = ''): void {
    S.log.push({ t, c });
    if (S.log.length > 160) S.log.splice(0, S.log.length - 160);
  }
  function km(a: { lat?: number; lon?: number }, b: { lat?: number; lon?: number }): number {
    const r = Math.PI / 180;
    const la1 = (a.lat || 0) * r, la2 = (b.lat || 0) * r, dl = ((b.lon || 0) - (a.lon || 0)) * r;
    const c = Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dl);
    return 6371 * Math.acos(Math.max(-1, Math.min(1, c)));
  }
  const here = (): { lat?: number; lon?: number } => (S.ruin >= 0 ? W.ruins[S.ruin] : S.at >= 0 ? towns[S.at] : { lat: 0, lon: 0 });
  const load = () => Object.values(S.cargo).reduce((a, b) => a + b, 0);
  const atk = () => 2 + S.lv + Math.min(4, S.relics.length);

  function gainXp(n: number): void {
    S.xp += n;
    while (S.xp >= S.lv * 12) {
      S.xp -= S.lv * 12;
      S.lv++;
      S.maxHp += 5;
      S.hp = S.maxHp;
      say('腕が上がった（レベル ' + S.lv + '）。', 'good');
    }
  }

  /** Automatic combat; returns true when the player wins. */
  function fight(f: Fight): boolean {
    say((f.boss ? '守護者' : '') + f.name + 'が襲いかかってきた！', 'bad');
    for (let round = 0; round < 40; round++) {
      const dmg = roll(atk() + 2);
      f.hp -= dmg;
      if (f.hp <= 0) {
        say(f.name + 'を退けた。', 'good');
        gainXp(f.boss ? 25 : 4);
        return true;
      }
      const hit = Math.max(0, roll(f.atk + 1) - 1);
      S.hp -= hit;
      if (S.hp <= 0) {
        collapse();
        return false;
      }
      if (!f.boss && S.hp < S.maxHp * 0.3 && rand() < 0.6) {
        say('深手を負い、逃げ出した。');
        return false;
      }
    }
    say(f.name + 'は去っていった。');
    return false;
  }
  function collapse(): void {
    downed = true;
    S.hp = Math.max(1, Math.round(S.maxHp * 0.25));
    S.gold = Math.floor(S.gold / 2);
    S.cargo = {};
    S.ruin = -1;
    const p = here();
    let best = -1, bd = Infinity;
    towns.forEach((t, i) => {
      const d = km(p, t);
      if (d < bd) { bd = d; best = i; }
    });
    S.at = best;
    say('力尽きて倒れた……。気がつくと' + (best >= 0 ? towns[best].name : '見知らぬ野営地') + 'で手当てを受けていた。荷と金の半分を失った。', 'bad');
  }
  function beast(minKg: number): Species | null {
    const list = living.filter((s) => s.massKg >= minKg);
    return list.length ? pick(list) : null;
  }
  function encounter(): void {
    const sp = beast(0.5);
    if (!sp) return;
    const carn = sp.diet === '肉食' && sp.massKg > 15;
    if (S.seen.indexOf(sp.id) < 0) {
      S.seen.push(sp.id);
      say('見たことのない生き物に出会った：' + sp.name + '（' + sp.sci + '）。図鑑に記録した。', 'good');
      gainXp(2);
    } else if (!carn) {
      say(sp.name + 'の群れが遠くを横切っていく。');
    }
    if (carn) {
      const lg = Math.log10(1 + sp.massKg);
      fight({ name: sp.name, hp: Math.round(3 + 4 * lg), atk: Math.round(1 + 2.2 * lg), boss: false });
    }
  }

  // ------------------------------------------------------------ actions

  const acts: Record<string, (arg: number) => void> = {
    look() {
      const t = towns[S.at];
      if (!t) return;
      say(t.name + '：' + (t.polity || '独立した町') + '、' + t.era + '時代、人口 ' + fmt(t.pop) + '。' + (t.buildings.length ? '目につくのは' + t.buildings.slice(0, 6).join('・') + '。' : ''));
      const near = W.chronicle.filter((c) => c.text.indexOf(t.name) >= 0 || (t.polity ? c.text.indexOf(t.polity) >= 0 : false));
      const rumor = near.length ? pick(near) : W.chronicle.length ? pick(W.chronicle.slice(-60)) : null;
      if (rumor) say('酒場の噂：「' + rumor.text + '」', 'muted');
      const pp = W.persons.filter((p) => p.deeds.some((d) => d.indexOf(t.name) >= 0));
      if (pp.length) {
        const p = pick(pp);
        const deed = (p.deeds[p.deeds.length - 1] || '').replace(/[。.]?$/, '');
        say('この町の語り草は' + p.role + 'の' + p.name + '。' + (deed ? deed + '。' : ''), 'muted');
      }
    },
    market() {
      view = view === 'market' ? 'none' : 'market';
    },
    buy(i) {
      const t = towns[S.at];
      const g = W.goods[i];
      const p = t.prices[g.id] || 1;
      const n = Math.min(10, CAP - load(), Math.floor(S.gold / p));
      if (n <= 0) return say(load() >= CAP ? '荷車がいっぱいだ。' : 'お金が足りない。');
      S.gold -= Math.round(p * n * 100) / 100;
      S.cargo[g.id] = (S.cargo[g.id] || 0) + n;
      say(g.name + 'を ' + n + ' 単位、' + (p * n).toFixed(1) + ' で買った。');
    },
    sell(i) {
      const t = towns[S.at];
      const g = W.goods[i];
      const have = S.cargo[g.id] || 0;
      if (!have) return say(g.name + 'を持っていない。');
      const p = (t.prices[g.id] || 1) * 0.95;
      S.gold += p * have;
      delete S.cargo[g.id];
      say(g.name + 'を ' + have + ' 単位、' + (p * have).toFixed(1) + ' で売った。', 'good');
      gainXp(1);
    },
    rest() {
      const cost = 3 + S.lv;
      if (S.gold < cost) return say('宿代 ' + cost + ' が払えない。');
      S.gold -= cost;
      S.hp = S.maxHp;
      S.day++;
      say('宿で一晩休んだ（' + cost + '）。体力が戻った。');
    },
    travel() {
      view = view === 'travel' ? 'none' : 'travel';
    },
    go(i) {
      const dest = i >= 0 ? towns[i] : W.ruins[-i - 1];
      if (!dest) return;
      const days = Math.max(1, Math.round(km(here(), dest) / 35));
      say(dest.name + (i >= 0 ? '' : 'の遺跡') + 'へ向けて発った（およそ ' + days + ' 日）。');
      const steps = Math.min(days, 30);
      downed = false;
      for (let d = 0; d < steps; d++) {
        S.day += Math.ceil(days / steps);
        if (rand() < 0.22) encounter();
        // Collapsed on the road: the journey ends in the nearest town.
        if (downed) return;
      }
      if (i >= 0) {
        S.at = i;
        S.ruin = -1;
        say(dest.name + 'に着いた。');
        acts.look(0);
      } else {
        S.ruin = -i - 1;
        S.floor = 0;
        const r = W.ruins[S.ruin];
        say(r.name + 'の遺跡に着いた。' + r.polity + 'が栄え、' + r.era + '時代に滅びた町だ。' + (S.cleared.indexOf(S.ruin) >= 0 ? 'すでに守護者は倒した。' : r.guardian ? '奥に' + r.guardian + 'が棲むという。' : ''));
      }
      view = 'none';
    },
    descend() {
      const r = W.ruins[S.ruin];
      if (!r) return;
      const floors = 3 + Math.floor(Math.max(0, ['旧石器', '新石器', '青銅器', '鉄器', '古典', '中世', '近世', '産業', '近代', '情報', '宇宙'].indexOf(r.era)) / 3);
      S.floor++;
      S.day++;
      if (S.floor >= floors) {
        if (S.cleared.indexOf(S.ruin) >= 0) {
          say('最深部は静まり返っている。もう何もない。');
          S.floor = floors - 1;
          return;
        }
        const win = fight({ name: r.guardian || 'いにしえの番人', hp: 26 + 8 * floors, atk: 3 + floors, boss: true });
        if (win) {
          S.cleared.push(S.ruin);
          const prize = r.name + 'の秘宝';
          S.relics.push(prize);
          S.gold += 150 + 40 * floors;
          say('最深部で「' + prize + '」と金貨を見つけた！', 'good');
        } else if (S.ruin >= 0) S.floor = Math.max(0, S.floor - 1);
        return;
      }
      const u = rand();
      if (u < 0.4) {
        const sp = beast(5);
        const lg = Math.log10(1 + (sp ? sp.massKg : 50));
        fight({ name: sp ? '洞に棲みついた' + sp.name : '影のような獣', hp: Math.round(4 + 4 * lg + S.floor * 2), atk: Math.round(1 + 2 * lg + S.floor), boss: false });
      } else if (u < 0.7) {
        const g = Math.round((10 + 30 * rand()) * S.floor);
        S.gold += g;
        say('崩れた棚から古い貨幣を見つけた（' + g + '）。', 'good');
      } else if (u < 0.88) {
        const d = roll(3 + S.floor);
        S.hp = Math.max(1, S.hp - d);
        say('床が抜け、怪我をした（-' + d + '）。', 'bad');
      } else {
        const art = W.artifacts.find((a) => a.cell === r.cell && S.relics.indexOf(a.kind + '：' + a.text) < 0);
        if (art) {
          S.relics.push(art.kind + '：' + art.text);
          say('「' + art.kind + '」を見つけた：' + art.text + (art.tech ? '（失われた技術「' + art.tech + '」の手がかり）' : ''), 'good');
          gainXp(5);
        } else say('壁に、読めない文字の刻まれた石板があった。');
      }
      say('地下 ' + S.floor + ' 層まで降りた。', 'muted');
    },
    leave() {
      const from = here();
      let best = -1, bd = Infinity;
      towns.forEach((t, i) => {
        const d = km(from, t);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0) acts.go(best);
      else {
        S.ruin = -1;
        say('遺跡をあとにした。');
      }
    },
    walk() {
      S.day++;
      if (rand() < 0.7) encounter();
      else say('風の音だけが聞こえる。');
    },
    journal() {
      view = view === 'journal' ? 'none' : 'journal';
    },
    history() {
      view = view === 'history' ? 'none' : 'history';
    },
    world() {
      view = view === 'world' ? 'none' : 'world';
    },
    gmset() {
      view = view === 'gm' ? 'none' : 'gm';
    },
    name() {
      const parts = towns.map((t) => t.name).filter((n) => n.length >= 2);
      if (parts.length < 2) return say('名前の種になる地名がない。');
      const a = pick(parts), b = pick(parts);
      say('この土地らしい名前：「' + a.slice(0, Math.ceil(a.length / 2)) + b.slice(Math.floor(b.length / 2)) + '」', 'muted');
    },
    reset() {
      if (!confirm('最初からやり直しますか？')) return;
      S = fresh();
      view = 'none';
      intro();
    },
  };

  function intro(): void {
    const last = W.chronicle.length ? W.chronicle[W.chronicle.length - 1] : null;
    say(W.star.name + 'の世界、始まりから ' + yrs(W.time) + '。' + (last ? '最近の出来事：「' + last.text + '」' : ''));
    if (S.at >= 0) {
      say('あなたは駆け出しの行商人。' + towns[S.at].name + 'の市場で荷車を一台手に入れた。町から町へ品物を運び、遺跡に挑み、まだ誰も知らない生き物を記録しよう。');
      acts.look(0);
    } else say('この世界にはまだ町がない。あなたは名もなき旅人として、生き物たちの大地を歩く。');
  }

  // ------------------------------------------------------------ game master (optional local LLM)

  function context(): string {
    const p = here() as Town & Ruin;
    const lines = [
      '世界: ' + W.star.name + 'の世界、始まりから ' + yrs(W.time) + '。',
      '主な国: ' + W.polities.filter((x) => x.fell < 0).slice(0, 5).map((x) => x.name + '（' + x.gov + '）').join('、'),
      '宗教: ' + W.religions.slice(0, 4).map((r) => r.name).join('、'),
      '現在地: ' + (p && p.name ? p.name + (S.ruin >= 0 ? 'の遺跡 地下' + S.floor + '層' : '') : '荒野'),
      'プレイヤー: レベル' + S.lv + '、体力' + S.hp + '/' + S.maxHp + '、所持金' + Math.round(S.gold) + '、持ち物 ' + (S.relics.join('、') || 'なし'),
      '直前の出来事: ' + S.log.slice(-4).map((l) => l.t).join(' / '),
    ];
    return lines.join('\n');
  }
  async function narrate(action: string): Promise<void> {
    if (S.gm.kind === 'none' || busy) return;
    busy = true;
    render();
    const sys = 'あなたはこの世界を舞台にした TRPG のゲームマスターです。与えられた事実だけを根拠に、日本語でプレイヤーの行動の結果を 2〜4 文で描写し、最後に次の選択肢を 2〜3 個示します。数値や固有名詞を勝手に作りません。';
    const messages = [{ role: 'system', content: sys }, { role: 'user', content: '舞台:\n' + context() + '\n\nプレイヤーの行動: ' + action }];
    const base = S.gm.endpoint.replace(/\/+$/, '');
    try {
      let text = '';
      if (S.gm.kind === 'ollama') {
        const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: S.gm.model, messages, stream: false }) });
        const d = (await r.json()) as { message?: { content?: string } };
        text = (d.message && d.message.content) || '';
      } else {
        const url = /\/v1$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: S.gm.model, messages }) });
        const d = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
      }
      if (text.trim()) say(text.trim(), 'gm');
    } catch {
      say('（ゲームマスターに連絡がつかない。LLM サーバーが起動していて、このファイルからの接続を許可しているか確認してください。）', 'muted');
    } finally {
      busy = false;
      save();
      render();
    }
  }

  // ------------------------------------------------------------ view

  function panel(): string {
    if (view === 'market' && S.at >= 0 && S.ruin < 0) {
      const t = towns[S.at];
      let rows = '';
      W.goods.forEach((g, i) => {
        const p = t.prices[g.id];
        if (p === undefined) return;
        rows += '<tr><td>' + h(g.name) + '</td><td>' + p.toFixed(2) + '</td><td>' + (S.cargo[g.id] || 0) + '</td><td><button data-a="buy" data-i="' + i + '">買う</button> <button data-a="sell" data-i="' + i + '"' + (S.cargo[g.id] ? '' : ' disabled') + '>売る</button></td></tr>';
      });
      return '<h2>' + h(t.name) + 'の市場</h2><table><tr><th>品</th><th>値</th><th>手持ち</th><th></th></tr>' + rows + '</table><p class="muted small">10 単位ずつ買い、手持ちを全部売ります（手数料 5%）。安い町で買って高い町で売ろう。</p>';
    }
    if (view === 'travel') {
      const p = here();
      const list: { name: string; d: number; i: number; ruin: boolean }[] = [];
      towns.forEach((t, i) => i !== S.at && list.push({ name: t.name + '（' + (t.polity || '') + '）', d: km(p, t), i, ruin: false }));
      W.ruins.forEach((r, i) => r.lat !== undefined && i !== S.ruin && list.push({ name: r.name + 'の遺跡' + (S.cleared.indexOf(i) >= 0 ? '（踏破）' : ''), d: km(p, r), i: -i - 1, ruin: true }));
      list.sort((a, b) => a.d - b.d);
      return '<h2>行き先</h2><table>' + list.slice(0, 14).map((x) => '<tr><td>' + (x.ruin ? '⛫ ' : '') + h(x.name) + '</td><td>' + Math.round(x.d) + ' km ・ 約 ' + Math.max(1, Math.round(x.d / 35)) + ' 日</td><td><button data-a="go" data-i="' + x.i + '">行く</button></td></tr>').join('') + '</table>';
    }
    if (view === 'journal') {
      const seen = W.species.filter((s) => S.seen.indexOf(s.id) >= 0);
      return '<h2>図鑑（' + seen.length + ' / ' + living.length + '）</h2>' + (seen.length ? '<table>' + seen.map((s) => '<tr><td>' + h(s.name) + '</td><td class="muted">' + h(s.sci) + '</td><td>' + h(s.diet) + ' ・ ' + (s.massKg >= 1000 ? (s.massKg / 1000).toFixed(1) + ' t' : s.massKg.toPrecision(2) + ' kg') + '</td></tr>').join('') + '</table>' : '<p class="muted">まだ何も記録していない。旅に出よう。</p>');
    }
    if (view === 'history') {
      return '<h2>年代記</h2><table>' + W.chronicle.filter((c) => c.kind !== 'sky').slice(-80).reverse().map((c) => '<tr><td class="muted">' + yrs(c.time) + '</td><td>' + h(c.text) + '</td></tr>').join('') + '</table>';
    }
    if (view === 'world') {
      const pos = (p: { lat?: number; lon?: number }) => 'left:' + (((p.lon || 0) + 180) / 360) * 100 + '%;top:' + ((90 - (p.lat || 0)) / 180) * 100 + '%';
      let m = '';
      if (MAP) {
        m = '<div class="map"><img alt="世界地図" src="' + MAP + '">';
        for (const t of towns.slice(0, 60)) m += '<i style="' + pos(t) + '" title="' + h(t.name) + '"></i>';
        for (const r of W.ruins) if (r.lat !== undefined) m += '<i class="ruin" style="' + pos(r) + '" title="' + h(r.name) + 'の遺跡"></i>';
        m += '<i class="here" style="' + pos(here()) + '" title="現在地"></i></div>';
      }
      const pol = W.polities.filter((p) => p.fell < 0).sort((a, b) => b.pop - a.pop).slice(0, 10);
      return '<h2>世界</h2>' + m + '<table>' + pol.map((p) => '<tr><td>' + h(p.name) + '</td><td>' + h(p.gov) + '</td><td>' + fmt(p.pop) + ' 人</td></tr>').join('') + '</table>' +
        (W.religions.length ? '<p class="small">宗教：' + W.religions.slice(0, 8).map((r) => h(r.name) + '（' + h(r.deity) + '）').join('、') + '</p>' : '') +
        '<p><button data-a="name">この土地らしい名前を考える</button></p>';
    }
    if (view === 'gm') {
      return '<h2>ゲームマスター（ローカル LLM）</h2><div class="row"><select id="gk"><option value="none"' + (S.gm.kind === 'none' ? ' selected' : '') + '>使わない</option><option value="ollama"' + (S.gm.kind === 'ollama' ? ' selected' : '') + '>Ollama</option><option value="openai"' + (S.gm.kind === 'openai' ? ' selected' : '') + '>OpenAI 互換</option></select>' +
        '<input id="ge" size="28" value="' + h(S.gm.endpoint) + '"><input id="gmod" size="14" value="' + h(S.gm.model) + '"><button data-a="gmsave">保存</button></div>' +
        '<p class="muted small">ファイルを直接開いた場合、Ollama には OLLAMA_ORIGINS=* などで接続を許可してください。GM がいなくてもゲームは遊べます。</p>';
    }
    return '';
  }

  function render(): void {
    const t = S.at >= 0 ? towns[S.at] : null;
    const r = S.ruin >= 0 ? W.ruins[S.ruin] : null;
    const place = r ? r.name + 'の遺跡 地下' + S.floor + '層' : t ? t.name : '荒野';
    const b = (a: string, label: string, dis = false) => '<button data-a="' + a + '"' + (dis || busy ? ' disabled' : '') + '>' + label + '</button>';
    let actions = '';
    if (r) actions = b('descend', S.floor === 0 ? '中へ入る' : 'さらに奥へ') + b('leave', '遺跡を出る');
    else if (t) actions = b('look', '町を歩く') + b('market', '市場') + b('rest', '宿で休む') + b('travel', '旅に出る');
    else actions = b('walk', '歩く');
    actions += b('journal', '図鑑') + b('history', '年代記') + b('world', '世界') + b('gmset', 'GM');
    const cargo = Object.keys(S.cargo).map((k) => (goodName[k] || k) + ' ' + S.cargo[k]).join('、');
    app.innerHTML =
      '<h1>' + h(W.star.name) + 'の世界</h1>' +
      '<div class="bar"><span>' + h(place) + '</span><span>' + S.day + ' 日目</span><span>所持金 ' + Math.floor(S.gold) + '</span><span>体力 ' + S.hp + '/' + S.maxHp + '</span><span>Lv ' + S.lv + '</span><span>荷 ' + load() + '/' + CAP + (cargo ? '（' + h(cargo) + '）' : '') + '</span>' + (S.relics.length ? '<span>宝 ' + S.relics.length + '</span>' : '') + '</div>' +
      '<div class="log" id="log">' + S.log.map((l) => '<p class="' + l.c + '">' + h(l.t) + '</p>').join('') + (busy ? '<p class="muted">……</p>' : '') + '</div>' +
      '<div class="acts">' + actions + '</div>' +
      (S.gm.kind !== 'none' ? '<div class="row"><input id="free" size="40" placeholder="自由に行動する（GM が描写します）"><button data-a="free"' + (busy ? ' disabled' : '') + '>行動</button></div>' : '') +
      '<div>' + panel() + '</div>' +
      '<p class="muted small" style="margin-top:24px">ChronoBiome ワールド・カートリッジ ・ シード ' + W.seed + ' <button data-a="reset">最初から</button></p>';
    const log = byId('log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  app.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('button');
    if (!el || el.disabled) return;
    const a = el.getAttribute('data-a') || '';
    const i = Number(el.getAttribute('data-i') || 0);
    if (a === 'gmsave') {
      S.gm = { kind: (byId('gk') as HTMLSelectElement).value, endpoint: (byId('ge') as HTMLInputElement).value, model: (byId('gmod') as HTMLInputElement).value };
      say('ゲームマスターの設定を保存した。', 'muted');
      view = 'none';
    } else if (a === 'free') {
      const v = (byId('free') as HTMLInputElement).value.trim();
      if (v) {
        say('あなた：' + v);
        save();
        void narrate(v);
        return;
      }
    } else if (acts[a]) {
      const before = S.log.length;
      acts[a](i);
      const narrated = ['look', 'go', 'descend', 'walk', 'rest'];
      if (narrated.indexOf(a) >= 0 && S.log.length > before) {
        save();
        render();
        void narrate(S.log.slice(before).map((l) => l.t).join(' '));
        return;
      }
    }
    save();
    render();
  });

  if (!S.log.length) intro();
  render();
}
