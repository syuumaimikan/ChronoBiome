import { describe, expect, it } from 'vitest';
import { checkExpr, compileExpr, ExprError, ExprScope, parseExpr } from '../src/core/rules/expr';
import { earthLikePack } from '../src/core/rules/packs/earthLike';
import { parseRulePack, parseRulePackText } from '../src/core/rules/schema';

const scope = new ExprScope(['temp', 'moisture', 'x']);
const run = (src: string, vals: Partial<Record<'temp' | 'moisture' | 'x', number>> = {}) => {
  const env = scope.createEnv();
  for (const [k, v] of Object.entries(vals)) env[scope.slot(k)] = v!;
  return compileExpr(src, scope).eval(env);
};

describe('expression language', () => {
  it('respects precedence and associativity', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('2 ^ 3 ^ 2')).toBe(512);
    expect(run('-2 ^ 2')).toBe(-4);
    expect(run('10 - 4 - 3')).toBe(3);
    expect(run('7 % 4')).toBe(3);
  });

  it('evaluates comparisons, logic and conditionals as numbers', () => {
    expect(run('temp > 20 && moisture > 0.5', { temp: 25, moisture: 0.7 })).toBe(1);
    expect(run('temp > 20 && moisture > 0.5', { temp: 25, moisture: 0.1 })).toBe(0);
    expect(run('!(temp < 0) || x', { temp: -5, x: 0 })).toBe(0);
    expect(run('temp < 0 ? -1 : temp == 0 ? 0 : 1', { temp: 3 })).toBe(1);
    expect(run('true + false + pi > 4')).toBe(1);
    expect(run('true + false + pi > 5')).toBe(0);
  });

  it('supports the built-in functions', () => {
    expect(run('clamp(x, 0, 1)', { x: 5 })).toBe(1);
    expect(run('lerp(10, 20, 0.25)')).toBe(12.5);
    expect(run('min(3, x, 2)', { x: 1 })).toBe(1);
    expect(run('max(x)', { x: 9 })).toBe(9);
    expect(run('smoothstep(0, 1, 0.5)')).toBe(0.5);
    expect(run('step(0.5, x)', { x: 0.6 })).toBe(1);
    expect(run('sqrt(16) + abs(-2) + floor(2.7)')).toBe(8);
  });

  it('constant-folds pure sub-expressions', () => {
    const c = compileExpr('2 * 3 + temp', scope);
    expect(c.variables).toEqual(['temp']);
  });

  it('rejects malformed input with a position', () => {
    for (const bad of ['1 +', '(1 + 2', 'foo(1)', 'clamp(1, 2)', '1 2', '1 $ 2', 'a ? 1']) {
      expect(() => parseExpr(bad), bad).toThrow(ExprError);
    }
    expect(() => compileExpr('nope + 1', scope)).toThrow(/未知の変数/);
    expect(() => parseExpr('('.repeat(100) + '1' + ')'.repeat(100))).toThrow(/入れ子/);
  });

  it('checkExpr reports unknown variables against an allow-list', () => {
    expect(checkExpr('temp > 1', ['temp'])).toBeNull();
    expect(checkExpr('tmp > 1', ['temp'])).toMatch(/tmp/);
  });
});

describe('rule pack schema', () => {
  it('accepts the Earth-like pack and fills defaults', () => {
    const r = parseRulePack(earthLikePack);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pack.biomes.length).toBeGreaterThan(5);
      expect(r.pack.world.gridLevel).toBe(6);
    }
  });

  it('fills defaults for omitted fields', () => {
    const r = parseRulePack({
      schemaVersion: 1,
      meta: { name: 'min' },
      world: {},
      terrain: {},
      climate: {},
      biomes: [{ id: 'all', name: '全部', color: '#00ff00', when: '1' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pack.terrain.plateCount).toBe(14);
  });

  it('reports bad expressions, duplicate ids, typos and bad JSON with paths', () => {
    const broken = structuredClone(earthLikePack) as Record<string, unknown> & { biomes: { when: string; id: string }[] };
    broken.biomes[0].when = 'temperature < 0';
    broken.biomes[2].id = broken.biomes[1].id;
    (broken as Record<string, unknown>).terain = {};
    const r = parseRulePack(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = r.errors.join('\n');
      expect(all).toMatch(/biomes\.0\.when.*temperature/);
      expect(all).toMatch(/重複/);
      expect(all).toMatch(/terain/);
    }
    const t = parseRulePackText('{ nope');
    expect(t.ok).toBe(false);
  });
});
