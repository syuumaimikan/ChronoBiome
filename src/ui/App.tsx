import { ui } from './controller';
import { ObservePage } from './ObservePage';
import { RulesPage } from './RulesPage';

const TABS = [
  { id: 'observe', name: '観測' },
  { id: 'rules', name: 'ルール' },
] as const;

export function App() {
  return (
    <div class="app">
      <header class="topbar">
        <h1>
          ChronoBiome <span>ルールと生態系から世界を生成する</span>
        </h1>
        <nav role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={ui.tab.value === t.id} class={ui.tab.value === t.id ? 'on' : ''} onClick={() => (ui.tab.value = t.id)}>
              {t.name}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {/* The observe page stays mounted so the WebGL context survives tab switches. */}
        <div class="page" hidden={ui.tab.value !== 'observe'}>
          <ObservePage />
        </div>
        {ui.tab.value === 'rules' && (
          <div class="page">
            <RulesPage />
          </div>
        )}
      </main>
    </div>
  );
}
