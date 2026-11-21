/*
 * Uranus: the shape of a file, read before any value is followed -- the
 * names a declaration binds, where each function's parameters and body are,
 * what the file imports and exports, and the functions it defines. The flow
 * engine (uranus-flow.ts) walks what this finds.
 */

import { matching, partners } from './uranus-lex.ts';
import type { LogicalLine, PlainToken, Token } from './uranus-lex.ts';

export type Tokens = readonly Token[];
/* A name a declaration or parameter binds, and the key it was destructured from. */
export interface Binding {
  name: string;
  key: string | null;
  rest?: boolean;
  decorator?: string;
}
/* A function found in the tokens: its parameters' bindings by position and where its body is. */
export interface FnInfo {
  start: number;
  name: string | null;
  params: Binding[][];
  bodyStart: number;
  bodyEnd: number;
  next: number;
  line: number;
  isAsync: boolean;
  block: boolean;
  method?: boolean;
  arrow?: boolean;
}
export interface ImportEntry {
  readonly module: string;
  readonly name: string;
  /* Only a value import or a constant bound to an exact literal require has this identity. */
  readonly declaration?: Token;
}
export interface JsBindings {
  readonly moduleScope: Map<string, Token | null>;
  readonly written: Set<string>;
  readonly writtenMembers: Set<string>;
}
/* A function a file defines, and what its parameters reach once that has been read. */
export type FunctionEntry<S> =
  | { readonly fn: FnInfo; readonly declaration?: Token; summary: S | null }
  | { readonly py: true; readonly lineIndex: number; readonly line: number; readonly name: string; readonly indent: number; readonly shift?: number; summary: S | null };
/* What a file says of itself: its imports, its exports by the local name behind each, and its functions. */
export interface FileShape<S> {
  readonly imports: Map<string, ImportEntry>;
  readonly exportsMap: Map<string, string>;
  readonly functions: Map<string, FunctionEntry<S>>;
  /* A name that stands for a class: an instance (`users` for `new Users()`), a field (`this.users`), or `default` for a module that exports an instance. */
  readonly aliases: Map<string, string>;
}

/* A token that matches nothing: what an index past either end of a list reads as. */
export const NO_TOKEN: PlainToken = Object.freeze({ t: 'nl', v: '', line: 0, i: -1 });
export function at(tokens: Tokens, index: number): Token {
  return tokens[index] ?? NO_TOKEN;
}
export function lastOf(list: readonly string[]): string {
  return list[list.length - 1] ?? '';
}
export function isStr(token: Token | undefined): token is Token & { t: 'str' } { return token !== undefined && (token.t === 'str'); }
export function isPunc(token: Token | undefined, value: string): boolean { return token !== undefined && token.t === 'punc' && token.v === value; }
export function isWord(token: Token | undefined, value: string): boolean { return token !== undefined && (token.t === 'id' || token.t === 'kw') && token.v === value; }

/* ---- Binding patterns ------------------------------------------------------ */

/*
 * The names a declaration or a parameter binds: a name, or every name inside
 * an object or array pattern, skipping defaults and type annotations.
 */
export function bindingNames(tokens: Tokens): Binding[] {
  const names: Binding[] = [];
  const first = tokens[0];
  if (!first) return names;
  if (first.t === 'id') {
    names.push({ name: first.v, key: null });
    return names;
  }
  const second = tokens[1];
  if (isPunc(first, '...') && second && second.t === 'id') return [{ name: second.v, key: null, rest: true }];
  if (isPunc(first, '{') || isPunc(first, '[')) {
    const close = matching(tokens, 0);
    const inner = tokens.slice(1, close);
    let depth = 0;
    let part: Token[] = [];
    const parts: Token[][] = [];
    for (const token of inner) {
      if (token.t === 'punc' && '([{'.includes(token.v)) depth += 1;
      if (token.t === 'punc' && ')]}'.includes(token.v)) depth -= 1;
      if (depth === 0 && isPunc(token, ',')) { parts.push(part); part = []; continue; }
      part.push(token);
    }
    if (part.length) parts.push(part);
    for (const piece of parts) {
      const head = piece[0];
      if (!head) continue;
      const second = piece[1];
      if (isPunc(head, '...') && second && second.t === 'id') { names.push({ name: second.v, key: null, rest: true }); continue; }
      const colon = piece.findIndex((token, index) => index > 0 && isPunc(token, ':'));
      if (isPunc(first, '{') && colon > 0) {
        const key = head.t === 'id' || head.t === 'str' ? head.v : null;
        for (const inner2 of bindingNames(piece.slice(colon + 1))) names.push({ ...inner2, key: inner2.key || key });
      } else if (head.t === 'id') {
        names.push({ name: head.v, key: isPunc(first, '{') ? head.v : null });
      } else if (isPunc(head, '{') || isPunc(head, '[')) {
        names.push(...bindingNames(piece));
      }
    }
  }
  return names;
}

/* Parameters of a function: each parameter's bound names, by position. */
export function parameters(tokens: Tokens): Binding[][] {
  const list: Token[][] = [];
  let depth = 0;
  let part: Token[] = [];
  for (const token of tokens) {
    if (token.t === 'punc' && '([{<'.includes(token.v)) depth += 1;
    if (token.t === 'punc' && ')]}>'.includes(token.v)) depth -= 1;
    if (depth === 0 && isPunc(token, ',')) { list.push(part); part = []; continue; }
    part.push(token);
  }
  if (part.length) list.push(part);
  return list.map(raw => {
    /* A parameter decorator, as NestJS writes them: @Body() dto, @Param('id') id. */
    let piece = raw;
    let decorator: string | null = null;
    while (isPunc(piece[0], '@')) {
      const named = piece[1];
      if (!named || named.t !== 'id') break;
      decorator = decorator || named.v;
      let skip = 2;
      if (isPunc(piece[2], '(')) skip = matching(piece, 2) + 1;
      piece = piece.slice(skip);
    }
    /* Drop a TypeScript annotation and a default: `req: Request = x`. */
    let cut = piece.length;
    let level = 0;
    for (let index = 0; index < piece.length; index += 1) {
      const token = at(piece, index);
      if (token.t === 'punc' && '([{'.includes(token.v)) level += 1;
      if (token.t === 'punc' && ')]}'.includes(token.v)) level -= 1;
      if (level === 0 && index > 0 && (isPunc(token, ':') || isPunc(token, '=') || isPunc(token, '?'))) { cut = index; break; }
    }
    const head = piece.slice(0, cut).filter(token => !((token.t === 'kw' || token.t === 'id') && ['public', 'private', 'protected', 'readonly'].includes(token.v)));
    const names = bindingNames(head);
    if (decorator) for (const binding of names) binding.decorator = decorator;
    return names;
  });
}

/* ---- JavaScript: functions ------------------------------------------------- */

export const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'with', 'super', 'import']);

/*
 * Whether a function starts at tokens[i], and if so where its parameters and
 * body are. Declarations, expressions, arrows (with or without parentheses,
 * with a block or an expression body) and object and class methods.
 */
export function functionAt(tokens: Tokens, i: number, end: number): FnInfo | null {
  const token = tokens[i];
  if (!token) return null;
  let index = i;
  let isAsync = false;
  const after = tokens[i + 1];
  if (isWord(token, 'async') && after && (isWord(after, 'function') || isPunc(after, '(') || (after.t === 'id' && isPunc(tokens[i + 2], '=>')))) {
    isAsync = true;
    index += 1;
  }
  const head = tokens[index];
  if (!head) return null;
  if (isWord(head, 'function')) {
    let cursor = index + 1;
    if (isPunc(tokens[cursor], '*')) cursor += 1;
    let name: string | null = null;
    const named = tokens[cursor];
    if (named && named.t === 'id') { name = named.v; cursor += 1; }
    if (isPunc(tokens[cursor], '<')) cursor = skipAngles(tokens, cursor);
    if (!isPunc(tokens[cursor], '(')) return null;
    const close = matching(tokens, cursor);
    let body = close + 1;
    if (isPunc(tokens[body], ':')) body = skipType(tokens, body + 1, '{', end);
    if (!isPunc(tokens[body], '{')) return null;
    const bodyEnd = matching(tokens, body);
    return { start: i, name, params: parameters(tokens.slice(cursor + 1, close)), bodyStart: body + 1, bodyEnd, next: bodyEnd + 1, line: head.line, isAsync, block: true };
  }
  if (head.t === 'id' && isPunc(tokens[index + 1], '=>')) {
    return arrowBody(tokens, i, index + 2, [[{ name: head.v, key: null }]], end, head.line, isAsync);
  }
  if (isPunc(head, '(')) {
    const close = matching(tokens, index);
    let arrow = close + 1;
    if (isPunc(tokens[arrow], ':')) arrow = skipType(tokens, arrow + 1, '=>', end);
    if (isPunc(tokens[arrow], '=>')) {
      return arrowBody(tokens, i, arrow + 1, parameters(tokens.slice(index + 1, close)), end, head.line, isAsync);
    }
    return null;
  }
  /* A method: name(params) { ... } where a statement or property could begin. */
  if (head.t === 'id' && !NOT_METHOD.has(head.v) && isPunc(tokens[index + 1], '(')) {
    const before = tokens[i - 1];
    /* After a decorator: @Get() find(...) { ... } */
    let decorated = false;
    if (isPunc(before, ')')) {
      let depth = 0;
      for (let back = i - 1; back >= 0 && back > i - 80; back -= 1) {
        if (isPunc(tokens[back], ')')) depth += 1;
        else if (isPunc(tokens[back], '(')) { depth -= 1; if (depth === 0) { decorated = tokens[back - 1]?.t === 'id' && isPunc(tokens[back - 2], '@'); break; } }
      }
    }
    const methodPlace = !before || decorated || isPunc(before, '{') || isPunc(before, ',') || isPunc(before, ';') || isPunc(before, '}') ||
      (before.t === 'kw' && ['async', 'static', 'get', 'set'].includes(before.v)) || (before.t === 'id' && ['static', 'get', 'set', 'public', 'private', 'protected', 'override'].includes(before.v));
    if (!methodPlace) return null;
    const close = matching(tokens, index + 1);
    let body = close + 1;
    if (isPunc(tokens[body], ':')) body = skipType(tokens, body + 1, '{', end);
    if (!isPunc(tokens[body], '{')) return null;
    const bodyEnd = matching(tokens, body);
    return { start: i, name: head.v, params: parameters(tokens.slice(index + 2, close)), bodyStart: body + 1, bodyEnd, next: bodyEnd + 1, line: head.line, isAsync, block: true, method: true };
  }
  return null;
}
export function arrowBody(tokens: Tokens, start: number, bodyAt: number, params: Binding[][], end: number, line: number, isAsync: boolean): FnInfo {
  if (isPunc(tokens[bodyAt], '{')) {
    const bodyEnd = matching(tokens, bodyAt);
    return { start, name: null, params, bodyStart: bodyAt + 1, bodyEnd, next: bodyEnd + 1, line, isAsync, block: true, arrow: true };
  }
  const stop = expressionEnd(tokens, bodyAt, end, true);
  return { start, name: null, params, bodyStart: bodyAt, bodyEnd: stop, next: stop, line, isAsync, block: false, arrow: true };
}
/* A generic parameter list is short; one left open is not looked for to the end of the file. */
export const MAX_TYPE_PARAMETERS = 256;
export function skipAngles(tokens: Tokens, index: number): number {
  let depth = 0;
  for (let cursor = index; cursor < Math.min(tokens.length, index + MAX_TYPE_PARAMETERS); cursor += 1) {
    if (isPunc(tokens[cursor], '<')) depth += 1;
    else if (isPunc(tokens[cursor], '>')) { depth -= 1; if (depth === 0) return cursor + 1; }
    else if (isPunc(tokens[cursor], '>>')) { depth -= 2; if (depth <= 0) return cursor + 1; }
  }
  return index;
}
/* Past a return-type annotation, to the token that ends it. */
export function skipType(tokens: Tokens, index: number, until: string, end: number): number {
  let depth = 0;
  for (let cursor = index; cursor < Math.min(end, index + 60); cursor += 1) {
    const token = at(tokens, cursor);
    if (depth === 0 && isPunc(token, until)) return cursor;
    if (token.t === 'punc' && '(<['.includes(token.v)) depth += 1;
    if (token.t === 'punc' && ')>]'.includes(token.v)) depth -= 1;
    if (isPunc(token, '{') && until === '{' && depth === 0) return cursor;
  }
  return index;
}

export const CONTINUES = new Set(['.', '?.', '+', '-', '*', '/', '%', '&&', '||', '??', '?', ':', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '|', '&', '^', '=>', '=', '+=', '-=', '**', 'instanceof', 'in', ',']);

export function afterSemicolon(tokens: Tokens, at: number): number {
  return isPunc(tokens[at], ';') ? at + 1 : at;
}

/*
 * Where the statement that starts at `index` ends, just past it: a block, a
 * compound statement with its body (an if with its else), or an expression
 * and its semicolon. What an arm written without braces covers.
 */
export function statementEnd(tokens: Tokens, index: number, end: number): number {
  const token = tokens[index];
  if (!token || index >= end) return end;
  const past = (open: number): number => {
    const close = isPunc(tokens[open], '(') || isPunc(tokens[open], '{') ? matching(tokens, open) : -1;
    return close < 0 || close >= end ? end : close + 1;
  };
  if (isPunc(token, '{')) return past(index);
  if (isPunc(token, ';')) return index + 1;
  if (isWord(token, 'if')) {
    const body = statementEnd(tokens, past(index + 1), end);
    return isWord(tokens[body], 'else') ? statementEnd(tokens, body + 1, end) : body;
  }
  if (isWord(token, 'while') || isWord(token, 'with') || isWord(token, 'switch')) return statementEnd(tokens, past(index + 1), end);
  if (isWord(token, 'for')) return statementEnd(tokens, past(isWord(tokens[index + 1], 'await') ? index + 2 : index + 1), end);
  if (isWord(token, 'do')) {
    const body = statementEnd(tokens, index + 1, end);
    return isWord(tokens[body], 'while') ? afterSemicolon(tokens, past(body + 1)) : body;
  }
  if (isWord(token, 'try')) {
    let cursor = statementEnd(tokens, index + 1, end);
    if (isWord(tokens[cursor], 'catch')) cursor = statementEnd(tokens, isPunc(tokens[cursor + 1], '(') ? past(cursor + 1) : cursor + 1, end);
    if (isWord(tokens[cursor], 'finally')) cursor = statementEnd(tokens, cursor + 1, end);
    return cursor;
  }
  const stop = expressionEnd(tokens, index, end, false);
  return Math.min(end, Math.max(index + 1, afterSemicolon(tokens, stop)));
}

/*
 * Where an expression starting at `index` ends: at a top-level semicolon or
 * comma, at a bracket that closes something it did not open, or at a line
 * break where the next line cannot continue it. A bracket it opens is stepped
 * over to its partner -- nothing inside one can end it -- so an arrow nested
 * in an arrow does not walk the rest of the file again at every level. One
 * that never closes before `end` runs the expression to `end`.
 */
export function expressionEnd(tokens: Tokens, index: number, end: number, stopAtComma = true): number {
  const pairs = partners(tokens);
  for (let cursor = index; cursor < end; cursor += 1) {
    let token = at(tokens, cursor);
    if (token.t === 'punc') {
      if (token.v === '(' || token.v === '[' || token.v === '{') {
        const partner = pairs[cursor] ?? -1;
        if (partner < 0 || partner >= end) return end;
        cursor = partner;
        token = at(tokens, cursor);
      } else if (token.v === ')' || token.v === ']' || token.v === '}') return cursor;
      else if (token.v === ';' || (stopAtComma && token.v === ',')) return cursor;
    }
    const next = tokens[cursor + 1];
    if (next && next.line > token.line && cursor + 1 < end) {
      const ends = token.t === 'id' || token.t === 'num' || token.t === 'str' || token.t === 'tpl' || token.t === 're' ||
        isPunc(token, ')') || isPunc(token, ']') || isPunc(token, '}') || (token.t === 'kw' && ['this', 'null', 'true', 'false', 'undefined'].includes(token.v));
      const continues = (next.t === 'punc' && CONTINUES.has(next.v)) || (next.t === 'kw' && ['instanceof', 'in', 'of'].includes(next.v));
      if (ends && !continues) return cursor + 1;
    }
  }
  return end;
}

/* ---- JavaScript: imports and exports ------------------------------------------- */

export function jsImports<S>(tokens: Tokens, ctx: FileShape<S>): JsBindings {
  const moduleScope = new Map<string, Token | null>();
  const written = new Set<string>();
  const writtenMembers = new Set<string>();
  let braces = 0;
  const record = (name: string, token: Token): void => {
    if (braces === 0) moduleScope.set(name, moduleScope.has(name) ? null : token);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (isPunc(token, '{')) braces += 1;
    if (isPunc(token, '}')) braces = Math.max(0, braces - 1);
    if (isWord(token, 'function') || isWord(token, 'class')) {
      const name = tokens[index + 1];
      if (name?.t === 'id') record(name.v, name);
    }
    /* A replaced binding or member cannot keep the original contract, including in a
     * summary evaluated independently of the top-level walk. A write anywhere in
     * the file conservatively invalidates that root. */
    if (token.t === 'punc' && /^(?:=|\+=|-=|\|\|=|&&=|\?\?=)$/.test(token.v)) {
      let left = index - 1;
      if (isPunc(tokens[left - 1], '.') && tokens[left]?.t === 'id') writtenMembers.add(at(tokens, left).v);
      if (isPunc(tokens[left], ']')) {
        const open = partners(tokens)[left] ?? -1;
        writtenMembers.add(left === open + 2 && isStr(tokens[open + 1]) ? at(tokens, open + 1).v : '[]');
      }
      while (left > 0) {
        if (isPunc(tokens[left], ']')) left = (partners(tokens)[left] ?? -1) - 1;
        else if (isPunc(tokens[left - 1], '.')) left -= 2;
        else break;
      }
      const root = tokens[left];
      if (root?.t === 'id' && !/^(?:const|let|var)$/.test(at(tokens, left - 1).v)) written.add(root.v);
    }
    if (isWord(token, 'import') && !isPunc(tokens[index + 1], '(') && !isPunc(tokens[index + 1], '.')) {
      /* import a, { b as c }, * as d from 'm' */
      let cursor = index + 1;
      const typeOnly = isWord(tokens[cursor], 'type');
      if (typeOnly) cursor += 1;
      const bindings: { local: string; imported: string; typeOnly?: boolean }[] = [];
      while (cursor < tokens.length && !isWord(tokens[cursor], 'from') && !isStr(tokens[cursor])) {
        const item = at(tokens, cursor);
        if (item.t === 'id' && !isPunc(tokens[cursor - 1], 'as')) bindings.push({ local: item.v, imported: 'default' });
        const alias = tokens[cursor + 2];
        if (isPunc(item, '*') && isWord(tokens[cursor + 1], 'as') && alias) { bindings.push({ local: alias.v, imported: '*' }); cursor += 3; continue; }
        if (isPunc(item, '{')) {
          const close = matching(tokens, cursor);
          for (let inner = cursor + 1; inner < close; inner += 1) {
            const name = at(tokens, inner);
            if (name.t !== 'id' && name.t !== 'kw') continue;
            if (isWord(name, 'type')) continue;
            const renamed = tokens[inner + 2];
            if (isWord(tokens[inner + 1], 'as') && renamed) { bindings.push({ local: renamed.v, imported: name.v, typeOnly: isWord(tokens[inner - 1], 'type') }); inner += 2; continue; }
            if (isPunc(tokens[inner + 1], ',') || isPunc(tokens[inner + 1], '}')) bindings.push({ local: name.v, imported: name.v, typeOnly: isWord(tokens[inner - 1], 'type') });
          }
          cursor = close + 1;
          continue;
        }
        cursor += 1;
        if (cursor - index > 80) break;
      }
      const from = isWord(tokens[cursor], 'from') ? tokens[cursor + 1] : tokens[cursor];
      if (isStr(from)) for (const binding of bindings) {
        record(binding.local, token);
        const declaration = !braces && !typeOnly && !binding.typeOnly ? token : undefined;
        ctx.imports.set(binding.local, { module: from.v, name: binding.imported, declaration });
      }
      continue;
    }
    /* const x = require('m'), const { a, b: c } = require('m'), const x = require('m').y */
    if ((isWord(token, 'const') || isWord(token, 'let') || isWord(token, 'var')) && tokens[index + 1]) {
      const patternEnd = isPunc(tokens[index + 1], '{') || isPunc(tokens[index + 1], '[') ? matching(tokens, index + 1) : index + 1;
      const pattern = at(tokens, index + 1);
      const names = braces === 0 ? bindingNames(tokens.slice(index + 1, patternEnd + 1)) : null;
      for (const binding of names ?? []) record(binding.name, pattern);
      if (!isPunc(tokens[patternEnd + 1], '=')) continue;
      let cursor = patternEnd + 2;
      if (isWord(tokens[cursor], 'await')) cursor += 1;
      const specifier = tokens[cursor + 2];
      if (isWord(tokens[cursor], 'require') && isPunc(tokens[cursor + 1], '(') && isStr(specifier)) {
        const module = specifier.v;
        const property = isPunc(tokens[cursor + 4], '.') ? tokens[cursor + 5]?.v ?? null : null;
        const stop = cursor + (property ? 6 : 4);
        const direct = isWord(token, 'const') && cursor === patternEnd + 2 && isPunc(tokens[cursor + 3], ')')
          && expressionEnd(tokens, cursor, tokens.length, true) === stop;
        for (const binding of names ?? bindingNames(tokens.slice(index + 1, patternEnd + 1))) {
          const simple = pattern.t === 'id' || (isPunc(pattern, '{') && binding.key && !binding.rest && !property
            && !tokens.slice(index + 1, patternEnd + 1).some(t => isPunc(t, '=') || isPunc(t, '[')));
          ctx.imports.set(binding.name, { module, name: property || (binding.key || (pattern.t === 'id' ? '*' : binding.name)),
            declaration: direct && simple ? pattern : undefined });
        }
      }
    }
  }
  return { moduleScope, written, writtenMembers };
}

/* The key a re-export is kept under: no name in the code can be it. */
export const RE_EXPORT = 'export:';

export function jsExports<S>(tokens: Tokens, ctx: FileShape<S>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (isWord(token, 'export')) {
      let cursor = index + 1;
      const isDefault = isWord(tokens[cursor], 'default');
      if (isDefault) cursor += 1;
      if (isWord(tokens[cursor], 'async')) cursor += 1;
      if (isWord(tokens[cursor], 'function')) {
        const name = tokens[cursor + 1]?.t === 'id' ? at(tokens, cursor + 1).v : (isPunc(tokens[cursor + 1], '*') ? tokens[cursor + 2]?.v ?? null : null);
        if (name) ctx.exportsMap.set(name, name);
        if (isDefault) ctx.exportsMap.set('default', name || '#default');
      } else if (isWord(tokens[cursor], 'const') || isWord(tokens[cursor], 'let') || isWord(tokens[cursor], 'var')) {
        const name = tokens[cursor + 1]?.t === 'id' ? at(tokens, cursor + 1).v : null;
        if (name) ctx.exportsMap.set(name, name);
      } else if (isPunc(tokens[cursor], '{')) {
        const close = matching(tokens, cursor);
        for (let inner = cursor + 1; inner < close; inner += 1) {
          const name = at(tokens, inner);
          if (name.t !== 'id') continue;
          const alias = tokens[inner + 2];
          if (isWord(tokens[inner + 1], 'as') && alias) { ctx.exportsMap.set(alias.v, name.v); inner += 2; continue; }
          ctx.exportsMap.set(name.v, name.v);
        }
      } else if (isDefault && tokens[cursor]?.t === 'id') {
        ctx.exportsMap.set('default', at(tokens, cursor).v);
      } else if (isWord(tokens[cursor], 'class') || (isWord(tokens[cursor], 'abstract') && isWord(tokens[cursor + 1], 'class'))) {
        const named = tokens[cursor + (isWord(tokens[cursor], 'class') ? 1 : 2)];
        if (named && named.t === 'id') { ctx.exportsMap.set(named.v, named.v); if (isDefault) ctx.exportsMap.set('default', named.v); }
      } else if (isPunc(tokens[cursor], '*') && isWord(tokens[cursor + 1], 'from') && isStr(tokens[cursor + 2])) {
        /* export * from 'm': everything that module exports is exported here too. */
        ctx.imports.set(`${RE_EXPORT}*:${ctx.imports.size}`, { module: at(tokens, cursor + 2).v, name: '*' });
      }
      /* export { a as b } from 'm': b here is a there, with no local name between. */
      if (isPunc(tokens[cursor], '{')) {
        const close = matching(tokens, cursor);
        const from = tokens[close + 2];
        if (isWord(tokens[close + 1], 'from') && isStr(from)) {
          for (let inner = cursor + 1; inner < close; inner += 1) {
            const name = at(tokens, inner);
            if (name.t !== 'id' && !isWord(name, 'default')) continue;
            const alias = isWord(tokens[inner + 1], 'as') ? tokens[inner + 2] : undefined;
            ctx.exportsMap.set(alias ? alias.v : name.v, `${RE_EXPORT}${name.v}`);
            ctx.imports.set(`${RE_EXPORT}${name.v}`, { module: from.v, name: name.v });
            if (alias) inner += 2;
          }
        }
      }
    }
    /* module.exports = { a, b: c } / module.exports.a = / exports.a = */
    if (isWord(token, 'module') && isPunc(tokens[index + 1], '.') && isWord(tokens[index + 2], 'exports')) {
      if (isPunc(tokens[index + 3], '=') && isPunc(tokens[index + 4], '{')) {
        const close = matching(tokens, index + 4);
        for (let inner = index + 5; inner < close; inner += 1) {
          const name = at(tokens, inner);
          if (name.t !== 'id') continue;
          const value = tokens[inner + 2];
          if (isPunc(tokens[inner + 1], ':') && value && value.t === 'id') { ctx.exportsMap.set(name.v, value.v); inner += 2; continue; }
          if (isPunc(tokens[inner + 1], ',') || isPunc(tokens[inner + 1], '}')) ctx.exportsMap.set(name.v, name.v);
        }
      } else if (isPunc(tokens[index + 3], '=') && tokens[index + 4]?.t === 'id') {
        ctx.exportsMap.set('default', at(tokens, index + 4).v);
      } else if (isPunc(tokens[index + 3], '.') && tokens[index + 4] && isPunc(tokens[index + 5], '=')) {
        const exported = at(tokens, index + 4);
        const target = tokens[index + 6]?.t === 'id' && !isPunc(tokens[index + 7], '=>') ? at(tokens, index + 6).v : exported.v;
        ctx.exportsMap.set(exported.v, target);
      }
    }
    const exported = tokens[index + 2];
    if (isWord(token, 'exports') && isPunc(tokens[index + 1], '.') && exported && isPunc(tokens[index + 3], '=') && !isPunc(tokens[index - 1], '.')) {
      const target = tokens[index + 4]?.t === 'id' && !isPunc(tokens[index + 5], '=>') ? at(tokens, index + 4).v : exported.v;
      ctx.exportsMap.set(exported.v, target);
    }
  }
}

/* ---- Functions a file defines, for summaries ------------------------------------------ */

/* The functions an object literal or a class body holds, each under its member's name. */
function members(tokens: Tokens, open: number): { readonly name: string; readonly fn: FnInfo }[] {
  const close = matching(tokens, open);
  const found: { name: string; fn: FnInfo }[] = [];
  let index = open + 1;
  while (index > open && index < close) {
    const token = at(tokens, index);
    const method = functionAt(tokens, index, close);
    if (method && method.method && method.name) { found.push({ name: method.name, fn: method }); index = method.next; continue; }
    if ((token.t === 'id' || token.t === 'str') && (isPunc(tokens[index + 1], ':') || isPunc(tokens[index + 1], '='))) {
      const fn = functionAt(tokens, index + 2, close);
      if (fn) { found.push({ name: token.v, fn }); index = fn.next; continue; }
    }
    index = isPunc(token, '(') || isPunc(token, '[') || isPunc(token, '{') ? matching(tokens, index) + 1 : index + 1;
  }
  return found;
}

/* `new Users(`: the class an expression at this token makes an instance of, if it does. */
function instanceOf(tokens: Tokens, index: number): string | null {
  const named = tokens[index + 1];
  return isWord(tokens[index], 'new') && named && named.t === 'id' ? named.v : null;
}

export function jsFunctions<S>(tokens: Tokens, ctx: FileShape<S>): void {
  const define = (name: string, fn: FnInfo, declaration?: Token): void => { if (!ctx.functions.has(name)) ctx.functions.set(name, { fn, declaration, summary: null }); };
  const classes: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (isWord(token, 'function') || (isWord(token, 'async') && isWord(tokens[index + 1], 'function'))) {
      const fn = functionAt(tokens, index, tokens.length);
      if (fn && fn.name) ctx.functions.set(fn.name, { fn, declaration: tokens[index + (isWord(token, 'async') ? 2 : 1)], summary: null });
      continue;
    }
    const declared = tokens[index + 1];
    if ((isWord(token, 'const') || isWord(token, 'let') || isWord(token, 'var')) && declared && declared.t === 'id' && isPunc(tokens[index + 2], '=')) {
      const fn = functionAt(tokens, index + 3, tokens.length);
      if (fn) {
        fn.name = declared.v;
        ctx.functions.set(fn.name, { fn, declaration: declared, summary: null });
        continue;
      }
      /* const users = new Users(), and const users = { find(name) { ... } } */
      const made = instanceOf(tokens, index + 3);
      if (made) ctx.aliases.set(declared.v, made);
      else if (isPunc(tokens[index + 3], '{')) for (const member of members(tokens, index + 3)) define(`${declared.v}.${member.name}`, member.fn, declared);
      continue;
    }
    /* class Users { find(name) { ... } }: each method under the class's name, and each field the constructor is handed or makes. */
    if (isWord(token, 'class') && declared && declared.t === 'id') {
      let open = index + 2;
      while (open < tokens.length && open < index + 40 && !isPunc(tokens[open], '{')) open += 1;
      if (!isPunc(tokens[open], '{')) continue;
      classes.push(declared.v);
      for (const member of members(tokens, open)) {
        define(`${declared.v}.${member.name}`, member.fn, declared);
        if (member.name !== 'constructor') continue;
        /* constructor(private readonly users: UsersService) */
        for (let inner = member.fn.start; inner < member.fn.bodyStart; inner += 1) {
          const field = tokens[inner + 1];
          const type = tokens[inner + 3];
          if (/^(private|public|protected|readonly)$/.test(at(tokens, inner).v) && field && field.t === 'id' && isPunc(tokens[inner + 2], ':') && type && type.t === 'id') ctx.aliases.set(`this.${field.v}`, type.v);
        }
      }
      continue;
    }
    /* this.users = new Users() */
    if (isWord(token, 'this') && isPunc(declared, '.') && isPunc(tokens[index + 3], '=')) {
      const made = instanceOf(tokens, index + 4);
      if (made) ctx.aliases.set(`this.${at(tokens, index + 2).v}`, made);
      continue;
    }
    /* module.exports = { find(name) { ... } }, export default { ... }, and either of an instance; exports.find = function ... */
    const cjs = isWord(token, 'module') && isPunc(declared, '.') && isWord(tokens[index + 2], 'exports') && !isPunc(tokens[index - 1], '.');
    const whole = cjs && isPunc(tokens[index + 3], '=') ? index + 4 : isWord(token, 'export') && isWord(declared, 'default') ? index + 2 : -1;
    if (whole >= 0) {
      const made = instanceOf(tokens, whole);
      if (made) ctx.aliases.set('default', made);
      else if (isPunc(tokens[whole], '{')) for (const member of members(tokens, whole)) define(member.name, member.fn);
      continue;
    }
    const property = cjs && isPunc(tokens[index + 3], '.') ? index + 4 : isWord(token, 'exports') && isPunc(declared, '.') && !isPunc(tokens[index - 1], '.') ? index + 2 : -1;
    if (property >= 0 && isPunc(tokens[property + 1], '=')) {
      const fn = functionAt(tokens, property + 2, tokens.length);
      if (fn) define(at(tokens, property).v, fn);
    }
  }
  /* Inside the only class of a file, `this` is that class. */
  const [only] = classes;
  if (only !== undefined && classes.length === 1) ctx.aliases.set('this', only);
}

export function pyImports<S>(lines: readonly LogicalLine[], ctx: FileShape<S>): void {
  for (const line of lines) {
    const tokens = line.tokens;
    if (isWord(tokens[0], 'from') && tokens.some(t => isWord(t, 'import'))) {
      const importAt = tokens.findIndex(t => isWord(t, 'import'));
      const module = tokens.slice(1, importAt).map(t => t.v).join('');
      for (let index = importAt + 1; index < tokens.length; index += 1) {
        const token = at(tokens, index);
        if (token.t !== 'id') continue;
        const alias = tokens[index + 2];
        if (isWord(tokens[index + 1], 'as') && alias) { ctx.imports.set(alias.v, { module, name: token.v }); index += 2; continue; }
        ctx.imports.set(token.v, { module, name: token.v });
      }
    } else if (isWord(tokens[0], 'import')) {
      /* import services.users, services.orders as orders: the module itself, under its dotted name or its alias. */
      let index = 1;
      while (index < tokens.length) {
        let end = index;
        while (end < tokens.length && !isPunc(tokens[end], ',') && !isWord(tokens[end], 'as')) end += 1;
        const module = tokens.slice(index, end).map(t => t.v).join('');
        const alias = isWord(tokens[end], 'as') ? tokens[end + 1] : undefined;
        if (module) ctx.imports.set(alias ? alias.v : module, { module, name: '*' });
        index = end + (alias ? 2 : 0);
        while (index < tokens.length && !isPunc(tokens[index - 1], ',')) index += 1;
      }
    }
  }
}

export function pyFunctions<S>(lines: readonly LogicalLine[], ctx: FileShape<S>): void {
  /* The classes a line is inside, innermost last, by the indent each was opened at. */
  const inside: { readonly name: string; readonly indent: number }[] = [];
  const classes = new Set<string>();
  lines.forEach((line, index) => {
    const tokens = line.tokens;
    while (inside.length && line.indent <= (inside[inside.length - 1]?.indent ?? 0)) inside.pop();
    const owner = inside[inside.length - 1];
    if (isWord(tokens[0], 'class') && tokens[1]) { inside.push({ name: tokens[1].v, indent: line.indent }); classes.add(tokens[1].v); return; }
    const defAt = isWord(tokens[0], 'def') ? 0 : isWord(tokens[0], 'async') && isWord(tokens[1], 'def') ? 1 : -1;
    const named = tokens[defAt + 1];
    if (defAt >= 0 && named) {
      /* A method is its class's, and its first parameter is the instance, which no caller writes. */
      const method = owner !== undefined && line.indent > owner.indent;
      const receiver = method && /^(self|cls)$/.test(tokens[defAt + 3]?.v ?? '');
      ctx.functions.set(method ? `${owner.name}.${named.v}` : named.v, { py: true, lineIndex: index, line: line.line, name: named.v, indent: line.indent, shift: receiver ? 1 : 0, summary: null });
      return;
    }
    /* users = UserService(), self.users = UserService(): a name that stands for a class. */
    const target = isWord(tokens[0], 'self') && isPunc(tokens[1], '.') && tokens[2] ? { name: `self.${tokens[2].v}`, at: 3 } : tokens[0] && tokens[0].t === 'id' ? { name: tokens[0].v, at: 1 } : null;
    const made = target ? tokens[target.at + 1] : undefined;
    if (target && made && isPunc(tokens[target.at], '=') && made.t === 'id' && /^[A-Z]/.test(made.v) && isPunc(tokens[target.at + 2], '(')) ctx.aliases.set(target.name, made.v);
  });
  const [only] = classes;
  if (only !== undefined && classes.size === 1) ctx.aliases.set('self', only);
}
