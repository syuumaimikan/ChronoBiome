import { useEffect, useState } from 'preact/hooks';
import { BIOME_VARIABLES, parseRulePackText } from '../core/rules/schema';
import { earthLikePack } from '../core/rules/packs/earthLike';
import { FUNCTIONS } from '../core/rules/expr';
import { controller, ui } from './controller';

export function RulesPage() {
  const [checked, setChecked] = useState<{ ok: boolean; errors: string[] }>({ ok: true, errors: [] });

  // Validate as the user types (debounced).
  useEffect(() => {
    const id = setTimeout(() => {
      const r = parseRulePackText(ui.packText.value);
      setChecked(r.ok ? { ok: true, errors: [] } : { ok: false, errors: r.errors });
    }, 250);
    return () => clearTimeout(id);
  }, [ui.packText.value]);

  return (
    <div class="rules">
      <div class="rules-editor">
        <div class="rules-toolbar">
          <h2>ルールパック（JSON）</h2>
          <span class={checked.ok ? 'badge ok' : 'badge bad'}>{checked.ok ? '有効' : `${checked.errors.length} 件のエラー`}</span>
          <span class="spacer" />
          <button onClick={() => (ui.packText.value = JSON.stringify(earthLikePack, null, 2))}>既定（Earth-like）に戻す</button>
          <button
            class="primary"
            disabled={!checked.ok}
            onClick={() => {
              ui.tab.value = 'observe';
              void controller.generate();
            }}
          >
            このルールで生成
          </button>
        </div>
        <textarea
          spellcheck={false}
          value={ui.packText.value}
          onInput={(e) => (ui.packText.value = (e.target as HTMLTextAreaElement).value)}
          aria-label="ルールパック JSON"
        />
      </div>
      <aside class="rules-help">
        {!checked.ok && (
          <section class="errors">
            <h3>エラー</h3>
            <ul>{checked.errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </section>
        )}
        <section>
          <h3>バイオームの条件式</h3>
          <p>
            <code>biomes</code> は上から順に評価され、最初に <code>when</code> が真になったものが採用されます。
          </p>
          <p>使える変数</p>
          <ul class="chips">{BIOME_VARIABLES.map((v) => <li key={v}><code>{v}</code></li>)}</ul>
          <p>演算子</p>
          <p><code>+ - * / % ^</code> <code>{'< <= > >= == !='}</code> <code>{'&& || !'}</code> <code>条件 ? a : b</code></p>
          <p>関数</p>
          <ul class="chips">{Object.keys(FUNCTIONS).map((f) => <li key={f}><code>{f}()</code></li>)}</ul>
        </section>
        <section>
          <h3>主な項目</h3>
          <dl>
            <dt><code>world.gridLevel</code></dt>
            <dd>格子の細かさ。6 で約 4.1 万セル、7 で約 16 万セル</dd>
            <dt><code>terrain.plateCount</code></dt>
            <dd>プレートの枚数</dd>
            <dt><code>terrain.oceanFraction</code></dt>
            <dd>海の面積の割合</dd>
            <dt><code>climate.axialTiltDeg</code></dt>
            <dd>自転軸の傾き。季節の強さが変わります</dd>
            <dt><code>climate.lapseRateCPerKm</code></dt>
            <dd>標高 1 km あたりの気温低下</dd>
          </dl>
        </section>
      </aside>
    </div>
  );
}
