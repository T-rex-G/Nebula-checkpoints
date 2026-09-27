'use strict';

/*
 * The first-party page, stylesheet and scripts as a visitor receives them:
 * without the source's comments.
 *
 * The source is written to be read by the people who maintain it, and much of
 * its commentary explains how a defence works, which test guards what, and
 * how the hosted service behaves under load. None of that is for a visitor,
 * and all of it was being served to every one -- about a sixth of the bytes
 * of every first load. Comments are removed when the server starts; nothing
 * else changes. Whitespace, names and statements are kept exactly, so a
 * stack trace still points at the line the source has, less the lines that
 * held only a comment.
 *
 * The JavaScript lexer knows strings, template literals (with nested
 * `${...}` expressions), regular-expression literals and both comment forms.
 * A comment that spans a line break is replaced by a line break, so automatic
 * semicolon insertion reads the result exactly as it read the source. The
 * test suite tokenises every served script before and after with a real
 * parser and requires the two token streams to be identical; at runtime a
 * classic script whose result does not compile is served as written.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* After one of these tokens a `/` begins a regular expression, not a division. */
const REGEX_AFTER_PUNCTUATOR = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/* What may follow a comment for it to count as the whole of its line, read in place. */
const REST_OF_LINE = /[ \t]*(\r?\n|$)/y;
function restOfLineAt(s, at) {
  REST_OF_LINE.lastIndex = at;
  return REST_OF_LINE.exec(s);
}

function stripJsComments(source) {
  const s = String(source);
  /*
   * The output as finished lines plus the line being written, so asking
   * "is this line blank so far" and dropping its indentation cost nothing
   * however long the file is.
   */
  const lines = [];
  let line = '';
  let lastNonSpace = '';
  const emit = text => {
    const nl = text.lastIndexOf('\n');
    if (nl === -1) line += text;
    else { lines.push(line + text.slice(0, nl + 1)); line = text.slice(nl + 1); }
    for (let k = text.length - 1; k >= 0; k -= 1) { if (!/\s/.test(text[k])) { lastNonSpace = text[k]; break; } }
  };
  let i = 0;
  /* The last significant thing written: a punctuator character, a word, or '' at the start. */
  let last = '';
  /* A stack of open template literals and the brace depth inside each `${`. */
  const templates = [];

  const lineStartOnly = () => /^[ \t]*$/.test(line);
  const dropIndentation = () => { line = ''; };
  const regexAllowed = () => last === '' || REGEX_AFTER_PUNCTUATOR.has(last) || REGEX_AFTER_WORD.has(last);

  function readTemplateChunk() {
    /* At the character after a backtick or after the `}` that closes a `${`. */
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { emit(s.slice(i, i + 2)); i += 2; continue; }
      if (c === '`') { emit(c); i += 1; last = ')'; return 'end'; }
      if (c === '$' && s[i + 1] === '{') { emit('${'); i += 2; templates.push(0); last = '{'; return 'expr'; }
      emit(c); i += 1;
    }
    throw new Error('Unterminated template literal');
  }

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '/' && next === '/') {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      if (lineStartOnly()) { dropIndentation(); i = end === -1 ? s.length : end + 1; }
      else { i = stop; }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated block comment');
      const after = restOfLineAt(s, end + 2);
      if (lineStartOnly() && after) {
        /* A comment that is the whole of its lines goes with them. */
        dropIndentation();
        i = end + 2 + after[0].length;
      } else {
        emit(s.indexOf('\n', i) !== -1 && s.indexOf('\n', i) < end ? '\n' : ' ');
        i = end + 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\') j += 1;
        else if (s[j] === '\n') throw new Error('Unterminated string');
        j += 1;
      }
      if (j >= s.length) throw new Error('Unterminated string');
      emit(s.slice(i, j + 1));
      i = j + 1;
      last = ')';
      continue;
    }
    if (c === '`') {
      emit(c); i += 1;
      readTemplateChunk();
      continue;
    }
    if (templates.length && (c === '{' || c === '}')) {
      if (c === '{') { templates[templates.length - 1] += 1; emit(c); i += 1; last = '{'; continue; }
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        emit(c); i += 1;
        readTemplateChunk();
        continue;
      }
      templates[templates.length - 1] -= 1; emit(c); i += 1; last = '}'; continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < s.length) {
        const r = s[j];
        if (r === '\\') { j += 2; continue; }
        if (r === '\n') throw new Error('Unterminated regular expression');
        if (inClass) { if (r === ']') inClass = false; }
        else if (r === '[') inClass = true;
        else if (r === '/') break;
        j += 1;
      }
      j += 1;
      while (j < s.length && /[a-z]/i.test(s[j])) j += 1;
      emit(s.slice(i, j));
      i = j;
      last = ')';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[\w$]/.test(s[j])) j += 1;
      const word = s.slice(i, j);
      /* A property named like a keyword (`x.in`, `a.return`) is a name, not the keyword. */
      const dotted = lastNonSpace === '.';
      emit(word);
      i = j;
      last = !dotted && REGEX_AFTER_WORD.has(word) ? word : ')';
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next || ''))) {
      let j = i + 1;
      while (j < s.length && /[\w.]/.test(s[j])) j += 1;
      emit(s.slice(i, j));
      i = j;
      last = ')';
      continue;
    }
    emit(c);
    i += 1;
    if (!/\s/.test(c)) last = c === ')' || c === ']' ? ')' : c;
  }
  if (templates.length) throw new Error('Unterminated template expression');
  return lines.join('') + line;
}

/* CSS: `/* ... *\/` outside strings. A comment alone on its lines goes with them. */
function stripCssComments(source) {
  const s = String(source);
  const lines = [];
  let line = '';
  const emit = text => {
    const nl = text.lastIndexOf('\n');
    if (nl === -1) line += text;
    else { lines.push(line + text.slice(0, nl + 1)); line = text.slice(nl + 1); }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) { if (s[j] === '\\') j += 1; j += 1; }
      emit(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated CSS comment');
      const after = restOfLineAt(s, end + 2);
      if (/^[ \t]*$/.test(line) && after) { line = ''; i = end + 2 + after[0].length; }
      else { emit(' '); i = end + 2; }
      continue;
    }
    /* Copy up to the next character that could open a string or a comment. */
    let j = i + 1;
    while (j < s.length && s[j] !== '"' && s[j] !== "'" && s[j] !== '/') j += 1;
    emit(s.slice(i, j));
    i = j;
  }
  return lines.join('') + line;
}

/* HTML: `<!-- ... -->`, the same way. The page carries no inline script or style. */
function stripHtmlComments(source) {
  /* The body never crosses a `-->`, so a comment cannot swallow the markup up to the next one. */
  return String(source).replace(/^[ \t]*<!--(?:(?!-->)[\s\S])*-->[ \t]*\r?\n|<!--(?:(?!-->)[\s\S])*-->/gm, '');
}

const TYPES = Object.freeze({ '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' });

/* A classic script must still compile; a module is proven by the test suite instead. */
function compiles(text) {
  if (/^\s*(?:import|export)\s/m.test(text)) return true;
  try { new vm.Script(text); return true; } catch { return false; }
}

/*
 * Each first-party script and stylesheet in `publicDir` (not vendor, not
 * nested), stripped once, keyed by its URL path. A file the stripper cannot
 * read, or whose stripped form no longer compiles, is left to the static
 * handler, which serves it as written.
 */
function buildPublicAssets(publicDir) {
  const assets = new Map();
  for (const name of fs.readdirSync(publicDir)) {
    const ext = path.extname(name);
    if (!TYPES[ext]) continue;
    const full = path.join(publicDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const source = fs.readFileSync(full, 'utf8');
    let text;
    try {
      text = ext === '.js' ? stripJsComments(source) : stripCssComments(source);
    } catch { continue; }
    if (ext === '.js' && !compiles(text)) continue;
    const body = Buffer.from(text, 'utf8');
    assets.set(`/${name}`, {
      body,
      type: TYPES[ext],
      etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`
    });
  }
  return assets;
}

module.exports = Object.freeze({ stripJsComments, stripCssComments, stripHtmlComments, buildPublicAssets });
