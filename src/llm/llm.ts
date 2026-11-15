import { openDB, type IDBPDatabase } from 'idb';

/**
 * Local LLM (milestone 11). The simulation never waits for it: the model only
 * interprets and writes — chronicle prose, myths, species field notes, spell
 * drafts from plain language, answers about the world. Everything works
 * without it (templates), and every answer is cached in IndexedDB so the same
 * question about the same world returns the same text.
 *
 * Providers: Ollama (http://localhost:11434, /api/chat) and any
 * OpenAI-compatible server (LM Studio, llama.cpp: /v1/chat/completions).
 * Browsers need the server to allow the page's origin (Ollama: set
 * OLLAMA_ORIGINS).
 */

export type ProviderKind = 'none' | 'ollama' | 'openai';

export interface LlmSettings {
  kind: ProviderKind;
  endpoint: string;
  model: string;
  temperature: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const KEY = 'chronobiome.llm';
export const DEFAULT_SETTINGS: LlmSettings = { kind: 'none', endpoint: 'http://localhost:11434', model: 'llama3.2', temperature: 0.7 };

export function loadSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // Storage may be unavailable (private windows): fall back to defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: LlmSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not persisted; the settings still apply for this session.
  }
}

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> | null {
  try {
    dbp ??= openDB('chronobiome-llm', 1, { upgrade: (d) => void d.createObjectStore('answers') });
    return dbp;
  } catch {
    return null;
  }
}

async function cacheGet(key: string): Promise<string | undefined> {
  try {
    const d = await db();
    return d ? ((await d.get('answers', key)) as string | undefined) : undefined;
  } catch {
    return undefined;
  }
}

async function cachePut(key: string, value: string): Promise<void> {
  try {
    const d = await db();
    await d?.put('answers', value, key);
  } catch {
    // Cache is optional.
  }
}

function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export class LlmError extends Error {}

/** One chat completion; cached by (model, messages). */
export async function chat(settings: LlmSettings, messages: ChatMessage[], opts: { json?: boolean; signal?: AbortSignal; noCache?: boolean } = {}): Promise<string> {
  if (settings.kind === 'none') throw new LlmError('LLM が設定されていません');
  const key = `${settings.kind}:${settings.model}:${opts.json ? 'j' : 't'}:${hashText(JSON.stringify(messages))}`;
  if (!opts.noCache) {
    const hit = await cacheGet(key);
    if (hit !== undefined) return hit;
  }
  const base = settings.endpoint.replace(/\/+$/, '');
  let text = '';
  try {
    if (settings.kind === 'ollama') {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.model, messages, stream: false, format: opts.json ? 'json' : undefined, options: { temperature: settings.temperature } }),
        signal: opts.signal,
      });
      if (!res.ok) throw new LlmError(`Ollama が ${res.status} を返しました`);
      const data = (await res.json()) as { message?: { content?: string } };
      text = data.message?.content ?? '';
    } else {
      const url = /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.model, messages, temperature: settings.temperature, response_format: opts.json ? { type: 'json_object' } : undefined }),
        signal: opts.signal,
      });
      if (!res.ok) throw new LlmError(`サーバーが ${res.status} を返しました`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      text = data.choices?.[0]?.message?.content ?? '';
    }
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if ((e as Error).name === 'AbortError') throw e;
    throw new LlmError(
      settings.kind === 'ollama'
        ? 'Ollama に接続できません。Ollama を起動し、環境変数 OLLAMA_ORIGINS にこのページのオリジン（例: http://localhost:5173）を設定して再起動してください。'
        : 'LLM サーバーに接続できません。サーバーが起動していて、CORS でこのページからの接続を許可しているか確認してください。',
    );
  }
  text = text.trim();
  if (text) await cachePut(key, text);
  return text;
}

/** List models the server offers (for the settings form). */
export async function listModels(settings: LlmSettings): Promise<string[]> {
  const base = settings.endpoint.replace(/\/+$/, '');
  try {
    if (settings.kind === 'ollama') {
      const res = await fetch(`${base}/api/tags`);
      const data = (await res.json()) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => m.name);
    }
    if (settings.kind === 'openai') {
      const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
      const res = await fetch(url);
      const data = (await res.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    }
  } catch {
    // Unreachable server: no list.
  }
  return [];
}

/** Parse a JSON answer, tolerating code fences and prose around it. */
export function parseJsonLoose<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

const SYSTEM = 'あなたは架空世界の歴史家・博物学者です。与えられたシミュレーションの事実だけを根拠に、日本語で簡潔に書きます。事実にない固有名詞や数値は作りません。';

export const tasks = {
  /** Retell recent chronicle entries as a short narrative. */
  narrate(facts: string[]): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `次の年代記の出来事を、歴史書の一節のような 3〜5 文の物語にしてください。\n\n${facts.map((f) => `- ${f}`).join('\n')}` },
    ];
  },
  /** A field-guide entry for a species. */
  fieldNote(facts: string): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `次の生物について、図鑑の解説文を 3 文で書いてください（姿・暮らし・人との関わり）。\n\n${facts}` },
    ];
  },
  /** A myth of a religion. */
  myth(facts: string): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `次の宗教の創世神話を、聖典の文体で 4 文ほど書いてください。\n\n${facts}` },
    ];
  },
  /** Answer a question about the world. */
  ask(question: string, context: string): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM + ' 分からないことは分からないと答えます。' },
      { role: 'user', content: `世界の状態:\n${context}\n\n質問: ${question}` },
    ];
  },
  /** Draft a spell graph from a plain-language wish. */
  spell(wish: string, elements: string[]): ChatMessage[] {
    return [
      {
        role: 'system',
        content:
          'あなたは魔法の設計者です。呪文は部品の配列（JSON）で表します。順番は source → element(1つ以上) → form → target → effect(1つ以上) → mod/cond(任意)。' +
          ' 部品: {"k":"source","what":"ambient|crystal|life|star"} / {"k":"element","el":"' + elements.join('|') + '"} / {"k":"form","shape":"touch|bolt|area|ward|enchant|ritual"} /' +
          ' {"k":"target","what":"cell|population|settlement|field"} / {"k":"effect","op":"raise|lower","field":"temperature|moisture|elevation|growth|health|defense|mana|density|price|morale","amount":0.1〜5} /' +
          ' {"k":"mod","m":"amplify|extend|range","x":0.1〜2} / {"k":"cond","when":"always|fullmoon|newmoon|eclipse|conjunction"}。' +
          ' {"name":"呪文名","nodes":[...]} の JSON だけを返します。',
      },
      { role: 'user', content: wish },
    ];
  },
  /** Game-master narration for the World Cartridge. */
  gm(context: string, action: string): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM + ' あなたはこの世界を舞台にした TRPG のゲームマスターです。プレイヤーの行動の結果を 2〜4 文で描写し、最後に次の選択肢を 2〜3 個示します。' },
      { role: 'user', content: `舞台:\n${context}\n\nプレイヤーの行動: ${action}` },
    ];
  },
};
