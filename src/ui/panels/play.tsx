import { useState } from 'preact/hooks';
import { SCENARIOS, type ScenarioKind } from '../../core/play/scenarios';
import { ERAS } from '../../core/systems/society/data';
import { buildCartridge, mapCanvas } from '../../export/files';
import { chat, DEFAULT_SETTINGS, listModels, type LlmSettings, type ProviderKind } from '../../llm/llm';
import { controller, toast, ui } from '../controller';
import { download, fmtNum, Section, Sparkline, years } from '../widgets';

// ------------------------------------------------------------ play

const ROLES = [
  { id: 'merchant', name: '商人', text: '元手が多く、町から町へ品物を運んで稼ぐ' },
  { id: 'explorer', name: '開拓者', text: '遺跡を掘り、新しい生き物を図鑑に記録する' },
  { id: 'general', name: '兵士', text: '国の戦いに身を置く' },
  { id: 'mage', name: '魔術師', text: '呪文の腕が立つ（魔法のある世界のみ）', magic: true },
] as const;

export function PlayPanel() {
  const p = ui.player.value;
  const w = ui.world.value;
  const s = ui.summary.value;
  const started = !!s?.civ.started;
  const home = p ? ui.towns.value.find((t) => t.name === p.settlement) : undefined;
  return (
    <>
      {p?.alive ? (
        <>
          <div class="card-head">
            <div class="grow">
              <strong>{p.name}</strong>
              <div class="muted">{p.role} ・ {p.age.toFixed(0)} 歳（寿命 およそ {p.lifespan.toFixed(0)} 歳）</div>
            </div>
          </div>
          <dl class="kv">
            <dt>暮らす町</dt>
            <dd>
              {home ? <button class="link" onClick={() => controller.showTown(home.id)}>{p.settlement}</button> : p.settlement}
            </dd>
            <dt>所持金</dt>
            <dd>{fmtNum(p.wealth)}</dd>
            <dt>持ち物</dt>
            <dd>{p.inventory.length ? p.inventory.join('、') : '—'}</dd>
            <dt>出生図</dt>
            <dd class="small">{p.chart}</dd>
            <dt>図鑑</dt>
            <dd>{p.observed} 種を記録</dd>
          </dl>
          <div class="btn-row">
            {home && <button onClick={() => controller.focus(home.cell)}>町へ飛ぶ</button>}
            <button disabled={ui.selected.value < 0} onClick={() => controller.act({ kind: 'excavate', cell: ui.selected.value })}>選んだ地点を発掘</button>
          </div>
          <p class="muted small">町の画面で売買・建物の寄進・移住ができます。地表に降りて動物をクリックすると図鑑に記録されます。時間を進めると歳をとり、寿命が来ると次の人生を選べます。</p>
          {p.deeds.length > 0 && (
            <Section title="この人生の行い">
              <ul class="list compact">
                {p.deeds.slice(-12).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </Section>
          )}
        </>
      ) : (
        <Section title={p ? 'この人生は終わりました' : 'この世界に生まれる'}>
          {!started ? (
            <p class="muted">まだ町がありません。文明が生まれるまで時間を進めてください。それまでは神の視点で観察と介入ができます。</p>
          ) : (
            <>
              <p class="muted small">いまの時代のどこかの町に、一人の人間として生まれます。出生図と家の豊かさが初めの力と持ち物を決めます。</p>
              <div class="role-grid">
                {ROLES.filter((r) => !('magic' in r) || w?.magic).map((r) => (
                  <button key={r.id} class="role" onClick={() => controller.act({ kind: 'incarnate', role: r.id })}>
                    <strong>{r.name}</strong>
                    <span class="muted small">{r.text}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </Section>
      )}
      {p && p.quests.length > 0 && (
        <Section title="依頼">
          <ul class="list">
            {p.quests.map((q) => (
              <li key={q.id}>
                <div class="grow">
                  <strong>{q.title}</strong> <span class={q.status === '達成' ? 'good' : 'muted'}>{q.status}</span>
                  <div class="muted small">{q.text}</div>
                </div>
                <button onClick={() => controller.focus(q.cell)} title="その場所へ">⌖</button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {p && p.past.length > 0 && (
        <Section title="前世">
          <ul class="list compact">
            {p.past.map((x, i) => (
              <li key={i}>
                <span class="grow">{x.name}（{x.role}）</span>
                <span class="muted small">{x.deeds.slice(-2).join(' / ')}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------ lab

export function LabPanel() {
  const [count, setCount] = useState(4);
  const [ticks, setTicks] = useState(1200);
  const [scenario, setScenario] = useState<ScenarioKind | ''>('');
  const jobs = ui.lab.value;
  const running = jobs.some((j) => j.status === 'running' || j.status === 'queued');
  const base = hashSeed(ui.seed.value);
  const done = jobs.filter((j) => j.run);
  return (
    <>
      <Section title="いまの世界に起こす">
        <p class="muted small">直前の状態は自動で保存されるので、「世界」タブからいつでも戻れます。地点を選んでおくと、そこが中心になります。</p>
        <ul class="list">
          {SCENARIOS.map((s) => (
            <li key={s.id}>
              <div class="grow">
                <strong>{s.name}</strong>
                <div class="muted small">{s.text}</div>
              </div>
              <button onClick={() => controller.scenario(s.id)}>起こす</button>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="別の世界をまとめて走らせる">
        <p class="muted small">同じルールで種（シード）だけを変えた世界を裏で並行に計算し、生命と文明の歩みを比べます。災厄を選ぶと、各世界が産業時代に入った時点で起こします。</p>
        <div class="inline-form wrap">
          <label>
            世界の数 <input type="number" min={1} max={16} value={count} onInput={(e) => setCount(Number((e.target as HTMLInputElement).value))} />
          </label>
          <label>
            長さ
            <select value={ticks} onChange={(e) => setTicks(Number((e.target as HTMLSelectElement).value))}>
              <option value={400}>短い（生命の初期まで）</option>
              <option value={1200}>中くらい（動物の時代まで）</option>
              <option value={2400}>長い（文明の誕生まで）</option>
              <option value={3200}>とても長い（近代以降まで）</option>
            </select>
          </label>
          <label>
            災厄
            <select value={scenario} onChange={(e) => setScenario((e.target as HTMLSelectElement).value as ScenarioKind | '')}>
              <option value="">なし</option>
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <button
            class="primary"
            disabled={running}
            onClick={() => controller.runLab(Array.from({ length: Math.max(1, Math.min(16, count)) }, (_, i) => (base + i * 7919) >>> 0), ticks, scenario || undefined)}
          >
            {running ? '計算中…' : '実行'}
          </button>
        </div>
      </Section>
      {jobs.length > 0 && (
        <Section title="結果">
          <table class="tbl">
            <thead>
              <tr>
                <th>シード</th>
                <th>知性</th>
                <th>最初の都市</th>
                <th>到達</th>
                <th>最大人口</th>
                <th>大量絶滅</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.seed}>
                  <td>{j.seed}</td>
                  {j.run ? (
                    <>
                      <td>{j.run.firstSapience >= 0 ? years(j.run.firstSapience) : '—'}</td>
                      <td>{j.run.firstCity >= 0 ? years(j.run.firstCity) : '—'}</td>
                      <td>{j.run.finalEra >= 0 ? `${ERAS[j.run.finalEra]}時代` : '文明なし'}</td>
                      <td>{fmtNum(j.run.maxPop)}</td>
                      <td>{j.run.massExtinctions}</td>
                    </>
                  ) : (
                    <td colSpan={5} class="muted">{j.status === 'error' ? `失敗: ${j.error}` : j.status === 'running' ? '計算中…' : '待機中'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {done.map((j) => (
            <div key={j.seed} class="lab-row">
              <span class="muted small">#{j.seed}</span>
              <Sparkline values={j.run!.series.map((x) => x.species)} color="#7fd07f" height={26} label="種" />
              <Sparkline values={j.run!.series.map((x) => x.pop)} log color="#ffcf70" height={26} label="人口" />
            </div>
          ))}
          {done.length > 0 && (
            <button onClick={() => download('chronobiome-lab.json', JSON.stringify(jobs.map((j) => ({ seed: j.seed, ...j.run })), null, 1), 'application/json')}>結果を JSON で保存</button>
          )}
        </Section>
      )}
    </>
  );
}

function hashSeed(s: string): number {
  const n = Number(s);
  if (Number.isFinite(n) && s.trim() !== '') return n >>> 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ------------------------------------------------------------ export

export function ExportPanel() {
  const [busy, setBusy] = useState('');
  const seed = ui.seed.value.replace(/[^\w\-]+/g, '_') || 'world';
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(`書き出しに失敗しました: ${(e as Error).message}`, 8000);
    } finally {
      setBusy('');
    }
  };
  const items: { id: string; name: string; text: string; go: () => Promise<void> }[] = [
    {
      id: 'json',
      name: '世界データ（JSON）',
      text: '天体・気候・全生物種・国・町と物価・宗教・言語・技術・戦争・遺跡・遺物・人物・年代記。ゲームやツールに読み込める形式です。',
      go: async () => download(`chronobiome-${seed}.json`, await controller.exportWorld(), 'application/json'),
    },
    {
      id: 'bible',
      name: '世界設定資料（Markdown）',
      text: '天体、気候、生命の歴史、主な生き物、国家と都市、宗教、言語、技術、遺跡、人物、年代記を文章にまとめます。',
      go: async () => download(`chronobiome-${seed}.md`, await controller.worldBible(), 'text/markdown'),
    },
    {
      id: 'map',
      name: '地図（PNG）',
      text: 'いま表示している地図の層を正距円筒図法で書き出します（2048×1024）。',
      go: async () => {
        const { rgb, mesh } = controller.mapColors();
        if (!mesh) throw new Error('世界がまだありません');
        const cv = mapCanvas(rgb, mesh, 2048);
        const blob = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('PNG を作れませんでした'))), 'image/png'));
        download(`chronobiome-${seed}-${ui.layer.value}.png`, blob);
      },
    },
    {
      id: 'rules',
      name: 'ルールパック（JSON）',
      text: 'この世界を生んだルール。同じシードと組み合わせると同じ世界が再現されます。',
      go: async () => download(`rules-${seed}.json`, ui.packText.value, 'application/json'),
    },
    {
      id: 'cartridge',
      name: 'ワールド・カートリッジ（HTML 1 ファイル）',
      text: 'この世界を舞台に遊べるテキスト RPG。町から町への交易、旅の途中の生き物、遺跡の探索と守護者、図鑑、年表。ネットなしで単体で動き、ローカル LLM をつなぐとゲームマスターが語ります。',
      go: async () => {
        const { rgb, mesh } = controller.mapColors();
        const world = JSON.parse(await controller.exportWorld());
        const map = mesh ? mapCanvas(rgb, mesh, 1024).toDataURL('image/png') : null;
        const html = buildCartridge(world, mesh, map, ui.llm.value);
        download(`chronobiome-${seed}-cartridge.html`, html, 'text/html');
      },
    },
  ];
  return (
    <>
      <p class="muted small">いまの時点（{years(ui.time.value)}）の世界を書き出します。</p>
      <ul class="list export-list">
        {items.map((it) => (
          <li key={it.id}>
            <div class="grow">
              <strong>{it.name}</strong>
              <div class="muted small">{it.text}</div>
            </div>
            <button disabled={!!busy || ui.status.value !== 'ready'} onClick={() => run(it.id, it.go)}>
              {busy === it.id ? '作成中…' : '保存'}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------------ LLM

export function LlmPanel() {
  const s = ui.llm.value;
  const [models, setModels] = useState<string[]>([]);
  const [test, setTest] = useState('');
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState('');
  const set = (patch: Partial<LlmSettings>) => controller.setLlm({ ...s, ...patch });
  const setKind = (kind: ProviderKind) =>
    set({ kind, endpoint: kind === 'openai' ? 'http://localhost:1234/v1' : kind === 'ollama' ? DEFAULT_SETTINGS.endpoint : s.endpoint });
  return (
    <>
      <p class="muted small">
        ローカル LLM は世界を「解釈して書く」だけで、シミュレーションには入りません。なくても全機能が動き、つなぐと年代記の物語化、図鑑の解説、言葉からの呪文づくり、世界への質問、カートリッジのゲームマスターが使えます。
      </p>
      <Section title="接続">
        <div class="form-grid">
          <label>
            種類
            <select value={s.kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as ProviderKind)}>
              <option value="none">使わない</option>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI 互換（LM Studio・llama.cpp）</option>
            </select>
          </label>
          {s.kind !== 'none' && (
            <>
              <label>
                エンドポイント
                <input value={s.endpoint} onChange={(e) => set({ endpoint: (e.target as HTMLInputElement).value })} />
              </label>
              <label>
                モデル
                <input value={s.model} list="llm-models" onChange={(e) => set({ model: (e.target as HTMLInputElement).value })} />
                <datalist id="llm-models">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <label>
                温度 {s.temperature.toFixed(1)}
                <input type="range" min={0} max={1.5} step={0.1} value={s.temperature} onInput={(e) => set({ temperature: Number((e.target as HTMLInputElement).value) })} />
              </label>
            </>
          )}
        </div>
        {s.kind !== 'none' && (
          <div class="btn-row">
            <button onClick={async () => setModels(await listModels(s))}>モデル一覧を取得</button>
            <button
              onClick={async () => {
                setTest('接続中…');
                try {
                  const r = await chat(s, [{ role: 'user', content: '「接続できました」とだけ日本語で答えてください。' }], { noCache: true });
                  setTest(`成功: ${r.slice(0, 60)}`);
                } catch (e) {
                  setTest((e as Error).message);
                }
              }}
            >
              接続テスト
            </button>
          </div>
        )}
        {test && <p class="small">{test}</p>}
        {s.kind === 'ollama' && (
          <p class="muted small">
            ブラウザから Ollama を呼ぶには、環境変数 <code>OLLAMA_ORIGINS</code> にこのページのオリジン（{location.origin}）を入れて Ollama を再起動してください。
          </p>
        )}
      </Section>
      {s.kind !== 'none' && (
        <Section title="世界に質問する">
          <textarea rows={2} value={q} placeholder="例: いちばん大きな国はなぜ栄えたのか？" onInput={(e) => setQ((e.target as HTMLTextAreaElement).value)} />
          <button
            disabled={ui.llmBusy.value || !q.trim()}
            onClick={async () => {
              try {
                setAnswer(await controller.ask(q));
              } catch (e) {
                toast((e as Error).message, 8000);
              }
            }}
          >
            {ui.llmBusy.value ? '考え中…' : '質問する'}
          </button>
          {answer && <p class="prose">{answer}</p>}
        </Section>
      )}
    </>
  );
}
