'use strict';

/*
 * Source comments removed from what a visitor receives, and the security.txt
 * contact.
 *
 * The source is written to be read by the people who maintain it, and much of
 * its commentary explains how a defence works, which test guards what, and
 * how the hosted service behaves under load. None of that is for a visitor.
 * The browser build (scripts/build-web.js) minifies the modules itself; these
 * strippers handle what it keeps as written -- the page, the one classic
 * script and the stylesheet -- keeping whitespace, names, statements and
 * declarations exactly.
 *
 * The JavaScript lexer knows strings, template literals (with nested
 * `${...}` expressions), regular-expression literals and both comment forms.
 * A comment that spans a line break is replaced by a line break, so automatic
 * semicolon insertion reads the result exactly as it read the source. The
 * test suite tokenises the stripped script before and after with a real
 * parser and requires the two token streams to be identical.
 */

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

/*
 * The Contact line of security.txt (RFC 9116) must be a URI. A bare address
 * -- what an operator naturally types -- becomes a mailto: URI; anything that
 * is neither mailto: nor https:, or that carries whitespace, falls back to
 * the repository's private advisory form rather than publishing a line a
 * researcher's tooling would reject.
 */
const SECURITY_CONTACT_FALLBACK = 'https://github.com/T-rex-G/Nebula-checkpoints/security/advisories/new';
const EMAIL = /^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/;
function securityContact(value) {
  const v = String(value || '').trim();
  if (EMAIL.test(v)) return `mailto:${v}`;
  if (/^mailto:/i.test(v) && EMAIL.test(v.slice(7))) return v;
  if (/^https:\/\/[^\s]+$/i.test(v)) return v;
  return SECURITY_CONTACT_FALLBACK;
}

module.exports = Object.freeze({ stripJsComments, stripCssComments, stripHtmlComments, securityContact });
