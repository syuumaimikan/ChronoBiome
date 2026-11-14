/**
 * Safe expression language for rule packs.
 *
 * Rule packs are user data, so expressions are parsed into an AST and compiled
 * into plain closures — never `eval`/`new Function`. Variables are resolved to
 * fixed slots of a Float64Array at compile time, so evaluating an expression in
 * a hot loop allocates nothing.
 *
 * Grammar (lowest to highest precedence):
 *   cond   := or ('?' cond ':' cond)?
 *   or     := and ('||' and)*
 *   and    := eq ('&&' eq)*
 *   eq     := cmp (('==' | '!=') cmp)*
 *   cmp    := add (('<' | '<=' | '>' | '>=') add)*
 *   add    := mul (('+' | '-') mul)*
 *   mul    := unary (('*' | '/' | '%') unary)*
 *   unary  := ('-' | '+' | '!') unary | pow
 *   pow    := primary ('^' unary)?          (right associative)
 *   primary:= number | name | name '(' args ')' | '(' cond ')'
 * Booleans are numbers: true = 1, false = 0.
 */

export type ExprNode =
  | { type: 'num'; value: number }
  | { type: 'var'; name: string; pos: number }
  | { type: 'unary'; op: '-' | '!'; arg: ExprNode }
  | { type: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { type: 'call'; name: string; args: ExprNode[]; pos: number }
  | { type: 'cond'; test: ExprNode; then: ExprNode; else: ExprNode };

type BinaryOp = '+' | '-' | '*' | '/' | '%' | '^' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||';

export class ExprError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`${message} (位置 ${pos})`);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, true: 1, false: 0 };

type Fn = { min: number; max: number; impl: (a: number[]) => number };

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-12)));
  return t * t * (3 - 2 * t);
};

export const FUNCTIONS: Record<string, Fn> = {
  min: { min: 1, max: Infinity, impl: (a) => Math.min(...a) },
  max: { min: 1, max: Infinity, impl: (a) => Math.max(...a) },
  clamp: { min: 3, max: 3, impl: (a) => Math.min(a[2], Math.max(a[1], a[0])) },
  lerp: { min: 3, max: 3, impl: (a) => a[0] + (a[1] - a[0]) * a[2] },
  smoothstep: { min: 3, max: 3, impl: (a) => smoothstep(a[0], a[1], a[2]) },
  step: { min: 2, max: 2, impl: (a) => (a[1] >= a[0] ? 1 : 0) },
  abs: { min: 1, max: 1, impl: (a) => Math.abs(a[0]) },
  sqrt: { min: 1, max: 1, impl: (a) => Math.sqrt(a[0]) },
  exp: { min: 1, max: 1, impl: (a) => Math.exp(a[0]) },
  log: { min: 1, max: 1, impl: (a) => Math.log(a[0]) },
  pow: { min: 2, max: 2, impl: (a) => Math.pow(a[0], a[1]) },
  floor: { min: 1, max: 1, impl: (a) => Math.floor(a[0]) },
  ceil: { min: 1, max: 1, impl: (a) => Math.ceil(a[0]) },
  round: { min: 1, max: 1, impl: (a) => Math.round(a[0]) },
  sign: { min: 1, max: 1, impl: (a) => Math.sign(a[0]) },
  sin: { min: 1, max: 1, impl: (a) => Math.sin(a[0]) },
  cos: { min: 1, max: 1, impl: (a) => Math.cos(a[0]) },
};

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'name'; value: string; pos: number }
  | { kind: 'op'; value: string; pos: number }
  | { kind: 'eof'; pos: number };

const OPS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '<', '>', '!', '(', ')', ',', '?', ':'];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError('数値の書式が不正です', i);
      out.push({ kind: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!;
      out.push({ kind: 'name', value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`使えない文字 '${c}'`, i);
    out.push({ kind: 'op', value: op, pos: i });
    i += op.length;
  }
  out.push({ kind: 'eof', pos: src.length });
  return out;
}

// ------------------------------------------------------------------- parser

export function parseExpr(src: string): ExprNode {
  if (src.length > 4000) throw new ExprError('式が長すぎます', 0);
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => {
    const t = toks[p];
    return t.kind === 'op' && t.value === v;
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExprError(`'${v}' が必要です`, peek().pos);
    p++;
  };
  const enter = () => {
    if (++depth > 64) throw new ExprError('入れ子が深すぎます', peek().pos);
  };

  const binaryLevel = (ops: string[], next: () => ExprNode) => (): ExprNode => {
    let left = next();
    for (;;) {
      const t = peek();
      if (t.kind === 'op' && ops.includes(t.value)) {
        p++;
        left = { type: 'binary', op: t.value as BinaryOp, left, right: next() };
      } else return left;
    }
  };

  const cond = (): ExprNode => {
    enter();
    const test = or();
    let node = test;
    if (isOp('?')) {
      p++;
      const a = cond();
      expectOp(':');
      const b = cond();
      node = { type: 'cond', test, then: a, else: b };
    }
    depth--;
    return node;
  };

  const unary = (): ExprNode => {
    const t = peek();
    if (t.kind === 'op' && (t.value === '-' || t.value === '+' || t.value === '!')) {
      p++;
      enter();
      const arg = unary();
      depth--;
      if (t.value === '+') return arg;
      return { type: 'unary', op: t.value, arg };
    }
    return pow();
  };

  const pow = (): ExprNode => {
    const base = primary();
    if (isOp('^')) {
      p++;
      return { type: 'binary', op: '^', left: base, right: unary() };
    }
    return base;
  };

  const primary = (): ExprNode => {
    const t = peek();
    if (t.kind === 'num') {
      p++;
      return { type: 'num', value: t.value };
    }
    if (t.kind === 'name') {
      p++;
      if (isOp('(')) {
        p++;
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new ExprError(`未知の関数 '${t.value}'`, t.pos);
        const args: ExprNode[] = [];
        if (!isOp(')')) {
          for (;;) {
            args.push(cond());
            if (isOp(',')) { p++; continue; }
            break;
          }
        }
        expectOp(')');
        if (args.length < fn.min || args.length > fn.max) {
          throw new ExprError(`関数 '${t.value}' の引数の数が不正です (${args.length})`, t.pos);
        }
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      if (t.value in CONSTANTS) return { type: 'num', value: CONSTANTS[t.value] };
      return { type: 'var', name: t.value, pos: t.pos };
    }
    if (t.kind === 'op' && t.value === '(') {
      p++;
      const e = cond();
      expectOp(')');
      return e;
    }
    throw new ExprError(t.kind === 'eof' ? '式が途中で終わっています' : `予期しない '${t.value}'`, t.pos);
  };

  const mul = binaryLevel(['*', '/', '%'], unary);
  const add = binaryLevel(['+', '-'], mul);
  const cmp = binaryLevel(['<', '<=', '>', '>='], add);
  const eq = binaryLevel(['==', '!='], cmp);
  const and = binaryLevel(['&&'], eq);
  const or = binaryLevel(['||'], and);

  const ast = cond();
  if (peek().kind !== 'eof') throw new ExprError(`余分な記述 '${(peek() as { value?: string }).value ?? ''}'`, peek().pos);
  return ast;
}

/** Names of all variables referenced by an expression. */
export function collectVariables(node: ExprNode, out = new Set<string>()): Set<string> {
  switch (node.type) {
    case 'var': out.add(node.name); break;
    case 'unary': collectVariables(node.arg, out); break;
    case 'binary': collectVariables(node.left, out); collectVariables(node.right, out); break;
    case 'call': for (const a of node.args) collectVariables(a, out); break;
    case 'cond': collectVariables(node.test, out); collectVariables(node.then, out); collectVariables(node.else, out); break;
  }
  return out;
}

// ----------------------------------------------------------------- compiler

/** Maps variable names to slots in a Float64Array environment. */
export class ExprScope {
  private readonly slots = new Map<string, number>();
  constructor(readonly names: readonly string[]) {
    names.forEach((n, i) => this.slots.set(n, i));
  }
  has(name: string): boolean {
    return this.slots.has(name);
  }
  slot(name: string): number {
    const s = this.slots.get(name);
    if (s === undefined) throw new Error(`unknown variable ${name}`);
    return s;
  }
  createEnv(): Float64Array {
    return new Float64Array(this.names.length);
  }
}

export type Evaluator = (env: Float64Array) => number;

export interface CompiledExpr {
  readonly source: string;
  readonly eval: Evaluator;
  readonly variables: readonly string[];
}

const b = (v: boolean) => (v ? 1 : 0);

function compileNode(node: ExprNode, scope: ExprScope): Evaluator {
  switch (node.type) {
    case 'num': {
      const v = node.value;
      return () => v;
    }
    case 'var': {
      if (!scope.has(node.name)) throw new ExprError(`未知の変数 '${node.name}'`, node.pos);
      const s = scope.slot(node.name);
      return (env) => env[s];
    }
    case 'unary': {
      const a = compileNode(node.arg, scope);
      return node.op === '-' ? (env) => -a(env) : (env) => b(a(env) === 0);
    }
    case 'cond': {
      const t = compileNode(node.test, scope);
      const x = compileNode(node.then, scope);
      const y = compileNode(node.else, scope);
      return (env) => (t(env) !== 0 ? x(env) : y(env));
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      const args = node.args.map((a) => compileNode(a, scope));
      // Specialise the common fixed-arity cases to avoid array allocation.
      if (args.length === 1) {
        const [a0] = args;
        switch (node.name) {
          case 'abs': return (env) => Math.abs(a0(env));
          case 'sqrt': return (env) => Math.sqrt(a0(env));
          case 'exp': return (env) => Math.exp(a0(env));
          case 'log': return (env) => Math.log(a0(env));
          case 'floor': return (env) => Math.floor(a0(env));
          case 'ceil': return (env) => Math.ceil(a0(env));
          case 'round': return (env) => Math.round(a0(env));
          case 'sign': return (env) => Math.sign(a0(env));
          case 'sin': return (env) => Math.sin(a0(env));
          case 'cos': return (env) => Math.cos(a0(env));
          case 'min': case 'max': return a0;
        }
      }
      if (args.length === 2) {
        const [a0, a1] = args;
        switch (node.name) {
          case 'min': return (env) => Math.min(a0(env), a1(env));
          case 'max': return (env) => Math.max(a0(env), a1(env));
          case 'pow': return (env) => Math.pow(a0(env), a1(env));
          case 'step': return (env) => b(a1(env) >= a0(env));
        }
      }
      if (args.length === 3) {
        const [a0, a1, a2] = args;
        switch (node.name) {
          case 'clamp': return (env) => Math.min(a2(env), Math.max(a1(env), a0(env)));
          case 'lerp': return (env) => { const x = a0(env); return x + (a1(env) - x) * a2(env); };
          case 'smoothstep': return (env) => smoothstep(a0(env), a1(env), a2(env));
        }
      }
      const buf = new Array<number>(args.length);
      return (env) => {
        for (let i = 0; i < args.length; i++) buf[i] = args[i](env);
        return fn.impl(buf);
      };
    }
    case 'binary': {
      const l = compileNode(node.left, scope);
      const r = compileNode(node.right, scope);
      switch (node.op) {
        case '+': return (env) => l(env) + r(env);
        case '-': return (env) => l(env) - r(env);
        case '*': return (env) => l(env) * r(env);
        case '/': return (env) => l(env) / r(env);
        case '%': return (env) => l(env) % r(env);
        case '^': return (env) => Math.pow(l(env), r(env));
        case '<': return (env) => b(l(env) < r(env));
        case '<=': return (env) => b(l(env) <= r(env));
        case '>': return (env) => b(l(env) > r(env));
        case '>=': return (env) => b(l(env) >= r(env));
        case '==': return (env) => b(l(env) === r(env));
        case '!=': return (env) => b(l(env) !== r(env));
        case '&&': return (env) => (l(env) !== 0 && r(env) !== 0 ? 1 : 0);
        case '||': return (env) => (l(env) !== 0 || r(env) !== 0 ? 1 : 0);
      }
    }
  }
}

/** Fold sub-trees that reference no variables into constants. */
function fold(node: ExprNode): ExprNode {
  switch (node.type) {
    case 'num':
    case 'var':
      return node;
    case 'unary': {
      const arg = fold(node.arg);
      const n: ExprNode = { ...node, arg };
      return arg.type === 'num' ? constant(n) : n;
    }
    case 'binary': {
      const left = fold(node.left);
      const right = fold(node.right);
      const n: ExprNode = { ...node, left, right };
      return left.type === 'num' && right.type === 'num' ? constant(n) : n;
    }
    case 'call': {
      const args = node.args.map(fold);
      const n: ExprNode = { ...node, args };
      return args.every((a) => a.type === 'num') ? constant(n) : n;
    }
    case 'cond': {
      const test = fold(node.test);
      const then = fold(node.then);
      const els = fold(node.else);
      if (test.type === 'num') return test.value !== 0 ? then : els;
      return { type: 'cond', test, then, else: els };
    }
  }
}

const EMPTY_SCOPE = new ExprScope([]);
const EMPTY_ENV = new Float64Array(0);
function constant(node: ExprNode): ExprNode {
  return { type: 'num', value: compileNode(node, EMPTY_SCOPE)(EMPTY_ENV) };
}

/** Parse, validate against the scope, constant-fold and compile. Throws ExprError. */
export function compileExpr(source: string, scope: ExprScope): CompiledExpr {
  const ast = fold(parseExpr(source));
  const variables = [...collectVariables(ast)];
  return { source, eval: compileNode(ast, scope), variables };
}

/** Validate without keeping the result. Returns an error message or null. */
export function checkExpr(source: string, allowed: readonly string[]): string | null {
  try {
    const ast = parseExpr(source);
    for (const v of collectVariables(ast)) {
      if (!allowed.includes(v)) return `未知の変数 '${v}'（使えるのは: ${allowed.join(', ')}）`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
