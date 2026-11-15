import { useEffect, useRef } from 'preact/hooks';
import { formatDate, formatYears, LENSES, type LensId } from '../core/lens';
import { RULE_PACKS } from '../core/rules/packs/arcane';
import { LAYERS, layerById, type LayerDef, type LayerId } from '../render/layers';
import { controller, ui } from './controller';
import { openPanel, SidePanel } from './panels/side';
import { fmtNum } from './widgets';

export function ObservePage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (canvas.current) controller.attach(canvas.current);
  }, []);

  const orbit = ui.mode.value === 'orbit';
  return (
    <div class={`observe${ui.panelOpen.value ? '' : ' side-closed'}`}>
      <canvas
        ref={canvas}
        class="planet"
        onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
        onPointerUp={(e) => {
          const d = down.current;
          down.current = null;
          // A click (not a drag): animals and towns first, then the ground (from above only).
          if (e.button === 0 && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) controller.pick(e.clientX, e.clientY, orbit);
        }}
      />
      <TimeBar />
      {orbit && <ControlPanel />}
      <SidePanel />
      <Hud />
      <Help />
      {ui.toast.value && (
        <div class="note-toast panel" role="status">
          {ui.toast.value}
        </div>
      )}
      {ui.status.value === 'generating' && <div class="toast">世界を生成中…</div>}
      {ui.status.value === 'error' && (
        <div class="toast error">
          <strong>生成できませんでした</strong>
          <ul>{ui.errors.value.slice(0, 6).map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function TimeBar() {
  const lens = LENSES.find((l) => l.id === ui.lens.value)!;
  const fine = ui.dtYears.value <= 1;
  const time = fine ? formatDate(ui.time.value) : formatYears(ui.time.value);
  const s = ui.summary.value;
  return (
    <div class="timebar panel">
      <button class="play" onClick={() => controller.togglePlay()} title={ui.playing.value ? '一時停止' : '再生'} disabled={ui.status.value !== 'ready'}>
        {ui.playing.value ? '❚❚' : '▶'}
      </button>
      <button onClick={() => controller.stepOnce()} title="1 tick 進める" disabled={ui.status.value !== 'ready' || ui.playing.value}>
        ▶|
      </button>
      <div class="clock">
        <div class="clock-time">{time}</div>
        <div class="clock-sub">
          tick {ui.tick.value.toLocaleString('ja-JP')} ・ 1 tick = {formatYears(ui.dtYears.value)}
        </div>
      </div>
      <div class="lenses" role="radiogroup" aria-label="時間レンズ">
        {LENSES.map((l) => (
          <button
            key={l.id}
            role="radio"
            aria-checked={ui.lens.value === l.id}
            class={ui.lens.value === l.id ? 'on' : ''}
            title={`${l.note}（1 tick = ${formatYears(l.dtYears)}）`}
            onClick={() => controller.setLens(l.id as LensId)}
          >
            {l.name}
          </button>
        ))}
      </div>
      <label class="speed" title="1 フレームに進める tick 数">
        速度
        <select value={String(ui.ticksPerFrame.value)} onChange={(e) => (ui.ticksPerFrame.value = Number((e.target as HTMLSelectElement).value))}>
          {[1, 2, 5, 10, 30, 100].map((v) => (
            <option key={v} value={v}>×{v}</option>
          ))}
        </select>
      </label>
      {s ? (
        <div class="vitals">
          <button class="vital" onClick={() => openPanel('world')} title="生命の段階と現生種">
            {s.life.stageName} ・ {s.life.species} 種
          </button>
          {s.civ.started && (
            <button class="vital" onClick={() => openPanel('nations')} title="文明の時代・人口・国">
              {s.civ.eraName}時代 ・ {fmtNum(s.civ.pop)}人 ・ {s.civ.polities}か国{s.civ.wars ? ` ・ 戦争${s.civ.wars}` : ''}
            </button>
          )}
          <span class="vital-plain" title="気温偏差と CO2">
            {s.climate.dT >= 0 ? '+' : ''}{s.climate.dT.toFixed(1)}℃ ・ {s.climate.regime}
          </span>
        </div>
      ) : (
        <span class="lens-note">{lens.note}</span>
      )}
    </div>
  );
}

const GROUPS: { id: 'nature' | 'people'; name: string }[] = [
  { id: 'nature', name: '自然' },
  { id: 'people', name: '生き物と人' },
];

function visibleLayer(l: LayerDef): boolean {
  if (l.id === 'mana') return !!ui.world.value?.magic;
  if (l.id === 'range') return ui.rangeOf.value >= 0;
  return true;
}

function ControlPanel() {
  const w = ui.world.value;
  return (
    <div class="controls panel">
      <h2>世界</h2>
      <label class="row">
        シード
        <input
          value={ui.seed.value}
          onInput={(e) => (ui.seed.value = (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && controller.generate()}
        />
      </label>
      <div class="row buttons">
        <button class="primary" onClick={() => controller.generate()} disabled={ui.status.value === 'generating'}>
          生成
        </button>
        <button
          onClick={() => {
            ui.seed.value = Math.floor(Math.random() * 1e9).toString(36);
            void controller.generate();
          }}
          disabled={ui.status.value === 'generating'}
        >
          ランダム
        </button>
      </div>
      <label class="row">
        ルール
        <select
          value={RULE_PACKS.find((p) => p.pack.meta.name === w?.packName)?.id ?? ''}
          onChange={(e) => {
            const p = RULE_PACKS.find((x) => x.id === (e.target as HTMLSelectElement).value);
            if (!p) return;
            ui.packText.value = JSON.stringify(p.pack, null, 2);
            void controller.generate();
          }}
          disabled={ui.status.value === 'generating'}
        >
          {!RULE_PACKS.some((p) => p.pack.meta.name === w?.packName) && <option value="">{w?.packName ?? '—'}（編集済み）</option>}
          {RULE_PACKS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      {w && (
        <p class="muted">
          主星 {w.starName} ・ 生成 {Math.round(ui.genMs.value)} ms
        </p>
      )}
      {w && (
        <dl class="stats">
          <dt>プレート</dt>
          <dd>{ui.plateCount.value} 枚</dd>
          <dt>陸地</dt>
          <dd>{(ui.landShare.value * 100).toFixed(1)}%</dd>
          <dt>海面</dt>
          <dd>{ui.seaLevel.value >= 0 ? '+' : ''}{Math.round(ui.seaLevel.value)} m</dd>
        </dl>
      )}

      {GROUPS.map((g) => (
        <div key={g.id}>
          <h2>{g.name}</h2>
          <div class="layer-list" role="radiogroup" aria-label={`表示する層（${g.name}）`}>
            {LAYERS.filter((l) => (l.group ?? 'nature') === g.id && visibleLayer(l)).map((l) => (
              <button key={l.id} role="radio" aria-checked={ui.layer.value === l.id} class={ui.layer.value === l.id ? 'on' : ''} onClick={() => controller.setLayer(l.id as LayerId)}>
                {l.name}
              </button>
            ))}
          </div>
        </div>
      ))}

      <label class="row">
        起伏の誇張 ×{ui.exaggeration.value}
        <input type="range" min={0} max={80} step={5} value={ui.exaggeration.value} onInput={(e) => controller.setExaggeration(Number((e.target as HTMLInputElement).value))} />
      </label>

      <Legend />

      <p class="perf muted" title="1 tick の計算時間と描画フレームレート（静止中は再描画しません）">
        計算 {ui.tickMs.value.toFixed(1)} ms/tick ・ 描画 {ui.fps.value > 0 ? `${ui.fps.value} fps` : '静止'}
      </p>
    </div>
  );
}

function formatAltitude(m: number): string {
  if (m >= 100_000) return `${Math.round(m / 1000).toLocaleString('ja-JP')} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.max(0, Math.round(m))} m`;
}

function formatClock(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Where the camera or the player is, and the controls to go down or up. */
function Hud() {
  const v = ui.view.value;
  const w = ui.world.value;
  if (!v || !w || ui.status.value !== 'ready') return null;
  const walk = v.mode === 'walk';
  const biome = v.biome >= 0 ? w.biomes[v.biome] : undefined;
  const ns = v.latDeg >= 0 ? 'N' : 'S';
  const ew = v.lonDeg >= 0 ? 'E' : 'W';
  const near = v.altitudeM < 60_000 || walk;
  let state = '';
  if (walk) state = v.flying ? '飛行中' : v.swimming ? '泳いでいる' : v.speed > 6 ? '走っている' : v.speed > 0.3 ? '歩いている' : '立ち止まっている';
  return (
    <div class="hud panel" aria-live="off">
      <div class="hud-main">
        {biome && <span class="swatch" style={{ background: biome.color }} />}
        <strong>{biome?.name ?? (v.groundM < 0 ? '海' : '—')}</strong>
        <span class="muted">
          {Math.abs(v.latDeg).toFixed(2)}°{ns} {Math.abs(v.lonDeg).toFixed(2)}°{ew}
        </span>
      </div>
      <div class="hud-stats">
        <span title="視点の海面からの高さ">{walk ? state : `高度 ${formatAltitude(v.altitudeM)}`}</span>
        <span title="足もとの標高">{v.groundM >= 0 ? `標高 ${Math.round(v.groundM).toLocaleString('ja-JP')} m` : `水深 ${Math.round(-v.groundM).toLocaleString('ja-JP')} m`}</span>
        {Number.isFinite(v.tempC) && <span title="年平均気温（その高さで）">{v.tempC.toFixed(1)}℃</span>}
        {near && v.animals > 0 && <span title="周囲にいる動物（クリックで図鑑）">動物 {v.animals}</span>}
      </div>
      <div class="hud-row">
        {walk ? (
          <button class="primary" onClick={() => controller.ascend()}>上空へ</button>
        ) : (
          <button class="primary" onClick={() => controller.descend()} disabled={!controller.planet?.hasSurface} title="画面中央の地点に降り立つ（Enter でも可）">
            降り立つ
          </button>
        )}
        {!walk && v.altitudeM < 1_000_000 && <button onClick={() => controller.ascend()}>全体を見る</button>}
        <label class="tod" title="現地の時刻（太陽の位置）">
          <span>{formatClock(v.tod)}</span>
          <input type="range" min={0} max={24} step={0.25} value={v.tod} onInput={(e) => controller.setTimeOfDay(Number((e.target as HTMLInputElement).value))} />
        </label>
        <label class="flows" title="歩いている間、時刻が進む">
          <input type="checkbox" checked={ui.timeFlows.value} onChange={(e) => controller.setTimeFlows((e.target as HTMLInputElement).checked)} />
          時刻が進む
        </label>
      </div>
    </div>
  );
}

function Help() {
  const v = ui.view.value;
  if (!v || ui.status.value !== 'ready') return null;
  if (v.mode === 'walk') {
    return (
      <div class="help panel">
        <kbd>W A S D</kbd> 移動 ・ <kbd>Shift</kbd> 走る ・ <kbd>Space</kbd> ジャンプ ・ <kbd>F</kbd> 飛行{v.flying ? <>（<kbd>Space</kbd>/<kbd>C</kbd> 上下）</> : null} ・ ドラッグで見回す ・ 動物をクリックで図鑑 ・ <kbd>Esc</kbd> 上空へ
      </div>
    );
  }
  return (
    <div class="help panel">
      ドラッグで移動 ・ 右ドラッグで回転と傾き ・ ホイールで拡大 ・ クリックで地点・町・動物の詳細{v.altitudeM < 20_000 ? <> ・ <kbd>Enter</kbd> で降り立つ</> : null}
    </div>
  );
}

function Legend() {
  void ui.paintVersion.value;
  const w = ui.world.value;
  if (!w) return null;
  const layer = layerById(ui.layer.value);
  if (layer.fields.some((f) => !controller.fields[f])) return null;
  const { gradient, stops } = layer.legend(w, controller.fields, ui.seaLevel.value, { range: null, towns: ui.towns.value });
  return (
    <div class="legend">
      <div class="legend-title">{layer.name}</div>
      {gradient ? (
        <>
          <div class="legend-bar" style={{ background: gradient }} />
          <div class="legend-labels">{stops.map((s) => <span key={s.label}>{s.label}</span>)}</div>
        </>
      ) : (
        <ul class="legend-items">
          {stops.map((s) => (
            <li key={s.label}>
              {s.color !== 'transparent' && <span class="swatch" style={{ background: s.color }} />}
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
