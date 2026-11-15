import { useState } from 'preact/hooks';
import type { ChronicleKind } from '../../core/world/state';
import { controller, ui, type Panel } from '../controller';
import { Bars, fmtNum, Meter, Section, Sparkline, speciesColor, years } from '../widgets';
import { SpeciesPanel, TechPanel, TownPanel } from './cards';
import { SpellPanel } from './magic';
import { ExportPanel, LabPanel, LlmPanel, PlayPanel } from './play';
import { SkyPanel } from './sky';

const TABS: { id: Panel; name: string; magic?: boolean }[] = [
  { id: 'world', name: '世界' },
  { id: 'chronicle', name: '年代記' },
  { id: 'cell', name: '地点' },
  { id: 'species', name: '生物' },
  { id: 'nations', name: '国家' },
  { id: 'town', name: '町' },
  { id: 'tech', name: '技術' },
  { id: 'sky', name: '天空' },
  { id: 'spell', name: '魔法', magic: true },
  { id: 'play', name: 'プレイ' },
  { id: 'lab', name: '実験' },
  { id: 'export', name: '書き出し' },
  { id: 'llm', name: 'AI' },
];

export function SidePanel() {
  const w = ui.world.value;
  if (!ui.panelOpen.value) {
    return (
      <button class="side-open panel" onClick={() => (ui.panelOpen.value = true)} title="パネルを開く">
        ◀ 詳細
      </button>
    );
  }
  const tabs = TABS.filter((t) => !t.magic || w?.magic);
  const p = ui.panel.value;
  return (
    <aside class="side panel" aria-label="詳細パネル">
      <div class="side-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={p === t.id} class={p === t.id ? 'on' : ''} onClick={() => openPanel(t.id)}>
            {t.name}
          </button>
        ))}
        <button class="side-close" onClick={() => (ui.panelOpen.value = false)} title="パネルを閉じる" aria-label="パネルを閉じる">
          ▶
        </button>
      </div>
      <div class="side-body">
        {p === 'world' && <WorldPanel />}
        {p === 'chronicle' && <ChroniclePanel />}
        {p === 'cell' && <CellPanel />}
        {p === 'species' && <SpeciesPanel />}
        {p === 'nations' && <NationsPanel />}
        {p === 'town' && <TownPanel />}
        {p === 'tech' && <TechPanel />}
        {p === 'sky' && <SkyPanel />}
        {p === 'spell' && <SpellPanel />}
        {p === 'play' && <PlayPanel />}
        {p === 'lab' && <LabPanel />}
        {p === 'export' && <ExportPanel />}
        {p === 'llm' && <LlmPanel />}
      </div>
    </aside>
  );
}

export function openPanel(p: Panel): void {
  ui.panel.value = p;
  ui.panelOpen.value = true;
  if (p === 'tech') void controller.loadTech();
  if (p === 'sky') void controller.loadSky();
  if (p === 'play') void controller.loadPlayer();
  if (p === 'world') void controller.loadKeyframes();
}

// ------------------------------------------------------------ world

function WorldPanel() {
  const s = ui.summary.value;
  const h = ui.history.value;
  if (!s) return <p class="muted">世界を生成しています…</p>;
  const c = s.civ;
  return (
    <>
      <Section title="主星と気候">
        <dl class="kv">
          <dt>主星</dt>
          <dd>{s.star.name}（{s.star.stage}、明るさ {s.star.luminosity.toFixed(2)}）</dd>
          <dt>CO2</dt>
          <dd>{fmtNum(s.climate.co2)} ppm{s.climate.emission > 0.01 ? `（人為排出 ${s.climate.emission.toFixed(2)} ppm/年）` : ''}</dd>
          <dt>気温</dt>
          <dd>{s.climate.dT >= 0 ? '+' : ''}{s.climate.dT.toFixed(1)}℃ ・ {s.climate.regime}</dd>
          <dt>氷床</dt>
          <dd><Meter value={s.climate.iceShare} color="#cfe6ff" /> 陸の {(s.climate.iceShare * 100).toFixed(0)}%</dd>
        </dl>
        <Sparkline values={h.map((x) => x.dT)} color="#f0a050" label="気温偏差" />
      </Section>
      <Section title="生命">
        <dl class="kv">
          <dt>段階</dt>
          <dd>{s.life.stageName}</dd>
          <dt>現生種</dt>
          <dd>{s.life.species} 種（絶滅 {fmtNum(s.life.extinct)}、大量絶滅 {s.life.massExtinctions} 回）</dd>
          <dt>酸素</dt>
          <dd>{s.life.oxygen.toFixed(1)}%</dd>
          <dt>陸の植生</dt>
          <dd><Meter value={s.life.vegetation} color="#6fbf6a" /> {(s.life.vegetation * 100).toFixed(0)}%</dd>
          {s.life.sapient && (
            <>
              <dt>知性種</dt>
              <dd>{s.life.sapient}</dd>
            </>
          )}
        </dl>
        <Sparkline values={h.map((x) => x.species)} color="#7fd07f" label="種の数" />
        {s.life.clades.length > 0 && <Bars items={s.life.clades.slice(0, 10)} color="#7fd07f" />}
      </Section>
      {c.started ? (
        <Section title="文明">
          <dl class="kv">
            <dt>時代</dt>
            <dd>{c.eraName}時代</dd>
            <dt>人口</dt>
            <dd>{fmtNum(c.pop)} 人 ・ 集落 {c.settlements} ・ 国 {c.polities}</dd>
            <dt>文化</dt>
            <dd>宗教 {c.religions} ・ 言語 {c.languages} ・ 技術 {c.techs}</dd>
            <dt>戦争</dt>
            <dd>{c.wars} 件が進行中</dd>
            <dt>犠牲</dt>
            <dd>戦争 {fmtNum(c.deaths.war)} ・ 疫病 {fmtNum(c.deaths.plague)} ・ 飢饉 {fmtNum(c.deaths.famine)}</dd>
            {(c.ruins > 0 || c.colonies > 0) && (
              <>
                <dt>その他</dt>
                <dd>遺跡 {c.ruins}{c.colonies ? ` ・ 宇宙植民地 ${c.colonies}` : ''}{c.spells ? ` ・ 呪文 ${c.spells}` : ''}</dd>
              </>
            )}
          </dl>
          <Sparkline values={h.map((x) => x.pop)} log color="#ffcf70" label="人口（対数）" />
        </Section>
      ) : (
        <Section title="文明">
          <p class="muted">まだ文明はありません。社会性のある温血の雑食動物が知性を獲得すると、最初の集落が生まれます。</p>
        </Section>
      )}
      <Keyframes />
    </>
  );
}

function Keyframes() {
  const ks = ui.keyframes.value;
  return (
    <Section title="時間の分岐点" right={<button onClick={() => controller.keyframe('手動')}>今を保存</button>}>
      {ks.length === 0 ? (
        <p class="muted">時間を進めると自動で保存されます。戻ってから進めると、別の歴史が始まります。</p>
      ) : (
        <ul class="list">
          {[...ks].reverse().map((k) => (
            <li key={k.index}>
              <span>{years(k.time)}</span>
              <span class="muted">{k.label}</span>
              <button onClick={() => controller.restore(k.index)}>戻る</button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------ chronicle

const KINDS: { id: ChronicleKind | 'all'; name: string }[] = [
  { id: 'all', name: 'すべて' },
  { id: 'life', name: '生命' },
  { id: 'climate', name: '気候' },
  { id: 'geo', name: '大地' },
  { id: 'civ', name: '文明' },
  { id: 'war', name: '戦争' },
  { id: 'tech', name: '技術' },
  { id: 'religion', name: '宗教' },
  { id: 'disaster', name: '災害' },
  { id: 'space', name: '宇宙' },
  { id: 'magic', name: '魔法' },
  { id: 'sky', name: '天文' },
];

function ChroniclePanel() {
  const [kind, setKind] = useState<ChronicleKind | 'all'>('all');
  const all = ui.chronicle.value;
  const list = (kind === 'all' ? all.filter((e) => e.kind !== 'sky') : all.filter((e) => e.kind === kind)).slice(-300).reverse();
  const llm = ui.llm.value.kind !== 'none';
  return (
    <>
      <div class="chips-row">
        {KINDS.map((k) => (
          <button key={k.id} class={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>
            {k.name}
          </button>
        ))}
      </div>
      {llm && (
        <div class="narrate">
          <button onClick={() => controller.narrate()} disabled={ui.llmBusy.value}>
            {ui.llmBusy.value ? '執筆中…' : '最近の出来事を物語にする'}
          </button>
          {ui.narration.value && <p class="prose">{ui.narration.value}</p>}
        </div>
      )}
      {list.length === 0 ? (
        <p class="muted">まだ記録はありません。時間を進めてください。</p>
      ) : (
        <ol class="chronicle">
          {list.map((e) => (
            <li key={e.seq} class={`k-${e.kind}`}>
              <time>{years(e.time)}</time>
              <span>
                {e.text}
                {e.cell !== undefined && (
                  <button class="link" onClick={() => controller.focus(e.cell!)} title="その場所へ">
                    ⌖
                  </button>
                )}
                {e.species !== undefined && (
                  <button class="link" onClick={() => controller.showSpecies(e.species!)} title="その生物">
                    🔍
                  </button>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

// ------------------------------------------------------------ cell

const LAND_USE = ['自然のまま', '農地', '市街地', '遺跡'];

function CellPanel() {
  const c = ui.cell.value;
  const w = ui.world.value;
  if (!c || !w || ui.selected.value < 0) return <p class="muted">地表をクリックすると、その地点の自然・人・生き物を表示します。</p>;
  const biome = w.biomes[c.biome];
  const ns = c.latDeg >= 0 ? '北緯' : '南緯';
  const ew = c.lonDeg >= 0 ? '東経' : '西経';
  return (
    <>
      <div class="card-head">
        <span class="swatch" style={{ background: biome?.color }} />
        <strong>{c.heightM < 0 ? '海' : biome?.name ?? '不明'}</strong>
        <button onClick={() => controller.focus(c.cell)} title="ここへ飛ぶ">⌖</button>
        <button class="close" onClick={() => controller.select(-1)} aria-label="閉じる">×</button>
      </div>
      <dl class="kv">
        <dt>位置</dt>
        <dd>{ns} {Math.abs(c.latDeg).toFixed(1)}° ・ {ew} {Math.abs(c.lonDeg).toFixed(1)}°</dd>
        <dt>{c.heightM >= 0 ? '標高' : '水深'}</dt>
        <dd>{Math.abs(Math.round(c.heightM)).toLocaleString('ja-JP')} m</dd>
        <dt>気温</dt>
        <dd>{c.temperature.toFixed(1)}℃（年平均 {c.tempMean.toFixed(1)}℃ ・ 年較差 {(c.seasonAmp * 2).toFixed(0)}℃）</dd>
        <dt>湿潤度</dt>
        <dd><Meter value={c.moisture} /> {(c.moisture * 100).toFixed(0)}%</dd>
        <dt>プレート</dt>
        <dd>#{c.plate} ・ {c.plateSpeedCmPerYr.toFixed(1)} cm/年{c.stress > 0.05 ? ' ・ 収束境界' : c.stress < -0.05 ? ' ・ 発散境界' : ''}</dd>
        <dt>地殻</dt>
        <dd>{c.continentalCrust ? '大陸' : '海洋'} {c.crustKm.toFixed(1)} km ・ {years(c.crustAgeMyr * 1e6)}</dd>
        {c.flow >= 1 && (
          <>
            <dt>流域</dt>
            <dd>{Math.round(c.flow).toLocaleString('ja-JP')} セル分の雨{c.flow >= 10 ? '（大河）' : ''}</dd>
          </>
        )}
        <dt>土地</dt>
        <dd>{LAND_USE[c.landUse] ?? '—'}{c.people > 0.01 ? ` ・ ${fmtNum(c.people)} 人/km²` : ''}</dd>
        <dt>生物</dt>
        <dd>{c.richness.toFixed(0)} 種</dd>
        {w.magic && (
          <>
            <dt>マナ</dt>
            <dd><Meter value={c.mana / 2} color="#b98cff" /> {c.mana.toFixed(2)}</dd>
          </>
        )}
      </dl>
      {c.town && (
        <Section title="町">
          <button class="row-btn" onClick={() => controller.showTown(c.town!.id)}>
            <span class="swatch" style={{ background: c.town.color }} /> {c.town.name}（{c.town.polity}）・ 人口 {fmtNum(c.town.pop)} →
          </button>
        </Section>
      )}
      {c.ruin && (
        <Section title="遺跡">
          <p>{c.ruin.name}の遺跡（{c.ruin.era}時代、{years(c.ruin.time)}に滅亡）</p>
          <button onClick={() => controller.act({ kind: 'excavate', cell: c.cell })}>発掘する</button>
        </Section>
      )}
      <Section title="この地域の生き物">
        {c.life.length === 0 ? (
          <p class="muted">{c.heightM < 0 ? '海の生き物は見つかりません。' : 'まだ生き物はいません。'}</p>
        ) : (
          <ul class="list species-list">
            {c.life.map((sp) => (
              <li key={sp.id}>
                <button class="row-btn" onClick={() => controller.showSpecies(sp.id)}>
                  <span class="swatch" style={{ background: speciesColor(sp.hue, sp.shade, sp.clade) }} />
                  <span class="grow">{sp.name}{sp.sapient ? ' ★' : ''}</span>
                  <span class="muted">{sp.habitat ? '海' : '陸'} ・ {fmtNum(sp.density)}/km²</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// ------------------------------------------------------------ nations

function NationsPanel() {
  const s = ui.summary.value;
  const towns = ui.towns.value;
  if (!s?.civ.started) return <p class="muted">まだ国はありません。文明が生まれると、集落が国にまとまり、首長国・王国・帝国へと育ちます。</p>;
  const capitalOf = (pid: number) => towns.find((t) => t.polity === pid && t.capital) ?? towns.find((t) => t.polity === pid);
  return (
    <>
      <Section title={`主な国（${s.civ.polities} か国）`}>
        <ul class="list">
          {s.civ.topPolities.map((p) => {
            const cap = capitalOf(p.id);
            return (
              <li key={p.id}>
                <button class="row-btn" onClick={() => cap && controller.showTown(cap.id)} disabled={!cap}>
                  <span class="swatch" style={{ background: p.color }} />
                  <span class="grow">
                    <strong>{p.name}</strong>
                    <span class="muted"> {p.gov}{cap ? ` ・ 首都 ${cap.name}` : ''}</span>
                  </span>
                  <span class="muted">{fmtNum(p.pop)}人 ・ {p.settlements}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button onClick={() => controller.setLayer('territory')}>地図に領土を表示</button>
      </Section>
      <Section title={`大きな町（${towns.length}）`}>
        <ul class="list">
          {[...towns].sort((a, b) => b.pop - a.pop).slice(0, 30).map((t) => (
            <li key={t.id}>
              <button class="row-btn" onClick={() => controller.showTown(t.id)}>
                <span class="swatch" style={{ background: t.color }} />
                <span class="grow">{t.capital ? '★ ' : ''}{t.name}</span>
                <span class="muted">{fmtNum(t.pop)}{t.plague ? ' ・ 疫病' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
