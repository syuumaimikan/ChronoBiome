import { useState } from 'preact/hooks';
import { BUILDINGS, ERAS, GOODS } from '../../core/systems/society/data';
import type { SpeciesDetail, TechNode } from '../../worker/protocol';
import { controller, ui } from '../controller';
import { Bars, fmtMass, fmtNum, Meter, Section, speciesColor, years } from '../widgets';

const CLADE_NAME: Record<string, string> = {
  microbe: '微生物', alga: '藻類', plant: '植物', fungus: '菌類', sponge: '海綿', cnidarian: '刺胞動物', worm: '蠕虫', mollusc: '軟体動物',
  arthropod: '節足動物', insect: '昆虫', fish: '魚類', amphibian: '両生類', reptile: '爬虫類', bird: '鳥類', mammal: '哺乳類', marine_mammal: '海生哺乳類',
};
const PLAN_NAME = { grazer: '草食の四足', heavy: '大型の四足', small: '小型', predator: '捕食者', bird: '飛ぶもの', aquatic: '水生' } as const;
const KNOWN = ['未観察', '見かけた', 'よく知っている', '図鑑完成'];

function dietName(d: number): string {
  if (d < 0.15) return '植物食';
  if (d < 0.4) return '主に植物食の雑食';
  if (d < 0.65) return '雑食';
  if (d < 0.85) return '主に肉食の雑食';
  return '肉食';
}

// ------------------------------------------------------------ species

export function SpeciesPanel() {
  const sp = ui.species.value;
  if (!sp) return <p class="muted">地表の動物をクリックするか、地点・年代記の生物名を選ぶと、その生物の詳しい情報を表示します。</p>;
  const alive = sp.died < 0;
  const llm = ui.llm.value.kind !== 'none';
  return (
    <>
      <div class="card-head">
        <span class="swatch" style={{ background: speciesColor(sp.hue, sp.shade, sp.clade) }} />
        <div class="grow">
          <strong>{sp.name}{sp.sapient ? ' ★知性種' : ''}</strong>
          <div class="muted sci">{sp.sci}</div>
        </div>
        <button class="close" onClick={() => (ui.species.value = null)} aria-label="閉じる">×</button>
      </div>
      <Silhouette sp={sp} />
      <p class="prose">{sp.description}</p>
      <dl class="kv">
        <dt>分類</dt>
        <dd>{CLADE_NAME[sp.clade.replace('~', '')] ?? sp.clade} ・ {PLAN_NAME[sp.plan]}</dd>
        <dt>体重</dt>
        <dd>{fmtMass(sp.massKg)}</dd>
        <dt>食性</dt>
        <dd>{dietName(sp.diet)}{sp.flight ? ' ・ 飛翔' : ''}{sp.endotherm ? ' ・ 恒温' : ' ・ 変温'}</dd>
        <dt>生息</dt>
        <dd>{sp.habitat ? '海' : '陸'} ・ 適温 {sp.tempOpt.toFixed(0)}℃（±{sp.tempTol.toFixed(0)}）・ 好む湿り気 {(sp.moistOpt * 100).toFixed(0)}%</dd>
        <dt>状態</dt>
        <dd>{alive ? `現生 ・ ${years(sp.born)}に出現` : `絶滅（${years(sp.died)}${sp.cause ? `、${sp.cause}` : ''}）`}</dd>
        {alive && (
          <>
            <dt>個体数</dt>
            <dd>{fmtNum(sp.pop)}（最大 {fmtNum(sp.peakPop)}）</dd>
            <dt>分布</dt>
            <dd>{sp.range} 地域 ・ 約 {fmtNum(sp.rangeKm2)} km²</dd>
          </>
        )}
        <dt>習性</dt>
        <dd>
          <span class="trait">知能 <Meter value={sp.intelligence} color="#e0b050" /></span>
          <span class="trait">社会性 <Meter value={sp.social} color="#70b0e0" /></span>
          <span class="trait">移動力 <Meter value={sp.dispersal} color="#90d090" /></span>
        </dd>
        {sp.domesticable && (
          <>
            <dt>人との関係</dt>
            <dd>家畜にできる</dd>
          </>
        )}
        <dt>図鑑</dt>
        <dd><Meter value={sp.known / 3} color="#c8a0ff" /> {KNOWN[sp.known] ?? ''}</dd>
      </dl>
      <div class="btn-row">
        {alive && <button onClick={() => controller.showRange(sp.id)}>分布を地図に表示</button>}
        <button onClick={() => controller.act({ kind: 'observe', species: sp.id })}>観察して記録</button>
        {llm && (
          <button onClick={() => controller.fieldNote()} disabled={ui.llmBusy.value}>
            {ui.llmBusy.value ? '執筆中…' : '図鑑の解説を書く'}
          </button>
        )}
      </div>
      {ui.speciesNote.value && <p class="prose note">{ui.speciesNote.value}</p>}
      {(sp.prey.length > 0 || sp.predators.length > 0) && (
        <Section title="食物網（同じ地域）">
          <dl class="kv">
            <dt>餌</dt>
            <dd>{sp.prey.join('、') || '—'}</dd>
            <dt>天敵</dt>
            <dd>{sp.predators.join('、') || '—'}</dd>
          </dl>
        </Section>
      )}
      <Section title="系統" right={<span class="muted">子孫 {sp.descendants}（現生 {sp.livingDescendants}）</span>}>
        {sp.lineage.length === 0 ? (
          <p class="muted">祖先は記録されていません。</p>
        ) : (
          <ol class="lineage">
            {sp.lineage.map((l) => (
              <li key={l.id}>
                <button class="link" onClick={() => controller.showSpecies(l.id)}>{l.name}</button>
                <span class="muted"> {CLADE_NAME[l.clade.replace('~', '')] ?? l.clade} ・ {years(l.born)}{l.died >= 0 ? `〜${years(l.died)}` : '〜現在'}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}

/** A side-view sketch of the animal from its traits. */
function Silhouette({ sp }: { sp: SpeciesDetail }) {
  const c = speciesColor(sp.hue, sp.shade, sp.clade);
  const big = Math.min(1, Math.log10(1 + sp.massKg) / 3.5);
  const s = 0.6 + 0.5 * big;
  if (sp.plan === 'aquatic') {
    return (
      <svg class="sil" viewBox="0 0 200 80" aria-hidden="true">
        <g transform={`translate(100 40) scale(${s})`} fill={c}>
          <path d="M-70 0 C-40 -28 30 -28 55 0 C30 28 -40 28 -70 0 Z" />
          <path d="M55 0 L85 -22 L78 0 L85 22 Z" />
          <path d="M-10 -20 L10 -36 L18 -18 Z" />
          <circle cx="-48" cy="-4" r="3" fill="#111" />
        </g>
      </svg>
    );
  }
  if (sp.plan === 'bird') {
    return (
      <svg class="sil" viewBox="0 0 200 80" aria-hidden="true">
        <g transform={`translate(100 44) scale(${s})`} fill={c}>
          <ellipse cx="0" cy="0" rx="34" ry="16" />
          <circle cx="-34" cy="-12" r="11" />
          <path d="M-44 -12 L-60 -8 L-44 -6 Z" fill="#d9a441" />
          <path d="M-6 -6 C10 -46 44 -50 60 -40 C40 -30 24 -14 14 -2 Z" opacity="0.85" />
          <path d="M30 -2 L62 -10 L58 6 Z" />
          <line x1="-6" y1="14" x2="-8" y2="32" stroke={c} stroke-width="3" />
          <line x1="8" y1="14" x2="8" y2="32" stroke={c} stroke-width="3" />
          <circle cx="-38" cy="-14" r="2" fill="#111" />
        </g>
      </svg>
    );
  }
  const heavy = sp.plan === 'heavy';
  const pred = sp.plan === 'predator';
  const legH = heavy ? 18 : sp.plan === 'small' ? 10 : 24;
  const legW = heavy ? 9 : 5;
  const bodyRy = heavy ? 20 : 14;
  return (
    <svg class="sil" viewBox="0 0 200 90" aria-hidden="true">
      <g transform={`translate(100 ${50 - legH * 0.3}) scale(${s})`} fill={c}>
        <ellipse cx="0" cy="0" rx="42" ry={bodyRy} />
        {[-30, -18, 20, 32].map((x) => (
          <rect key={x} x={x - legW / 2} y={bodyRy * 0.5} width={legW} height={legH + bodyRy * 0.4} rx="2" />
        ))}
        <path d={pred ? 'M-36 -6 L-62 -16 L-74 -8 L-62 4 L-38 8 Z' : 'M-34 -6 L-52 -26 L-66 -20 L-60 -8 L-40 6 Z'} />
        {sp.horn > 0.2 && <path d={heavy ? 'M-66 -10 L-84 -22 L-68 -16 Z' : 'M-56 -24 L-60 -42 L-52 -26 Z M-50 -24 L-48 -42 L-46 -24 Z'} fill="#e8dcc0" />}
        {sp.tail > 0.15 && <path d={`M40 -4 Q${60 + sp.tail * 20} ${-10 - sp.tail * 10} ${64 + sp.tail * 24} ${6 + sp.tail * 8}`} stroke={c} stroke-width={3 + sp.tail * 4} fill="none" />}
        {sp.pattern > 0.5 && [-20, -4, 12].map((x) => <rect key={x} x={x} y={-bodyRy + 2} width="5" height={bodyRy * 1.2} fill="#000" opacity="0.18" />)}
        <circle cx={pred ? -62 : -58} cy={pred ? -10 : -18} r="2" fill="#111" />
      </g>
      <line x1="10" y1="86" x2="190" y2="86" stroke="var(--line)" stroke-width="1" />
    </svg>
  );
}

// ------------------------------------------------------------ town

export function TownPanel() {
  const t = ui.town.value;
  const player = ui.player.value;
  if (!t) return <p class="muted">地図上の町の印をクリックするか、国家の一覧から町を選ぶと、経済・研究・建築・人物を表示します。</p>;
  const here = player?.alive && player.settlement === t.name;
  return (
    <>
      <div class="card-head">
        <span class="swatch" style={{ background: t.polity.color }} />
        <div class="grow">
          <strong>{t.name}</strong>
          <div class="muted">{t.polity.name}（{t.polity.gov}）{t.polity.capital === t.name ? ' の首都' : ''}</div>
        </div>
        <button onClick={() => controller.focus(t.cell)} title="ここへ飛ぶ">⌖</button>
        <button class="close" onClick={() => (ui.town.value = null)} aria-label="閉じる">×</button>
      </div>
      <dl class="kv">
        <dt>人口</dt>
        <dd>{fmtNum(t.pop)} 人（養える上限 {fmtNum(t.K)}）・ 都市化 {(t.urban * 100).toFixed(0)}%</dd>
        <dt>時代</dt>
        <dd>{t.era}時代 ・ {years(t.founded)}に創建</dd>
        <dt>富</dt>
        <dd>{fmtNum(t.wealth)}</dd>
        <dt>言語</dt>
        <dd>{t.language}</dd>
        <dt>宗教</dt>
        <dd>{t.religion || '—'}</dd>
        <dt>統治者</dt>
        <dd>{t.polity.ruler || '—'}（国の成立 {years(t.polity.founded)}）</dd>
        {(t.plague || t.famine) && (
          <>
            <dt>危機</dt>
            <dd class="warn">{[t.plague ? `疫病 ${t.plague}` : '', t.famine ? '飢饉' : ''].filter(Boolean).join(' ・ ')}</dd>
          </>
        )}
        {t.deposits.length > 0 && (
          <>
            <dt>鉱床</dt>
            <dd>{t.deposits.join('、')}</dd>
          </>
        )}
        {t.partners.length > 0 && (
          <>
            <dt>交易相手</dt>
            <dd>{t.partners.join('、')}</dd>
          </>
        )}
        {t.golems > 0 && (
          <>
            <dt>ゴーレム</dt>
            <dd>{t.golems} 体が働いている</dd>
          </>
        )}
      </dl>
      <Section title="いま進んでいること">
        <Progress label="研究" item={t.researching} empty="研究できる技術がありません" />
        <Progress label="建設" item={t.building} empty="建設中の建物はありません" />
      </Section>
      <Section title="価値観">
        <Bars items={t.values.map((v) => [v.name, Math.round(v.v * 100)] as [string, number])} color="#e0a060" />
      </Section>
      <Section title="市場">
        <table class="tbl">
          <thead>
            <tr>
              <th>財</th>
              <th>在庫</th>
              <th>価格</th>
              <th>需給</th>
            </tr>
          </thead>
          <tbody>
            {t.goods.map((g) => (
              <tr key={g.name}>
                <td>{g.name}</td>
                <td>{fmtNum(g.stock)}</td>
                <td>{g.price.toFixed(g.price < 10 ? 2 : 0)}</td>
                <td class={g.demand > g.supply * 1.05 ? 'warn' : g.supply > g.demand * 1.2 ? 'good' : ''}>{g.demand > g.supply * 1.05 ? '不足' : g.supply > g.demand * 1.2 ? '余剰' : '均衡'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {here && <TradeBox />}
      </Section>
      <Section title={`建物（${t.buildings.reduce((a, b) => a + b.count, 0)}）`}>
        <p class="chips">
          {t.buildings.map((b) => (
            <span key={b.name} class="chip">{b.name}{b.count > 1 ? ` ×${b.count}` : ''}</span>
          ))}
        </p>
        {here && <BuildBox />}
      </Section>
      <Section title={`知っている技術（${t.techs.length}）`}>
        <ul class="list compact">
          {[...t.techs].reverse().slice(0, 24).map((x) => (
            <li key={x.name}>
              <span class="grow">{x.name}</span>
              <span class="muted">{x.field}</span>
              <Meter value={x.adoption} color="#7fb8ff" />
            </li>
          ))}
        </ul>
      </Section>
      {t.people.length > 0 && (
        <Section title="歴史上の人物">
          <ul class="list people">
            {t.people.map((p) => (
              <li key={p.name + p.born}>
                <div>
                  <strong>{p.name}</strong> <span class="muted">{p.role} ・ {years(p.born)}生</span>
                </div>
                {p.deeds.length > 0 && <div class="muted small">{p.deeds.slice(-3).join(' / ')}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {player?.alive && !here && (
        <button onClick={() => controller.act({ kind: 'travel', settlement: t.id })}>この町へ旅する</button>
      )}
    </>
  );
}

function Progress({ label, item, empty }: { label: string; item: { name: string; progress: number; cost: number } | null; empty: string }) {
  if (!item) return <p class="muted small">{label}: {empty}</p>;
  const f = item.cost > 0 ? item.progress / item.cost : 0;
  return (
    <div class="progress">
      <span>{label}: {item.name}</span>
      <Meter value={f} color="#8fd18f" />
      <span class="muted">{Math.round(f * 100)}%</span>
    </div>
  );
}

function TradeBox() {
  const [good, setGood] = useState(0);
  const [amount, setAmount] = useState(10);
  return (
    <div class="inline-form">
      <select value={good} onChange={(e) => setGood(Number((e.target as HTMLSelectElement).value))} aria-label="財">
        {GOODS.map((g, i) => (
          <option key={g.id} value={i}>{g.name}</option>
        ))}
      </select>
      <input type="number" value={amount} min={1} max={1000} onInput={(e) => setAmount(Number((e.target as HTMLInputElement).value))} aria-label="量" />
      <button onClick={() => controller.act({ kind: 'trade', good, amount })}>買う</button>
      <button onClick={() => controller.act({ kind: 'trade', good, amount: -amount })}>売る</button>
    </div>
  );
}

function BuildBox() {
  const [b, setB] = useState(0);
  return (
    <div class="inline-form">
      <select value={b} onChange={(e) => setB(Number((e.target as HTMLSelectElement).value))} aria-label="建物">
        {BUILDINGS.map((x, i) => (
          <option key={x.id} value={i}>{x.name}</option>
        ))}
      </select>
      <button onClick={() => controller.act({ kind: 'build', building: b })}>出資して建てる</button>
    </div>
  );
}

// ------------------------------------------------------------ tech

export function TechPanel() {
  const all = ui.tech.value;
  const [field, setField] = useState('すべて');
  const [onlyKnown, setOnlyKnown] = useState(false);
  if (!all.length) {
    return (
      <p class="muted">
        技術の系統図を読み込んでいます… <button onClick={() => controller.loadTech()}>再読み込み</button>
      </p>
    );
  }
  const fields = ['すべて', ...new Set(all.map((t) => t.field))];
  const known = new Set(all.filter((t) => t.first >= 0).map((t) => t.id));
  const name = new Map(all.map((t) => [t.id, t.name]));
  const list = all.filter((t) => (field === 'すべて' || t.field === field) && (!onlyKnown || known.has(t.id)));
  const byEra = new Map<number, TechNode[]>();
  for (const t of list) {
    if (!byEra.has(t.era)) byEra.set(t.era, []);
    byEra.get(t.era)!.push(t);
  }
  return (
    <>
      <p class="muted small">
        発明済み {known.size} / {all.length}。文明は需要と価値観に応じて自分で研究を選び、発明は交易路・移住・文字を通って広がります。人口が減ると技術は失われることもあります。
      </p>
      <div class="chips-row">
        {fields.map((f) => (
          <button key={f} class={field === f ? 'on' : ''} onClick={() => setField(f)}>{f}</button>
        ))}
      </div>
      <label class="check">
        <input type="checkbox" checked={onlyKnown} onChange={(e) => setOnlyKnown((e.target as HTMLInputElement).checked)} /> 発明済みだけ
      </label>
      <button onClick={() => controller.loadTech()}>最新にする</button>
      {[...byEra.entries()].sort((a, b) => a[0] - b[0]).map(([era, ts]) => (
        <Section key={era} title={`${ERAS[era] ?? era}時代`}>
          <ul class="tech-list">
            {ts.map((t) => {
              const has = known.has(t.id);
              const ready = !has && t.req.every((r) => known.has(r));
              return (
                <li key={t.id} class={has ? 'has' : ready ? 'ready' : 'locked'} title={t.req.length ? `前提: ${t.req.map((r) => name.get(r) ?? r).join('、')}` : '前提なし'}>
                  <span class="grow">
                    {t.magic ? '✦ ' : ''}{t.name}
                    <span class="muted small"> {t.field}</span>
                  </span>
                  {has ? (
                    <span class="muted small">{years(t.first)} ・ {Math.round(t.share * 100)}%の町</span>
                  ) : ready ? (
                    <span class="muted small">研究可能</span>
                  ) : (
                    <span class="muted small">未到達</span>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </>
  );
}
