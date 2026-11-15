import { useEffect, useState } from 'preact/hooks';
import { NODE_LABEL, type SpellNode } from '../../core/systems/magic/spell';
import { chat, parseJsonLoose, tasks } from '../../llm/llm';
import type { SpellPreview } from '../../worker/protocol';
import { controller, toast, ui } from '../controller';
import { Meter, Section } from '../widgets';

const DEFAULT_ELEMENTS = ['火', '水', '地', '風', '生命', '精神', '時空'];

const PRESETS: { name: string; nodes: SpellNode[] }[] = [
  {
    name: '恵みの雨',
    nodes: [
      { k: 'source', what: 'ambient' }, { k: 'element', el: '水' }, { k: 'form', shape: 'area' }, { k: 'target', what: 'cell' },
      { k: 'effect', op: 'raise', field: 'moisture', amount: 0.3 },
    ],
  },
  {
    name: '豊穣の祈り',
    nodes: [
      { k: 'source', what: 'life' }, { k: 'element', el: '生命' }, { k: 'form', shape: 'ritual' }, { k: 'target', what: 'settlement' },
      { k: 'effect', op: 'raise', field: 'growth', amount: 0.5 }, { k: 'cond', when: 'fullmoon' },
    ],
  },
  {
    name: '癒やしの結界',
    nodes: [
      { k: 'source', what: 'crystal' }, { k: 'element', el: '生命' }, { k: 'form', shape: 'ward' }, { k: 'target', what: 'settlement' },
      { k: 'effect', op: 'raise', field: 'health', amount: 0.4 },
    ],
  },
  {
    name: '大地隆起',
    nodes: [
      { k: 'source', what: 'star' }, { k: 'element', el: '地' }, { k: 'form', shape: 'ritual' }, { k: 'target', what: 'cell' },
      { k: 'effect', op: 'raise', field: 'elevation', amount: 3 }, { k: 'mod', m: 'amplify', x: 0.5 },
    ],
  },
];

function elementsOfPack(): string[] {
  try {
    const p = JSON.parse(ui.packText.value) as { magic?: { elements?: string[] } };
    return p.magic?.elements?.length ? p.magic.elements : DEFAULT_ELEMENTS;
  } catch {
    return DEFAULT_ELEMENTS;
  }
}

function describe(n: SpellNode): string {
  switch (n.k) {
    case 'source': return `源: ${NODE_LABEL.source[n.what]}`;
    case 'element': return `属性: ${n.el}`;
    case 'form': return `形: ${NODE_LABEL.form[n.shape]}`;
    case 'target': return `対象: ${NODE_LABEL.target[n.what]}`;
    case 'effect': return `作用: ${NODE_LABEL.field[n.field]}を${NODE_LABEL.op[n.op]}（${n.amount}）`;
    case 'mod': return `修飾: ${NODE_LABEL.mod[n.m]} ×${n.x}`;
    case 'cond': return `条件: ${NODE_LABEL.cond[n.when]}`;
    case 'sense': return `感知: ${NODE_LABEL.sense[n.what]}`;
    case 'act': return `行動: ${NODE_LABEL.act[n.what]}`;
  }
}

type Kind = 'source' | 'element' | 'form' | 'target' | 'effect' | 'mod' | 'cond';

export function SpellPanel() {
  const elements = elementsOfPack();
  const [nodes, setNodes] = useState<SpellNode[]>(PRESETS[0].nodes);
  const [plan, setPlan] = useState<SpellPreview | null>(null);
  const [wish, setWish] = useState('');
  const [kind, setKind] = useState<Kind>('effect');
  const [pick, setPick] = useState<string>('');
  const [field, setField] = useState<keyof typeof NODE_LABEL.field>('temperature');
  const [op, setOp] = useState<'raise' | 'lower'>('raise');
  const [amount, setAmount] = useState(0.5);

  useEffect(() => {
    let live = true;
    void controller.planSpell(nodes).then((p) => live && setPlan(p));
    return () => {
      live = false;
    };
  }, [JSON.stringify(nodes)]);

  const options: Record<Kind, [string, string][]> = {
    source: Object.entries(NODE_LABEL.source),
    element: elements.map((e) => [e, e]),
    form: Object.entries(NODE_LABEL.form),
    target: Object.entries(NODE_LABEL.target),
    effect: [],
    mod: Object.entries(NODE_LABEL.mod),
    cond: Object.entries(NODE_LABEL.cond).filter(([k]) => k !== 'threshold'),
  };

  const add = () => {
    const v = pick || options[kind][0]?.[0];
    let n: SpellNode;
    if (kind === 'source') n = { k: 'source', what: v as never };
    else if (kind === 'element') n = { k: 'element', el: v };
    else if (kind === 'form') n = { k: 'form', shape: v as never };
    else if (kind === 'target') n = { k: 'target', what: v as never };
    else if (kind === 'effect') n = { k: 'effect', op, field, amount };
    else if (kind === 'mod') n = { k: 'mod', m: v as never, x: amount };
    else n = { k: 'cond', when: v as never };
    setNodes([...nodes, n]);
  };

  const fromWish = async () => {
    if (!wish.trim()) return;
    ui.llmBusy.value = true;
    try {
      const text = await chat(ui.llm.value, tasks.spell(wish, elements), { json: true });
      const r = parseJsonLoose<{ name?: string; nodes?: SpellNode[] }>(text);
      if (!r?.nodes?.length) throw new Error('呪文の形になりませんでした。言い方を変えてみてください。');
      setNodes(r.nodes);
      toast(`「${r.name ?? '無名の呪文'}」の案を作りました。`);
    } catch (e) {
      toast((e as Error).message, 8000);
    } finally {
      ui.llmBusy.value = false;
    }
  };

  const cell = ui.selected.value;
  return (
    <>
      <p class="muted small">
        呪文は部品をつないだ流れです：源 → 属性 → 形 → 対象 → 作用（修飾・条件は自由）。必要なマナは作用の大きさ・範囲・持続・土地との相性から自動で決まり、複雑な呪文ほど暴発しやすくなります。
      </p>
      <Section title="ひな形">
        <div class="chips-row">
          {PRESETS.map((p) => (
            <button key={p.name} onClick={() => setNodes(p.nodes)}>{p.name}</button>
          ))}
          <button onClick={() => setNodes([])}>空にする</button>
        </div>
      </Section>
      <Section title="呪文の部品">
        {nodes.length === 0 ? (
          <p class="muted">部品がありません。</p>
        ) : (
          <ol class="spell-nodes">
            {nodes.map((n, i) => (
              <li key={i} class={`n-${n.k}`}>
                <span class="grow">{describe(n)}</span>
                <button class="link" disabled={i === 0} onClick={() => setNodes(swap(nodes, i, i - 1))} aria-label="上へ">↑</button>
                <button class="link" disabled={i === nodes.length - 1} onClick={() => setNodes(swap(nodes, i, i + 1))} aria-label="下へ">↓</button>
                <button class="link" onClick={() => setNodes(nodes.filter((_, j) => j !== i))} aria-label="外す">×</button>
              </li>
            ))}
          </ol>
        )}
        <div class="inline-form wrap">
          <select value={kind} onChange={(e) => { setKind((e.target as HTMLSelectElement).value as Kind); setPick(''); }} aria-label="部品の種類">
            <option value="source">源</option>
            <option value="element">属性</option>
            <option value="form">形</option>
            <option value="target">対象</option>
            <option value="effect">作用</option>
            <option value="mod">修飾</option>
            <option value="cond">条件</option>
          </select>
          {kind === 'effect' ? (
            <>
              <select value={field} onChange={(e) => setField((e.target as HTMLSelectElement).value as never)} aria-label="作用する量">
                {Object.entries(NODE_LABEL.field).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <select value={op} onChange={(e) => setOp((e.target as HTMLSelectElement).value as never)} aria-label="向き">
                <option value="raise">上げる</option>
                <option value="lower">下げる</option>
              </select>
            </>
          ) : (
            <select value={pick || options[kind][0]?.[0]} onChange={(e) => setPick((e.target as HTMLSelectElement).value)} aria-label="部品">
              {options[kind].map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          )}
          {(kind === 'effect' || kind === 'mod') && (
            <input type="number" step="0.1" min="0.1" max="5" value={amount} onInput={(e) => setAmount(Number((e.target as HTMLInputElement).value))} aria-label="強さ" />
          )}
          <button onClick={add}>加える</button>
        </div>
      </Section>
      <Section title="見積もり">
        {!plan ? (
          <p class="muted">計算中…</p>
        ) : plan.ok ? (
          <>
            <p>{plan.summary}</p>
            <dl class="kv">
              <dt>必要マナ</dt>
              <dd>{plan.cost.toFixed(1)}</dd>
              <dt>安定性</dt>
              <dd><Meter value={plan.stability} color={plan.stability > 0.7 ? '#8fd18f' : plan.stability > 0.4 ? '#e8c060' : '#e06060'} /> 暴発率 {((1 - plan.stability) * 100).toFixed(0)}%</dd>
              <dt>範囲と持続</dt>
              <dd>半径 {plan.radius} セル ・ {plan.years < 1 ? `${Math.round(plan.years * 365)} 日` : `${plan.years.toFixed(0)} 年`}</dd>
            </dl>
          </>
        ) : (
          <ul class="errors">
            {plan.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div class="btn-row">
          <button class="primary" disabled={!plan?.ok || cell < 0} onClick={() => controller.act({ kind: 'cast', nodes, cell })}>
            {cell < 0 ? '地点を選ぶと唱えられます' : '選んだ地点で唱える'}
          </button>
          <button onClick={() => controller.setLayer('mana')}>マナの地図</button>
        </div>
      </Section>
      {ui.llm.value.kind !== 'none' && (
        <Section title="言葉から呪文を作る（AI）">
          <textarea rows={2} value={wish} placeholder="例: 干ばつの村に三年間だけ雨を降らせたい" onInput={(e) => setWish((e.target as HTMLTextAreaElement).value)} />
          <button onClick={fromWish} disabled={ui.llmBusy.value}>{ui.llmBusy.value ? '考え中…' : '案を作る'}</button>
        </Section>
      )}
    </>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const b = a.slice();
  [b[i], b[j]] = [b[j], b[i]];
  return b;
}
