'use strict';

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

const JS_KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'return',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'of', 'from'
]);
/* After these a slash opens a regular expression rather than dividing. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNCT3 = ['===', '!==', '**=', '<<=', '>>=', '>>>', '...', '&&=', '||=', '??='];
const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];

const MAX_TOKENS = 400000;

function isIdStart(char) {
  return /[A-Za-z_$À-￿]/.test(char);
}
function isIdPart(char) {
  return /[A-Za-z0-9_$À-￿]/.test(char);
}

/*
 * JavaScript and TypeScript. A template literal becomes one token whose
 * interpolations are token lists of their own, so a value spliced into a
 * query or a URL is still a name the analysis can look up. A quote that does
 * not close before the end of its line is text in a JSX element ("Don't"),
 * not a string, and is skipped rather than allowed to swallow the file.
 */
function lexJs(text) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const length = text.length;

  function previousSignificant() {
    return tokens.length ? tokens[tokens.length - 1] : null;
  }
  function regexAllowed() {
    const prev = previousSignificant();
    if (!prev) return true;
    if (prev.t === 'num' || prev.t === 'str' || prev.t === 'tpl' || prev.t === 're') return false;
    if (prev.t === 'id') return false;
    if (prev.t === 'kw') return REGEX_AFTER_WORD.has(prev.v);
    return !(prev.v === ')' || prev.v === ']' || prev.v === '}');
  }

  function readTemplate() {
    const startLine = line;
    const parts = [];
    const exprs = [];
    let buffer = '';
    index += 1;
    while (index < length) {
      const char = text[index];
      if (char === '\\') { buffer += text.slice(index, index + 2); if (text[index + 1] === '\n') line += 1; index += 2; continue; }
      if (char === '`') { index += 1; break; }
      if (char === '$' && text[index + 1] === '{') {
        parts.push(buffer);
        buffer = '';
        index += 2;
        const inner = [];
        let depth = 1;
        const exprStart = index;
        /* The interpolation is code: lex it on its own, to its matching brace. */
        let cursor = index;
        let stringQuote = null;
        while (cursor < length && depth > 0) {
          const c = text[cursor];
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
              const n = text[cursor];
              if (n === '\\') { cursor += 2; continue; }
              if (n === '$' && text[cursor + 1] === '{') { nested += 1; cursor += 2; continue; }
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
        const sub = lexJs(source);
        for (const token of sub) inner.push({ ...token, line: token.line + line - 1 });
        for (let k = exprStart; k < cursor; k += 1) if (text[k] === '\n') line += 1;
        exprs.push(inner);
        index = cursor + 1;
        continue;
      }
      if (char === '\n') line += 1;
      buffer += char;
      index += 1;
    }
    parts.push(buffer);
    return { t: 'tpl', v: '`', parts, exprs, line: startLine };
  }

  while (index < length) {
    if (tokens.length > MAX_TOKENS) break;
    const char = text[index];
    if (char === '\n') { line += 1; index += 1; continue; }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\v' || char === ' ' || char === '﻿') { index += 1; continue; }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? length : end;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? length : end + 2;
      for (let k = index; k < stop; k += 1) if (text[k] === '\n') line += 1;
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      let value = '';
      let closed = false;
      while (cursor < length) {
        const c = text[cursor];
        if (c === '\\') { value += text.slice(cursor, cursor + 2); cursor += 2; continue; }
        if (c === '\n') break;
        if (c === char) { closed = true; cursor += 1; break; }
        value += c;
        cursor += 1;
      }
      if (!closed) { index += 1; continue; }
      tokens.push({ t: 'str', v: value, q: char, line });
      index = cursor;
      continue;
    }
    if (char === '`') { tokens.push(readTemplate()); continue; }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] || ''))) {
      const match = /^(0[xXbBoO][0-9a-fA-F_]+n?|[0-9][0-9_]*(\.[0-9_]*)?([eE][+-]?[0-9]+)?n?|\.[0-9]+([eE][+-]?[0-9]+)?)/.exec(text.slice(index, index + 64));
      const value = match ? match[0] : char;
      tokens.push({ t: 'num', v: value, line });
      index += value.length;
      continue;
    }
    if (isIdStart(char)) {
      let cursor = index + 1;
      while (cursor < length && isIdPart(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      tokens.push({ t: JS_KEYWORDS.has(word) ? 'kw' : 'id', v: word, line });
      index = cursor;
      continue;
    }
    if (char === '#' && isIdStart(text[index + 1] || '')) {
      let cursor = index + 1;
      while (cursor < length && isIdPart(text[cursor])) cursor += 1;
      tokens.push({ t: 'id', v: text.slice(index, cursor), line });
      index = cursor;
      continue;
    }
    if (char === '/' && regexAllowed()) {
      let cursor = index + 1;
      let inClass = false;
      let ok = false;
      while (cursor < length) {
        const c = text[cursor];
        if (c === '\n') break;
        if (c === '\\') { cursor += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { ok = true; cursor += 1; break; }
        cursor += 1;
      }
      if (ok) {
        while (cursor < length && /[a-z]/i.test(text[cursor])) cursor += 1;
        tokens.push({ t: 're', v: '/', line });
        index = cursor;
        continue;
      }
    }
    const three = text.slice(index, index + 3);
    const four = text.slice(index, index + 4);
    if (four === '>>>=') { tokens.push({ t: 'punc', v: four, line }); index += 4; continue; }
    if (PUNCT3.includes(three)) { tokens.push({ t: 'punc', v: three, line }); index += 3; continue; }
    const two = text.slice(index, index + 2);
    if (PUNCT2.includes(two)) {
      /* ?. followed by a digit is a conditional and a number, not optional chaining. */
      if (two === '?.' && /[0-9]/.test(text[index + 2] || '')) { tokens.push({ t: 'punc', v: '?', line }); index += 1; continue; }
      tokens.push({ t: 'punc', v: two, line });
      index += 2;
      continue;
    }
    tokens.push({ t: 'punc', v: char, line });
    index += 1;
  }
  /* Each token knows its own place, so a call's arguments can be found again in O(1). */
  for (let position = 0; position < tokens.length; position += 1) tokens[position].i = position;
  return tokens;
}

/*
 * Python, as logical lines: each carries its indentation and its tokens, and
 * a line that continues inside brackets or after a backslash is joined to the
 * one it continues. An f-string is a template like JavaScript's, its {...}
 * parts lexed as code; any other string is one token.
 */
const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case'
]);
const PY_PUNCT3 = ['**=', '//=', '>>=', '<<=', '...'];
const PY_PUNCT2 = ['==', '!=', '<=', '>=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '//', '<<', '>>', ':='];

function fstringExprs(body, line) {
  const exprs = [];
  const parts = [];
  let buffer = '';
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === '{' && body[index + 1] === '{') { buffer += '{'; index += 2; continue; }
    if (char === '}' && body[index + 1] === '}') { buffer += '}'; index += 2; continue; }
    if (char === '{') {
      parts.push(buffer);
      buffer = '';
      let depth = 1;
      let cursor = index + 1;
      while (cursor < body.length && depth > 0) {
        if (body[cursor] === '{') depth += 1;
        else if (body[cursor] === '}') depth -= 1;
        if (depth > 0) cursor += 1;
      }
      /* A format spec or conversion after the expression is not code. */
      const inner = body.slice(index + 1, cursor).replace(/(![rsa])?(:[^{}]*)?$/, '');
      exprs.push(lexPyTokens(inner, line));
      index = cursor + 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  parts.push(buffer);
  return { parts, exprs };
}

function lexPyTokens(text, startLine = 1) {
  const tokens = [];
  let index = 0;
  let line = startLine;
  const length = text.length;
  while (index < length) {
    if (tokens.length > MAX_TOKENS) break;
    const char = text[index];
    if (char === '\n') { tokens.push({ t: 'nl', v: '\n', line }); line += 1; index += 1; continue; }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\f') { index += 1; continue; }
    if (char === '#') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? length : end;
      continue;
    }
    if (char === '\\' && text[index + 1] === '\n') { index += 2; line += 1; continue; }
    const prefix = /^([rRbBuUfF]{1,2})?("""|'''|"|')/.exec(text.slice(index, index + 5));
    if (prefix && (prefix[1] === undefined || /^(r|b|u|f|rb|br|fr|rf)$/i.test(prefix[1]))) {
      const quote = prefix[2];
      const flags = (prefix[1] || '').toLowerCase();
      let cursor = index + prefix[0].length;
      let body = '';
      let closed = false;
      const startLine = line;
      while (cursor < length) {
        const c = text[cursor];
        if (c === '\\' && !flags.includes('r')) { body += text.slice(cursor, cursor + 2); if (text[cursor + 1] === '\n') line += 1; cursor += 2; continue; }
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
        const { parts, exprs } = fstringExprs(body, startLine);
        tokens.push({ t: 'tpl', v: 'f', parts, exprs, line: startLine });
      } else {
        tokens.push({ t: 'str', v: body, q: quote, line: startLine });
      }
      index = cursor;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] || ''))) {
      const match = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]*)?([eE][+-]?[0-9]+)?[jJ]?|\.[0-9]+)/.exec(text.slice(index, index + 64));
      const value = match ? match[0] : char;
      tokens.push({ t: 'num', v: value, line });
      index += value.length;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(char)) {
      let cursor = index + 1;
      while (cursor < length && /[A-Za-z0-9_À-￿]/.test(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      tokens.push({ t: PY_KEYWORDS.has(word) ? 'kw' : 'id', v: word, line });
      index = cursor;
      continue;
    }
    const three = text.slice(index, index + 3);
    if (PY_PUNCT3.includes(three)) { tokens.push({ t: 'punc', v: three, line }); index += 3; continue; }
    const two = text.slice(index, index + 2);
    if (PY_PUNCT2.includes(two)) { tokens.push({ t: 'punc', v: two, line }); index += 2; continue; }
    tokens.push({ t: 'punc', v: char, line });
    index += 1;
  }
  for (let position = 0; position < tokens.length; position += 1) tokens[position].i = position;
  return tokens;
}

/*
 * Python's logical lines: a newline inside brackets does not end a
 * statement. Each line knows its indentation, which is how scopes are read.
 */
function lexPython(text) {
  const tokens = lexPyTokens(text, 1);
  const rawLines = text.split('\n');
  const lines = [];
  let current = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.t === 'nl') {
      if (depth > 0) continue;
      if (current.length) {
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
  if (current.length) {
    const first = current[0].line;
    const raw = rawLines[first - 1] || '';
    lines.push({ indent: raw.length - raw.replace(/^[ \t]+/, '').length, tokens: current, line: first });
  }
  for (const logical of lines) logical.tokens.forEach((token, position) => { token.i = position; });
  return lines;
}

/* The index of the bracket that closes the one at `open`, or the end of the list. */
function matching(tokens, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closer = pairs[tokens[open].v];
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.t !== 'punc') continue;
    if (token.v === tokens[open].v) depth += 1;
    else if (token.v === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length - 1;
}

/* A bracketed list split at its top-level commas: the arguments of a call. */
function splitArgs(tokens, open) {
  const close = matching(tokens, open);
  const args = [];
  let current = [];
  let depth = 0;
  for (let index = open + 1; index < close; index += 1) {
    const token = tokens[index];
    if (token.t === 'punc' && '([{'.includes(token.v)) depth += 1;
    if (token.t === 'punc' && ')]}'.includes(token.v)) depth -= 1;
    if (depth === 0 && token.t === 'punc' && token.v === ',') {
      args.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) args.push(current);
  return { args, close };
}

/*
 * Whether a module opens with a directive -- 'use client', 'use server' --
 * once the comments and blank lines before it are stepped over. A walk, not
 * an expression: a lazy match across block comments tried every later
 * comment end in a large file, and this is asked of every file.
 */
function opensWith(text, directive) {
  const source = String(text || '');
  let index = 0;
  for (;;) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
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
  const quote = source[index];
  return (quote === '"' || quote === "'") && source.startsWith(directive, index + 1) && source[index + 1 + directive.length] === quote;
}

module.exports = Object.freeze({ lexJs, lexPython, lexPyTokens, matching, splitArgs, opensWith, JS_KEYWORDS, PY_KEYWORDS });
