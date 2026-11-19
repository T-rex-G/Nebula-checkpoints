/*
 * Uranus for Go, Java and PHP: the text read as tokens, and the shapes in
 * it -- brackets and their partners, calls and their arguments, functions,
 * their parameters and decorations. What the walk in uranus-cfamily.ts and
 * its route reader stand on; nothing here follows a value.
 */
export type Language = 'go' | 'java' | 'php';
export type CTokenKind = 'id' | 'str' | 'num' | 'punc' | 'shell';
/* One token of Go, Java or PHP: its kind, its text and its line; a PHP string keeps the variables it interpolates. */
export interface CToken {
  readonly t: CTokenKind;
  readonly v: string;
  readonly line: number;
  readonly interp?: readonly string[] | null;
}
export type Tokens = readonly CToken[];
/* A range of tokens, [start, end]: a parameter list's brackets, a body's braces, an argument's [start, end). */
export type Span = readonly [number, number];

/* A token that matches nothing: what an index past either end of a list reads as. */
export const NO_TOKEN: CToken = Object.freeze({ t: 'punc', v: '', line: 0 });
export function at(tokens: Tokens, index: number): CToken {
  return tokens[index] ?? NO_TOKEN;
}
export interface FunctionInfo {
  name?: string | null;
  line: number;
  params: Span;
  body: Span;
  receiver?: Span | null;
  decorations: string[];
  arrow?: boolean;
  skipOnly?: boolean;
  walked?: boolean;
}
export interface Callee {
  segments: string[];
  name: string | null;
  receiver: string | null;
  constructed: boolean;
  text: string;
}
export const MAX_TOKENS = 400000;
/* A lookup table read by names from the code: no inherited keys, so `toString` or `constructor` finds nothing. */
export function table<T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null), entries));
}
/* ---- Lexing ------------------------------------------------------------------------ */

export const PUNCTUATION: readonly string[] = ['...', '<<=', '>>=', '===', '!==', '<=>', '**=', '??=', '?->', '::', '->', '=>', ':=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '.=', '%=', '&=', '|=', '^=', '<<', '>>', '??', '<-'];
export const PHP_INTERPOLATION = /\{?\$([A-Za-z_][A-Za-z0-9_]*)/g;

/*
 * Tokens for Go, Java and PHP: identifiers (a PHP variable keeps its $),
 * strings with their text and, for PHP, the variables they interpolate,
 * numbers and punctuation, each with its line. Comments are dropped; PHP's
 * inline HTML is skipped, and its short echo tag reads as `echo`.
 */
export function lex(text: string, language: Language): CToken[] {
  const tokens: CToken[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const push = (t: CTokenKind, v: string) => { tokens.push({ t, v, line }); };
  const count = (from: number, to: number) => { for (let k = from; k < to; k += 1) if (text.charCodeAt(k) === 10) line += 1; };
  /* PHP outside its tags is page text. */
  const skipInline = () => {
    const open = text.indexOf('<?', i);
    const end = open === -1 ? n : open;
    count(i, end);
    i = end;
    if (open === -1) return;
    if (text.startsWith('<?php', i)) i += 5;
    else if (text.startsWith('<?=', i)) { i += 3; push('id', 'echo'); }
    else i += 2;
  };
  if (language === 'php') skipInline();
  while (i < n) {
    if (tokens.length > MAX_TOKENS) break;
    const c = text.charAt(i);
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i += 1; continue; }
    if (language === 'php' && c === '?' && text.charAt(i + 1) === '>') { i += 2; push('punc', ';'); skipInline(); continue; }
    if (c === '/' && text.charAt(i + 1) === '/') { while (i < n && text.charAt(i) !== '\n') i += 1; continue; }
    if (c === '#' && language === 'php' && text.charAt(i + 1) !== '[') { while (i < n && text.charAt(i) !== '\n') i += 1; continue; }
    if (c === '/' && text.charAt(i + 1) === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      count(i, stop);
      i = stop;
      continue;
    }
    /* Java text blocks. */
    if (language === 'java' && text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      const stop = end === -1 ? n : end + 3;
      const startLine = line;
      const value = text.slice(i + 3, end === -1 ? n : end);
      count(i, stop);
      tokens.push({ t: 'str', v: value, line: startLine });
      i = stop;
      continue;
    }
    /* PHP heredoc and nowdoc. */
    if (language === 'php' && text.startsWith('<<<', i)) {
      const head = /^<<<\s*(['"]?)([A-Za-z_]\w*)\1\r?\n/.exec(text.slice(i, i + 80));
      if (head) {
        const body = i + head[0].length;
        const close = new RegExp(`\\n[ \\t]*${head[2] ?? ''}\\b`).exec(text.slice(body));
        const end = close ? body + close.index : n;
        const value = text.slice(body, end);
        const startLine = line;
        const stop = close ? end + close[0].length : n;
        count(i, stop);
        const interp = head[1] === "'" ? [] : [...value.matchAll(PHP_INTERPOLATION)].map(match => `$${match[1] ?? ''}`);
        tokens.push({ t: 'str', v: value, line: startLine, interp });
        i = stop;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let k = i + 1;
      let value = '';
      const startLine = line;
      while (k < n && text.charAt(k) !== quote) {
        if (text.charAt(k) === '\\' && quote !== '`' && k + 1 < n) { value += text.charAt(k + 1); if (text.charAt(k + 1) === '\n') line += 1; k += 2; continue; }
        if (text.charAt(k) === '\n') line += 1;
        value += text.charAt(k);
        k += 1;
      }
      i = k + 1;
      const interp = language === 'php' && quote !== "'" ? [...value.matchAll(PHP_INTERPOLATION)].map(match => `$${match[1] ?? ''}`) : null;
      if (language === 'php' && quote === '`') tokens.push({ t: 'shell', v: value, line: startLine, interp });
      else tokens.push(interp && interp.length ? { t: 'str', v: value, line: startLine, interp } : { t: 'str', v: value, line: startLine });
      continue;
    }
    if (/[A-Za-z_$]/.test(c) || (c === '\\' && language === 'php' && /[A-Za-z_]/.test(text.charAt(i + 1) || ''))) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_$\\]/.test(text.charAt(k))) {
        if (text.charAt(k) === '\\' && language !== 'php') break;
        k += 1;
      }
      let word = text.slice(i, k);
      /* A PHP name is its last namespace segment. */
      if (language === 'php' && word.includes('\\')) word = word.slice(word.lastIndexOf('\\') + 1) || word;
      push('id', word);
      i = k;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let k = i + 1;
      while (k < n && /[0-9A-Za-z_.]/.test(text.charAt(k))) k += 1;
      push('num', text.slice(i, k));
      i = k;
      continue;
    }
    const multi = PUNCTUATION.find(p => text.startsWith(p, i));
    if (multi) { push('punc', multi); i += multi.length; continue; }
    push('punc', c);
    i += 1;
  }
  return tokens;
}

/* ---- Structure --------------------------------------------------------------------- */

export const isPunc = (token: CToken | null | undefined, value: string): boolean => Boolean(token && token.t === 'punc' && token.v === value);
export const isWord = (token: CToken | null | undefined, value: string): boolean => Boolean(token && token.t === 'id' && token.v === value);

/*
 * Every bracket's partner, worked out once per file in one pass: a stack per
 * kind, so a bracket matches the nearest unmatched one of its own kind, as
 * counting depth does. Looking each close up by scanning forward instead
 * made a file of unclosed brackets cost the square of its length.
 */
/* Maps, so a bracket is looked up by its own text and never by a name inherited from Object.prototype. */
export const PAIRS: ReadonlyMap<string, string> = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
export const partnerTables = new WeakMap<Tokens, Int32Array>();
export function partners(tokens: Tokens): Int32Array {
  let table = partnerTables.get(tokens);
  if (table) return table;
  table = new Int32Array(tokens.length).fill(-1);
  const stacks = new Map<string, number[]>([['(', []], ['[', []], ['{', []]]);
  const opener = new Map([[')', '('], [']', '['], ['}', '{']]);
  for (let k = 0; k < tokens.length; k += 1) {
    const token = at(tokens, k);
    if (token.t !== 'punc') continue;
    const opened = stacks.get(token.v);
    if (opened) opened.push(k);
    else {
      const closes = opener.get(token.v);
      const open = closes === undefined ? undefined : stacks.get(closes)?.pop();
      if (open !== undefined) { table[open] = k; table[k] = open; }
    }
  }
  partnerTables.set(tokens, table);
  return table;
}

/* Matching close for the bracket at `index`, or -1. */
export function closing(tokens: Tokens, index: number, end = tokens.length): number {
  const token = at(tokens, index);
  if (!token || !PAIRS.has(token.v)) return -1;
  const close = partners(tokens)[index] ?? -1;
  return close > index && close < end ? close : -1;
}

/* Arguments of the call whose '(' is at `open`: [start, end) ranges at the top level. */
export function argumentsOf(tokens: Tokens, open: number): { args: Span[]; close: number } {
  const close = closing(tokens, open);
  if (close === -1) return { args: [], close: open };
  const args: Span[] = [];
  const table = partners(tokens);
  let start = open + 1;
  /* A bracket inside is stepped over to its partner, so a call reads only its own top level: nested calls cost nothing twice. */
  for (let k = open + 1; k < close; k += 1) {
    const token = at(tokens, k);
    if (token.t !== 'punc') continue;
    if (PAIRS.has(token.v)) {
      const partner = table[k] ?? -1;
      if (partner > k && partner < close) { k = partner; continue; }
      /* an unclosed bracket: the rest is one argument, as counting depth reads it */
      break;
    }
    if (token.v === ',') { args.push([start, k]); start = k + 1; }
  }
  if (close > start) args.push([start, close]);
  return { args, close };
}

/*
 * The chain of names before the '(' at `open`: `db.Query`, `$this->db->query`,
 * `DB::select`, `Runtime.getRuntime().exec` (a call inside the chain is a
 * segment ending "()"), and whether `new` constructs it.
 */
export function calleeAt(tokens: Tokens, open: number): Callee {
  const segments: string[] = [];
  let k = open - 1;
  while (k >= 0) {
    const token = at(tokens, k);
    if (token.t === 'id') {
      segments.unshift(token.v);
      const before = tokens[k - 1];
      if (before && before.t === 'punc' && (before.v === '.' || before.v === '->' || before.v === '::' || before.v === '?->')) { k -= 2; continue; }
      k -= 1;
      break;
    }
    if (isPunc(token, ')')) {
      /* a call in the chain: find its '(' and the name before it */
      let depth = 0;
      let m = k;
      for (; m >= 0; m -= 1) {
        if (isPunc(tokens[m], ')')) depth += 1;
        else if (isPunc(tokens[m], '(')) { depth -= 1; if (depth === 0) break; }
      }
      const name = tokens[m - 1];
      if (!name || name.t !== 'id') break;
      segments.unshift(`${name.v}()`);
      const before = tokens[m - 2];
      if (before && before.t === 'punc' && (before.v === '.' || before.v === '->' || before.v === '::' || before.v === '?->')) { k = m - 3; continue; }
      k = m - 2;
      break;
    }
    break;
  }
  const constructed = isWord(tokens[k], 'new');
  return { segments, name: segments[segments.length - 1] || null, receiver: segments.length > 1 ? segments[segments.length - 2] ?? null : null, constructed, text: segments.join('.') };
}

/* ---- Functions ----------------------------------------------------------------------- */

export const JAVA_NOT_METHOD: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new', 'else', 'try', 'do', 'throw', 'assert', 'super', 'this']);

/* A default assigned only when this input is empty or null leaves nonempty input untouched. */
export function absentName(tokens: Tokens, from: number, to: number): string | null {
  if (isPunc(tokens[from], '(') && closing(tokens, from) === to - 1) { from += 1; to -= 1; }
  const name = at(tokens, from);
  const empty = at(tokens, from + 2);
  if (to !== from + 3 || name.t !== 'id' || !['==', '==='].includes(at(tokens, from + 1).v)) return null;
  return (empty.t === 'str' && empty.v === '') || isWord(empty, 'null') ? name.v : null;
}

/* Strictly contained bodies are entered by their enclosing function. At equal starts,
 * shorter bodies sort first so an equal start can never count as containment. */
export function nestedFunctions(functions: readonly FunctionInfo[]): Set<FunctionInfo> {
  const nested = new Set<FunctionInfo>();
  let lastEnd = -1;
  for (const fn of [...functions].sort((a, b) => a.body[0] - b.body[0] || a.body[1] - b.body[1])) {
    if (fn.body[1] < lastEnd) nested.add(fn);
    else lastEnd = fn.body[1];
  }
  return nested;
}

/*
 * Every function, method and closure with its parameter range, its body
 * range and, for Java, the annotations and modifiers written before it.
 */
export function functionsOf(tokens: Tokens, language: Language): FunctionInfo[] {
  const found: FunctionInfo[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = at(tokens, i);
    if (language === 'go' && isWord(token, 'func')) {
      let k = i + 1;
      let receiver: Span | null = null;
      if (isPunc(tokens[k], '(')) {
        const close = closing(tokens, k);
        if (close === -1) continue;
        /* a method's receiver when a name and '(' follow; otherwise these are a literal's parameters */
        if (tokens[close + 1] && at(tokens, close + 1).t === 'id' && isPunc(tokens[close + 2], '(')) { receiver = [k, close]; k = close + 1; }
      }
      const name = tokens[k] && at(tokens, k).t === 'id' ? at(tokens, k).v : null;
      if (name) k += 1;
      /* generic type parameters */
      if (isPunc(tokens[k], '[')) { const close = closing(tokens, k); if (close === -1) continue; k = close + 1; }
      if (!isPunc(tokens[k], '(')) continue;
      const paramsClose = closing(tokens, k);
      if (paramsClose === -1) continue;
      /* the body is the first '{' at this depth after the results */
      let b = paramsClose + 1;
      let depth = 0;
      while (b < tokens.length) {
        const t = tokens[b];
        if (isPunc(t, '(') || isPunc(t, '[')) depth += 1;
        else if (isPunc(t, ')') || isPunc(t, ']')) depth -= 1;
        else if (depth === 0 && isPunc(t, '{')) break;
        else if (depth === 0 && (isPunc(t, ';') || isPunc(t, '}') || isPunc(t, '=') || isPunc(t, ','))) { b = -1; break; }
        b += 1;
      }
      if (b === -1 || b >= tokens.length) continue;
      const bodyClose = closing(tokens, b);
      if (bodyClose === -1) continue;
      found.push({ name, line: token.line, params: [k, paramsClose], body: [b, bodyClose], receiver, decorations: [] });
    } else if (language === 'php' && (isWord(token, 'function') || isWord(token, 'fn'))) {
      let k = i + 1;
      if (isPunc(tokens[k], '&')) k += 1;
      const name = tokens[k] && at(tokens, k).t === 'id' && !isPunc(tokens[k], '(') ? at(tokens, k).v : null;
      if (name) k += 1;
      if (!isPunc(tokens[k], '(')) continue;
      const paramsClose = closing(tokens, k);
      if (paramsClose === -1) continue;
      let b = paramsClose + 1;
      if (isWord(tokens[b], 'use') && isPunc(tokens[b + 1], '(')) { const close = closing(tokens, b + 1); if (close === -1) continue; b = close + 1; }
      if (isPunc(tokens[b], ':')) { b += 1; while (b < tokens.length && !isPunc(tokens[b], '{') && !isPunc(tokens[b], '=>') && !isPunc(tokens[b], ';')) b += 1; }
      if (token.v === 'fn' && isPunc(tokens[b], '=>')) {
        /* an arrow function's body is one expression */
        let e = b + 1;
        let depth = 0;
        while (e < tokens.length) {
          const t = tokens[e];
          if (isPunc(t, '(') || isPunc(t, '[') || isPunc(t, '{')) depth += 1;
          else if (isPunc(t, ')') || isPunc(t, ']') || isPunc(t, '}')) { if (depth === 0) break; depth -= 1; }
          else if (depth === 0 && (isPunc(t, ';') || isPunc(t, ','))) break;
          e += 1;
        }
        found.push({ name: null, line: token.line, params: [k, paramsClose], body: [b, e], arrow: true, decorations: decorationsBefore(tokens, i) });
        continue;
      }
      if (!isPunc(tokens[b], '{')) continue;
      const bodyClose = closing(tokens, b);
      if (bodyClose === -1) continue;
      found.push({ name, line: token.line, params: [k, paramsClose], body: [b, bodyClose], decorations: decorationsBefore(tokens, i) });
    } else if (language === 'java' && token.t === 'id' && isPunc(tokens[i + 1], '(') && !JAVA_NOT_METHOD.has(token.v)) {
      const before = tokens[i - 1];
      /* a declaration: a type before the name (a word, a generic's '>' or an array's ']') */
      /* `List<Map<String, Object>> find(` ends its type with `>>`, read as one token */
      if (!before || !(before.t === 'id' || isPunc(before, '>') || isPunc(before, '>>') || isPunc(before, '>>>') || isPunc(before, ']'))) continue;
      if (before.t === 'id' && (before.v === 'new' || before.v === 'return' || before.v === 'throw' || before.v === 'else')) continue;
      const paramsClose = closing(tokens, i + 1);
      if (paramsClose === -1) continue;
      let b = paramsClose + 1;
      if (isWord(tokens[b], 'throws')) { while (b < tokens.length && !isPunc(tokens[b], '{') && !isPunc(tokens[b], ';')) b += 1; }
      if (!isPunc(tokens[b], '{')) continue;
      const bodyClose = closing(tokens, b);
      if (bodyClose === -1) continue;
      found.push({ name: token.v, line: token.line, params: [i + 1, paramsClose], body: [b, bodyClose], decorations: decorationsBefore(tokens, i) });
    }
  }
  return found;
}

/* The annotations, attributes and modifiers written before a declaration, as text, back to the last statement or brace. */
export function decorationsBefore(tokens: Tokens, index: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  for (let k = index - 1; k >= 0 && index - k < 160; k -= 1) {
    const token = at(tokens, k);
    if (isPunc(token, ')')) depth += 1;
    else if (isPunc(token, '(')) depth -= 1;
    else if (depth === 0 && (isPunc(token, ';') || isPunc(token, '{') || isPunc(token, '}'))) break;
    parts.unshift(token.t === 'str' ? JSON.stringify(token.v) : token.v);
  }
  /* `@ GetMapping` reads as `@GetMapping` */
  return parts.join(' ').replace(/@ /g, '@').split(' ');
}

/* A parameter list as { name, type, annotations, index }. */
export interface Parameter {
  name: string | null;
  type: string;
  text: string;
  index: number;
}

export function parametersOf(tokens: Tokens, range: Span, language: Language): Parameter[] {
  const [open] = range;
  const { args } = argumentsOf(tokens, open);
  return args.map(([start, end], index) => {
    const slice = tokens.slice(start, end);
    const words = slice.map(t => (t.t === 'str' ? JSON.stringify(t.v) : t.v));
    let name: string | null = null;
    let type = '';
    if (language === 'go') {
      /* `w http.ResponseWriter`, `r *http.Request`, or a bare type in a shared list */
      const first = slice.find(t => t.t === 'id');
      name = first ? first.v : null;
      type = words.slice(1).join('');
    } else if (language === 'php') {
      const variable = slice.find(t => t.t === 'id' && t.v.startsWith('$'));
      name = variable ? variable.v : null;
      type = slice.filter(t => t.t === 'id' && !t.v.startsWith('$')).map(t => t.v).join(' ');
    } else {
      /* Java: annotations, modifiers, a type, then the name last */
      const ids = slice.filter(t => t.t === 'id');
      name = ids.length ? at(ids, ids.length - 1).v : null;
      type = ids.length > 1 ? at(ids, ids.length - 2).v : '';
    }
    return { name, type, text: words.join(' '), index };
  });
}
