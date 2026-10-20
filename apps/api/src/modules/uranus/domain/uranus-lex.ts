/*
 * Uranus reads code as tokens, not as lines.
 *
 * The audit's line rules see one line at a time, so they can say "a SQL
 * statement is built from a variable here" but not where the variable came
 * from. Following a value from the request that carries it to the call that
 * misuses it needs the program's words in order: names, strings, templates
 * and the punctuation between them, with comments gone and every token
 * keeping the line it sits on.
 *
 * Two small lexers, one for JavaScript and TypeScript (JSX included) and one
 * for Python, each tolerant rather than strict. They are not parsers: a
 * type annotation, a decorator or a JSX tag is just more tokens, and a file
 * the lexer cannot follow degrades to fewer tokens, never to an exception.
 * What they return is held in memory for one analysis and never leaves the
 * process: no token text is ever part of a finding.
 */

export type TokenKind = 'id' | 'kw' | 'num' | 'str' | 'tpl' | 're' | 'punc' | 'nl';

/*
 * One token: its kind, its text and its line, and its place in the list it
 * was lexed into. A string keeps its quote; a template keeps its literal parts
 * and, between them, each interpolation lexed as code.
 */
interface TokenBase {
  v: string;
  line: number;
  i: number;
}
export interface PlainToken extends TokenBase {
  t: 'id' | 'kw' | 'num' | 're' | 'punc' | 'nl';
}
export interface StringToken extends TokenBase {
  t: 'str';
  q: string;
}
export interface TemplateToken extends TokenBase {
  t: 'tpl';
  parts: string[];
  exprs: Token[][];
}
export type Token = PlainToken | StringToken | TemplateToken;

export const JS_KEYWORDS: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'return',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'of', 'from'
]);
/* After these a slash opens a regular expression rather than dividing. */
const REGEX_AFTER_WORD: ReadonlySet<string> = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNCT3: readonly string[] = ['===', '!==', '**=', '<<=', '>>=', '>>>', '...', '&&=', '||=', '??='];
const PUNCT2: readonly string[] = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];

const MAX_TOKENS = 400000;

function isIdStart(char: string): boolean {
  return /[A-Za-z_$À-￿]/.test(char);
}
function isIdPart(char: string): boolean {
  return /[A-Za-z0-9_$À-￿]/.test(char);
}

/*
 * JavaScript and TypeScript. A template literal becomes one token whose
 * interpolations are token lists of their own, so a value spliced into a
 * query or a URL is still a name the analysis can look up. A quote that does
 * not close before the end of its line is text in a JSX element ("Don't"),
 * not a string, and is skipped rather than allowed to swallow the file.
 */
/*
 * How many templates deep an interpolation is lexed as code. Each level lexes
 * the source of the one inside it again, so a crafted file of thousands of
 * nested templates was lexed thousands of times over; real code nests two or
 * three. Deeper interpolations are kept as text with no code in them.
 */
const MAX_TEMPLATE_NESTING = 16;

export function lexJs(text: string, nesting = 0): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  const length = text.length;

  function previousSignificant(): Token | null {
    return tokens[tokens.length - 1] ?? null;
  }
  function regexAllowed(): boolean {
    const prev = previousSignificant();
    if (!prev) return true;
    if (prev.t === 'num' || prev.t === 'str' || prev.t === 'tpl' || prev.t === 're') return false;
    if (prev.t === 'id') return false;
    if (prev.t === 'kw') return REGEX_AFTER_WORD.has(prev.v);
    return !(prev.v === ')' || prev.v === ']' || prev.v === '}');
  }

  function readTemplate(): Token {
    const startLine = line;
    const parts: string[] = [];
    const exprs: Token[][] = [];
    let buffer = '';
    index += 1;
    while (index < length) {
      const char = text.charAt(index);
      if (char === '\\') { buffer += text.slice(index, index + 2); if (text.charAt(index + 1) === '\n') line += 1; index += 2; continue; }
      if (char === '`') { index += 1; break; }
      if (char === '$' && text.charAt(index + 1) === '{') {
        parts.push(buffer);
        buffer = '';
        index += 2;
        const inner: Token[] = [];
        let depth = 1;
        const exprStart = index;
        /* The interpolation is code: lex it on its own, to its matching brace. */
        let cursor = index;
        let stringQuote: string | null = null;
        while (cursor < length && depth > 0) {
          const c = text.charAt(cursor);
          if (stringQuote) {
            if (c === '\\') { cursor += 2; continue; }
            if (c === stringQuote) stringQuote = null;
            else if (c === '\n' && stringQuote !== '`') stringQuote = null;
            cursor += 1;
            continue;
          }
          if (c === '"' || c === "'") { stringQuote = c; cursor += 1; continue; }
          if (c === '`') {
            /* A template inside the interpolation: skip it whole, counting its own braces. */
            cursor += 1;
            let nested = 0;
            while (cursor < length) {
              const n = text.charAt(cursor);
              if (n === '\\') { cursor += 2; continue; }
              if (n === '$' && text.charAt(cursor + 1) === '{') { nested += 1; cursor += 2; continue; }
              if (n === '}' && nested > 0) { nested -= 1; cursor += 1; continue; }
              if (n === '`' && nested === 0) { cursor += 1; break; }
              cursor += 1;
            }
            continue;
          }
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          if (depth > 0) cursor += 1;
        }
        const source = text.slice(exprStart, cursor);
        const sub = nesting < MAX_TEMPLATE_NESTING ? lexJs(source, nesting + 1) : [];
        for (const token of sub) inner.push({ ...token, line: token.line + line - 1 });
        for (let k = exprStart; k < cursor; k += 1) if (text.charAt(k) === '\n') line += 1;
        exprs.push(inner);
        index = cursor + 1;
        continue;
      }
      if (char === '\n') line += 1;
      buffer += char;
      index += 1;
    }
    parts.push(buffer);
    return { t: 'tpl', v: '`', parts, exprs, line: startLine, i: 0 };
  }

  while (index < length) {
    if (tokens.length > MAX_TOKENS) break;
    const char = text.charAt(index);
    if (char === '\n') { line += 1; index += 1; continue; }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\v' || char === ' ' || char === '﻿') { index += 1; continue; }
    if (char === '/' && text.charAt(index + 1) === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? length : end;
      continue;
    }
    if (char === '/' && text.charAt(index + 1) === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? length : end + 2;
      for (let k = index; k < stop; k += 1) if (text.charAt(k) === '\n') line += 1;
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      let value = '';
      let closed = false;
      while (cursor < length) {
        const c = text.charAt(cursor);
        if (c === '\\') { value += text.slice(cursor, cursor + 2); cursor += 2; continue; }
        if (c === '\n') break;
        if (c === char) { closed = true; cursor += 1; break; }
        value += c;
        cursor += 1;
      }
      if (!closed) { index += 1; continue; }
      tokens.push({ t: 'str', v: value, q: char, line, i: 0 });
      index = cursor;
      continue;
    }
    if (char === '`') { tokens.push(readTemplate()); continue; }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text.charAt(index + 1) || ''))) {
      const match = /^(0[xXbBoO][0-9a-fA-F_]+n?|[0-9][0-9_]*(\.[0-9_]*)?([eE][+-]?[0-9]+)?n?|\.[0-9]+([eE][+-]?[0-9]+)?)/.exec(text.slice(index, index + 64));
      const value = match ? match[0] : char;
      tokens.push({ t: 'num', v: value, line, i: 0 });
      index += value.length;
      continue;
    }
    if (isIdStart(char)) {
      let cursor = index + 1;
      while (cursor < length && isIdPart(text.charAt(cursor))) cursor += 1;
      const word = text.slice(index, cursor);
      tokens.push({ t: JS_KEYWORDS.has(word) ? 'kw' : 'id', v: word, line, i: 0 });
      index = cursor;
      continue;
    }
    if (char === '#' && isIdStart(text.charAt(index + 1) || '')) {
      let cursor = index + 1;
      while (cursor < length && isIdPart(text.charAt(cursor))) cursor += 1;
      tokens.push({ t: 'id', v: text.slice(index, cursor), line, i: 0 });
      index = cursor;
      continue;
    }
    if (char === '/' && regexAllowed()) {
      let cursor = index + 1;
      let inClass = false;
      let ok = false;
      while (cursor < length) {
        const c = text.charAt(cursor);
        if (c === '\n') break;
        if (c === '\\') { cursor += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { ok = true; cursor += 1; break; }
        cursor += 1;
      }
      if (ok) {
        while (cursor < length && /[a-z]/i.test(text.charAt(cursor))) cursor += 1;
        tokens.push({ t: 're', v: '/', line, i: 0 });
        index = cursor;
        continue;
      }
    }
    const three = text.slice(index, index + 3);
    const four = text.slice(index, index + 4);
    if (four === '>>>=') { tokens.push({ t: 'punc', v: four, line, i: 0 }); index += 4; continue; }
    if (PUNCT3.includes(three)) { tokens.push({ t: 'punc', v: three, line, i: 0 }); index += 3; continue; }
    const two = text.slice(index, index + 2);
    if (PUNCT2.includes(two)) {
      /* ?. followed by a digit is a conditional and a number, not optional chaining. */
      if (two === '?.' && /[0-9]/.test(text.charAt(index + 2) || '')) { tokens.push({ t: 'punc', v: '?', line, i: 0 }); index += 1; continue; }
      tokens.push({ t: 'punc', v: two, line, i: 0 });
      index += 2;
      continue;
    }
    tokens.push({ t: 'punc', v: char, line, i: 0 });
    index += 1;
  }
  /* Each token knows its own place, so a call's arguments can be found again in O(1). */
  tokens.forEach((token, position) => { token.i = position; });
  return tokens;
}

/*
 * Python, as logical lines: each carries its indentation and its tokens, and
 * a line that continues inside brackets or after a backslash is joined to the
 * one it continues. An f-string is a template like JavaScript's, its {...}
 * parts lexed as code; any other string is one token.
 */
export const PY_KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case'
]);
const PY_PUNCT3: readonly string[] = ['**=', '//=', '>>=', '<<=', '...'];
const PY_PUNCT2: readonly string[] = ['==', '!=', '<=', '>=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '//', '<<', '>>', ':='];

function fstringExprs(body: string, line: number, nesting = 0): { parts: string[]; exprs: Token[][] } {
  const exprs: Token[][] = [];
  const parts: string[] = [];
  let buffer = '';
  let index = 0;
  while (index < body.length) {
    const char = body.charAt(index);
    if (char === '{' && body.charAt(index + 1) === '{') { buffer += '{'; index += 2; continue; }
    if (char === '}' && body.charAt(index + 1) === '}') { buffer += '}'; index += 2; continue; }
    if (char === '{') {
      parts.push(buffer);
      buffer = '';
      let depth = 1;
      let cursor = index + 1;
      while (cursor < body.length && depth > 0) {
        if (body.charAt(cursor) === '{') depth += 1;
        else if (body.charAt(cursor) === '}') depth -= 1;
        if (depth > 0) cursor += 1;
      }
      /* A format spec or conversion after the expression is not code. */
      const inner = body.slice(index + 1, cursor).replace(/(![rsa])?(:[^{}]*)?$/, '');
      exprs.push(nesting < MAX_TEMPLATE_NESTING ? lexPyTokens(inner, line, nesting + 1) : []);
      index = cursor + 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  parts.push(buffer);
  return { parts, exprs };
}

export function lexPyTokens(text: string, startLine = 1, nesting = 0): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = startLine;
  const length = text.length;
  while (index < length) {
    if (tokens.length > MAX_TOKENS) break;
    const char = text.charAt(index);
    if (char === '\n') { tokens.push({ t: 'nl', v: '\n', line, i: 0 }); line += 1; index += 1; continue; }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\f') { index += 1; continue; }
    if (char === '#') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? length : end;
      continue;
    }
    if (char === '\\' && text.charAt(index + 1) === '\n') { index += 2; line += 1; continue; }
    const prefix = /^([rRbBuUfF]{1,2})?("""|'''|"|')/.exec(text.slice(index, index + 5));
    if (prefix && (prefix[1] === undefined || /^(r|b|u|f|rb|br|fr|rf)$/i.test(prefix[1]))) {
      const quote = prefix[2] ?? '';
      const flags = (prefix[1] || '').toLowerCase();
      let cursor = index + prefix[0].length;
      let body = '';
      let closed = false;
      const startLine = line;
      while (cursor < length) {
        const c = text.charAt(cursor);
        if (c === '\\' && !flags.includes('r')) { body += text.slice(cursor, cursor + 2); if (text.charAt(cursor + 1) === '\n') line += 1; cursor += 2; continue; }
        if (text.startsWith(quote, cursor)) { closed = true; cursor += quote.length; break; }
        if (c === '\n') {
          if (quote.length === 1) break;
          line += 1;
        }
        body += c;
        cursor += 1;
      }
      if (!closed && quote.length === 1) { index += prefix[0].length; continue; }
      if (flags.includes('f')) {
        const { parts, exprs } = fstringExprs(body, startLine, nesting);
        tokens.push({ t: 'tpl', v: 'f', parts, exprs, line: startLine, i: 0 });
      } else {
        tokens.push({ t: 'str', v: body, q: quote, line: startLine, i: 0 });
      }
      index = cursor;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text.charAt(index + 1) || ''))) {
      const match = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]*)?([eE][+-]?[0-9]+)?[jJ]?|\.[0-9]+)/.exec(text.slice(index, index + 64));
      const value = match ? match[0] : char;
      tokens.push({ t: 'num', v: value, line, i: 0 });
      index += value.length;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(char)) {
      let cursor = index + 1;
      while (cursor < length && /[A-Za-z0-9_À-￿]/.test(text.charAt(cursor))) cursor += 1;
      const word = text.slice(index, cursor);
      tokens.push({ t: PY_KEYWORDS.has(word) ? 'kw' : 'id', v: word, line, i: 0 });
      index = cursor;
      continue;
    }
    const three = text.slice(index, index + 3);
    if (PY_PUNCT3.includes(three)) { tokens.push({ t: 'punc', v: three, line, i: 0 }); index += 3; continue; }
    const two = text.slice(index, index + 2);
    if (PY_PUNCT2.includes(two)) { tokens.push({ t: 'punc', v: two, line, i: 0 }); index += 2; continue; }
    tokens.push({ t: 'punc', v: char, line, i: 0 });
    index += 1;
  }
  tokens.forEach((token, position) => { token.i = position; });
  return tokens;
}

/*
 * Python's logical lines: a newline inside brackets does not end a
 * statement. Each line knows its indentation, which is how scopes are read.
 */
/* One logical line of Python: its indentation, its tokens, and the line it starts on. */
export interface LogicalLine {
  indent: number;
  tokens: Token[];
  line: number;
}

export function lexPython(text: string): LogicalLine[] {
  const tokens = lexPyTokens(text, 1);
  const rawLines = text.split('\n');
  const lines: LogicalLine[] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.t === 'nl') {
      if (depth > 0) continue;
      if (current[0]) {
        const first = current[0].line;
        const raw = rawLines[first - 1] || '';
        lines.push({ indent: raw.length - raw.replace(/^[ \t]+/, '').length, tokens: current, line: first });
      }
      current = [];
      continue;
    }
    if (token.t === 'punc' && '([{'.includes(token.v)) depth += 1;
    if (token.t === 'punc' && ')]}'.includes(token.v)) depth = Math.max(0, depth - 1);
    current.push(token);
  }
  if (current[0]) {
    const first = current[0].line;
    const raw = rawLines[first - 1] || '';
    lines.push({ indent: raw.length - raw.replace(/^[ \t]+/, '').length, tokens: current, line: first });
  }
  for (const logical of lines) logical.tokens.forEach((token, position) => { token.i = position; });
  return lines;
}

/*
 * Every bracket's partner in one pass, a stack per kind, kept per token list.
 * Asked bracket by bracket, a walk to the closer is repeated for every opener,
 * and a file of openers that never close made each walk run to the end of
 * the list: quadratic on a few hundred kilobytes of crafted input. A list
 * that has grown since is paired again.
 */
/* Maps, so a bracket is looked up by its own text and never by a name inherited from Object.prototype. */
const PAIRS: ReadonlyMap<string, string> = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const CLOSERS: ReadonlyMap<string, string> = new Map([[')', '('], [']', '['], ['}', '{']]);
const partnerTables = new WeakMap<readonly Token[], { length: number; table: Int32Array }>();
export function partners(tokens: readonly Token[]): Int32Array {
  const known = partnerTables.get(tokens);
  if (known && known.length === tokens.length) return known.table;
  const table = new Int32Array(tokens.length).fill(-1);
  const open = new Map<string, number[]>([['(', []], ['[', []], ['{', []]]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.t !== 'punc') continue;
    const opened = open.get(token.v);
    if (opened) opened.push(index);
    else {
      const closes = CLOSERS.get(token.v);
      const stack = closes === undefined ? undefined : open.get(closes);
      const partner = stack ? stack.pop() : undefined;
      if (partner !== undefined) table[partner] = index;
    }
  }
  partnerTables.set(tokens, { length: tokens.length, table });
  return table;
}

/* The index of the bracket that closes the one at `open`, or the end of the list. */
export function matching(tokens: readonly Token[], open: number): number {
  const token = tokens[open];
  if (token && token.t === 'punc' && PAIRS.has(token.v)) {
    const close = partners(tokens)[open] ?? -1;
    return close >= 0 ? close : tokens.length - 1;
  }
  /* Anything else keeps the walk this table replaced, unchanged. */
  const closer = token ? PAIRS.get(token.v) : undefined;
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (!current || current.t !== 'punc') continue;
    if (token && current.v === token.v) depth += 1;
    else if (current.v === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length - 1;
}

/*
 * A bracketed list split at its top-level commas: the arguments of a call.
 * Only the list's own level is walked -- a nested bracket is stepped over to
 * its partner -- and each argument is cut out once, so a call nested in a call
 * is not walked again by every call around it. An opener that never closes
 * inside the list makes the rest of it one argument, and a stray closer of
 * another kind is passed over: both are malformed, and neither may cost a walk.
 */
export function splitArgs(tokens: readonly Token[], open: number): { args: Token[][]; close: number } {
  const close = matching(tokens, open);
  const table = partners(tokens);
  const args: Token[][] = [];
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const token = tokens[index];
    if (!token || token.t !== 'punc') continue;
    if (PAIRS.has(token.v)) {
      const partner = table[index] ?? -1;
      if (partner > index && partner < close) { index = partner; continue; }
      break;
    }
    if (token.v === ',') {
      args.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  if (close > start) args.push(tokens.slice(start, close));
  return { args, close };
}

/*
 * Whether a module opens with a directive -- 'use client', 'use server' --
 * once the comments and blank lines before it are stepped over. A walk, not
 * an expression: a lazy match across block comments tried every later
 * comment end in a large file, and this is asked of every file.
 */
export function opensWith(text: unknown, directive: string): boolean {
  const source = String(text || '');
  let index = 0;
  for (;;) {
    while (index < source.length && /\s/.test(source.charAt(index))) index += 1;
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return false;
      index = end + 2;
    } else if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      if (end < 0) return false;
      index = end + 1;
    } else break;
  }
  const quote = source.charAt(index);
  return (quote === '"' || quote === "'") && source.startsWith(directive, index + 1) && source[index + 1 + directive.length] === quote;
}
