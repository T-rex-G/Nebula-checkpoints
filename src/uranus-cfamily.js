'use strict';

/*
 * Uranus for Go, Java and PHP: values followed from what a caller sends --
 * a query parameter, a form field, a path variable, a request body, a
 * header, a cookie -- through assignments, string building and the
 * functions of the same codebase, to the call that misuses them: a SQL
 * statement, a shell, a file path, an outbound request, a redirect, an HTML
 * response, code that is evaluated, a deserializer, a template or an XML
 * parser that resolves external entities. And the endpoints each framework
 * declares -- net/http, gorilla/mux, chi, Gin, Echo, Fiber, Spring, JAX-RS,
 * Laravel and Symfony -- with what guards them, a handler written in another
 * file read where it is written.
 *
 * It reads the way the JavaScript and Python tracer reads: a file at a time,
 * a function at a time, in order, and a flow is reported only when the
 * whole path from the request to the call is seen. It is precise before it
 * is broad. A value survives only the calls that shape a string -- trimming,
 * joining, formatting, decoding -- and a call it does not know returns a
 * value it does not follow, so a record read from the database by a
 * request's id is not mistaken for the request itself. A value passed
 * through a sanitiser -- a number parsed from it, a base name, an escaped
 * form -- is no longer followed. A check that settles the value -- a number
 * test, an anchored pattern, an allow-list, equality with literals -- quiets
 * the flow inside the block it guards, or after an early exit on its
 * negation; any other check on the value before the call turns a confirmed
 * flow into one to confirm, with the line of the check.
 *
 * Findings name a rule, a path and lines. No code leaves this module.
 */

const MAX_STEPS = 6;
const MAX_FLOWS_PER_FILE = 40;
const MAX_TOKENS = 400000;
const SQL_WORDS = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE\s+INTO|CREATE|DROP|ALTER|TRUNCATE|WHERE|VALUES|FROM\s+\w|ORDER\s+BY)/i;
const HTML_TEXT = /<\s*[a-zA-Z!/]/;
const ABSOLUTE_PREFIX = /^\s*[a-z][a-z0-9+.-]*:\/\/[^/${}\s%]+\//i;
const LOCAL_PATH_PREFIX = /^\s*\/(?![/\\])/;

/* A lookup table read by names from the code: no inherited keys, so `toString` or `constructor` finds nothing. */
function table(entries) {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

const SINKS = table({
  sql: { rule: 'SEC-001', severity: 'critical', label: 'a SQL statement' },
  command: { rule: 'SEC-011', severity: 'critical', label: 'a shell command' },
  code: { rule: 'SEC-010', severity: 'critical', label: 'code that is executed' },
  ssrf: { rule: 'SEC-021', severity: 'serious', label: 'an outbound request' },
  path: { rule: 'SEC-022', severity: 'serious', label: 'a file path' },
  redirect: { rule: 'SEC-020', severity: 'warning', label: 'a redirect' },
  html: { rule: 'SEC-033', severity: 'serious', label: 'an HTML response' },
  template: { rule: 'SEC-030', severity: 'critical', label: 'a server-side template' },
  deserialize: { rule: 'SEC-024', severity: 'critical', label: 'a deserializer' },
  mass: { rule: 'SEC-028', severity: 'serious', label: 'a record written as it arrived' },
  xxe: { rule: 'SEC-034', severity: 'serious', label: 'an XML parser that resolves external entities' }
});
const JUDGEMENT_SINKS = new Set(['mass']);

/* ---- Values ------------------------------------------------------------------------ */

function taint(kind, path, line, note) {
  return { kind, steps: [{ path, line, role: 'entrypoint', note: note || `${kind} enters here` }], built: false, sql: false, html: false, lead: null, whole: false, guarded: null };
}
function extend(value, path, line, note, patch = {}) {
  if (!value) return null;
  const last = value.steps[value.steps.length - 1];
  const steps = last && last.path === path && last.line === line ? value.steps : [...value.steps, { path, line, role: 'propagation', note }];
  return { ...value, ...patch, steps: steps.slice(0, MAX_STEPS) };
}
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  /* a check on a name settles the merged value only if every tainted part came through that name */
  const via = a.via && b.via ? a.via.filter(name => b.via.includes(name)) : undefined;
  return { ...a, built: a.built || b.built, sql: a.sql || b.sql, html: a.html || b.html, whole: a.whole || b.whole, guarded: a.guarded || b.guarded, via };
}

/* ---- Lexing ------------------------------------------------------------------------ */

const PUNCTUATION = ['...', '<<=', '>>=', '===', '!==', '<=>', '**=', '??=', '?->', '::', '->', '=>', ':=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '.=', '%=', '&=', '|=', '^=', '<<', '>>', '??', '<-'];
const PHP_INTERPOLATION = /\{?\$([A-Za-z_][A-Za-z0-9_]*)/g;

/*
 * Tokens for Go, Java and PHP: identifiers (a PHP variable keeps its $),
 * strings with their text and, for PHP, the variables they interpolate,
 * numbers and punctuation, each with its line. Comments are dropped; PHP's
 * inline HTML is skipped, and its short echo tag reads as `echo`.
 */
function lex(text, language) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const push = (t, v, extra) => { tokens.push(extra ? { t, v, line, ...extra } : { t, v, line }); };
  const count = (from, to) => { for (let k = from; k < to; k += 1) if (text.charCodeAt(k) === 10) line += 1; };
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
    const c = text[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i += 1; continue; }
    if (language === 'php' && c === '?' && text[i + 1] === '>') { i += 2; push('punc', ';'); skipInline(); continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (c === '#' && language === 'php' && text[i + 1] !== '[') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && text[i + 1] === '*') {
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
        const close = new RegExp(`\\n[ \\t]*${head[2]}\\b`).exec(text.slice(body));
        const end = close ? body + close.index : n;
        const value = text.slice(body, end);
        const startLine = line;
        const stop = close ? end + close[0].length : n;
        count(i, stop);
        const interp = head[1] === "'" ? [] : [...value.matchAll(PHP_INTERPOLATION)].map(match => `$${match[1]}`);
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
      while (k < n && text[k] !== quote) {
        if (text[k] === '\\' && quote !== '`' && k + 1 < n) { value += text[k + 1]; if (text[k + 1] === '\n') line += 1; k += 2; continue; }
        if (text[k] === '\n') line += 1;
        value += text[k];
        k += 1;
      }
      i = k + 1;
      const interp = language === 'php' && quote !== "'" ? [...value.matchAll(PHP_INTERPOLATION)].map(match => `$${match[1]}`) : null;
      if (language === 'php' && quote === '`') tokens.push({ t: 'shell', v: value, line: startLine, interp });
      else tokens.push(interp && interp.length ? { t: 'str', v: value, line: startLine, interp } : { t: 'str', v: value, line: startLine });
      continue;
    }
    if (/[A-Za-z_$]/.test(c) || (c === '\\' && language === 'php' && /[A-Za-z_]/.test(text[i + 1] || ''))) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_$\\]/.test(text[k])) {
        if (text[k] === '\\' && language !== 'php') break;
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
      while (k < n && /[0-9A-Za-z_.]/.test(text[k])) k += 1;
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

const isPunc = (token, value) => Boolean(token && token.t === 'punc' && token.v === value);
const isWord = (token, value) => Boolean(token && token.t === 'id' && token.v === value);

/*
 * Every bracket's partner, worked out once per file in one pass: a stack per
 * kind, so a bracket matches the nearest unmatched one of its own kind, as
 * counting depth does. Looking each close up by scanning forward instead
 * made a file of unclosed brackets cost the square of its length.
 */
const PAIRS = Object.freeze({ '(': ')', '[': ']', '{': '}' });
const partnerTables = new WeakMap();
function partners(tokens) {
  let table = partnerTables.get(tokens);
  if (table) return table;
  table = new Int32Array(tokens.length).fill(-1);
  const stacks = { '(': [], '[': [], '{': [] };
  const opener = { ')': '(', ']': '[', '}': '{' };
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.t !== 'punc') continue;
    if (PAIRS[token.v]) stacks[token.v].push(k);
    else if (opener[token.v]) {
      const open = stacks[opener[token.v]].pop();
      if (open !== undefined) { table[open] = k; table[k] = open; }
    }
  }
  partnerTables.set(tokens, table);
  return table;
}

/* Matching close for the bracket at `index`, or -1. */
function closing(tokens, index, end = tokens.length) {
  if (!tokens[index] || !PAIRS[tokens[index].v]) return -1;
  const close = partners(tokens)[index];
  return close > index && close < end ? close : -1;
}

/* Arguments of the call whose '(' is at `open`: [start, end) ranges at the top level. */
function argumentsOf(tokens, open) {
  const close = closing(tokens, open);
  if (close === -1) return { args: [], close: open };
  const args = [];
  const table = partners(tokens);
  let start = open + 1;
  /* A bracket inside is stepped over to its partner, so a call reads only its own top level: nested calls cost nothing twice. */
  for (let k = open + 1; k < close; k += 1) {
    const token = tokens[k];
    if (token.t !== 'punc') continue;
    if (PAIRS[token.v]) {
      const partner = table[k];
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
function calleeAt(tokens, open) {
  const segments = [];
  let k = open - 1;
  while (k >= 0) {
    const token = tokens[k];
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
  return { segments, name: segments[segments.length - 1] || null, receiver: segments.length > 1 ? segments[segments.length - 2] : null, constructed, text: segments.join('.') };
}

/* ---- Functions ----------------------------------------------------------------------- */

const JAVA_NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new', 'else', 'try', 'do', 'throw', 'assert', 'super', 'this']);

/*
 * Every function, method and closure with its parameter range, its body
 * range and, for Java, the annotations and modifiers written before it.
 */
function functionsOf(tokens, language) {
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (language === 'go' && isWord(token, 'func')) {
      let k = i + 1;
      let receiver = null;
      if (isPunc(tokens[k], '(')) {
        const close = closing(tokens, k);
        if (close === -1) continue;
        /* a method's receiver when a name and '(' follow; otherwise these are a literal's parameters */
        if (tokens[close + 1] && tokens[close + 1].t === 'id' && isPunc(tokens[close + 2], '(')) { receiver = [k, close]; k = close + 1; }
      }
      const name = tokens[k] && tokens[k].t === 'id' ? tokens[k].v : null;
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
      const name = tokens[k] && tokens[k].t === 'id' && !isPunc(tokens[k], '(') ? tokens[k].v : null;
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
function decorationsBefore(tokens, index) {
  const parts = [];
  let depth = 0;
  for (let k = index - 1; k >= 0 && index - k < 160; k -= 1) {
    const token = tokens[k];
    if (isPunc(token, ')')) depth += 1;
    else if (isPunc(token, '(')) depth -= 1;
    else if (depth === 0 && (isPunc(token, ';') || isPunc(token, '{') || isPunc(token, '}'))) break;
    parts.unshift(token.t === 'str' ? JSON.stringify(token.v) : token.v);
  }
  /* `@ GetMapping` reads as `@GetMapping` */
  return parts.join(' ').replace(/@ /g, '@').split(' ');
}

/* A parameter list as { name, type, annotations, index }. */
function parametersOf(tokens, range, language) {
  const [open] = range;
  const { args } = argumentsOf(tokens, open);
  return args.map(([start, end], index) => {
    const slice = tokens.slice(start, end);
    const words = slice.map(t => (t.t === 'str' ? JSON.stringify(t.v) : t.v));
    let name = null;
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
      name = ids.length ? ids[ids.length - 1].v : null;
      type = ids.length > 1 ? ids[ids.length - 2].v : '';
    }
    return { name, type, text: words.join(' '), index };
  });
}

/* ---- Sources ------------------------------------------------------------------------- */

const GO_REQUEST_CALLS = table({ FormValue: 'form field', PostFormValue: 'form field', Cookie: 'cookie', PathValue: 'route parameter', FormFile: 'uploaded file', UserAgent: 'request header', Referer: 'request header' });
const GIN_CALLS = table({ Query: 'query string', DefaultQuery: 'query string', GetQuery: 'query string', QueryArray: 'query string', Param: 'route parameter', PostForm: 'form field', DefaultPostForm: 'form field', GetPostForm: 'form field', GetHeader: 'request header', Cookie: 'cookie', GetRawData: 'request body', FullPath: null });
const ECHO_CALLS = table({ QueryParam: 'query string', QueryParams: 'query string', Param: 'route parameter', FormValue: 'form field', FormParams: 'form field', Cookie: 'cookie', QueryString: 'query string' });
const FIBER_CALLS = table({ Query: 'query string', Queries: 'query string', Params: 'route parameter', FormValue: 'form field', Get: 'request header', Cookies: 'cookie', Body: 'request body', BodyRaw: 'request body', OriginalURL: 'request URL' });
const BINDERS = /^(ShouldBind\w*|Bind\w*|MustBind\w*|BodyParser|QueryParser|ParamsParser|Decode|Unmarshal)$/;
const SERVLET_CALLS = table({ getParameter: 'query string', getParameterValues: 'query string', getParameterMap: 'query string', getHeader: 'request header', getHeaders: 'request header', getQueryString: 'query string', getRequestURI: 'request URL', getRequestURL: 'request URL', getPathInfo: 'request URL', getCookies: 'cookie', getInputStream: 'request body', getReader: 'request body', getPart: 'uploaded file', getParts: 'uploaded file', getRemoteUser: null });
const SPRING_ANNOTATIONS = table({ RequestParam: 'query string', PathVariable: 'route parameter', RequestBody: 'request body', RequestHeader: 'request header', CookieValue: 'cookie', ModelAttribute: 'form field', RequestPart: 'uploaded file', MatrixVariable: 'route parameter', QueryParam: 'query string', PathParam: 'route parameter', FormParam: 'form field', HeaderParam: 'request header', CookieParam: 'cookie', BeanParam: 'request body' });
const PHP_SUPERGLOBALS = table({ $_GET: 'query string', $_POST: 'form field', $_REQUEST: 'request parameter', $_COOKIE: 'cookie', $_FILES: 'uploaded file' });
const PHP_SERVER_KEYS = /^(HTTP_\w+|QUERY_STRING|REQUEST_URI|PHP_SELF|PATH_INFO|ORIG_PATH_INFO|SCRIPT_URI|REDIRECT_URL)$/;
const LARAVEL_CALLS = table({ input: 'request parameter', get: 'request parameter', query: 'query string', post: 'form field', all: 'request body', only: 'request body', except: 'request body', route: 'route parameter', header: 'request header', cookie: 'cookie', json: 'request body', getContent: 'request body', validated: 'request body', safe: 'request body', string: 'request parameter', str: 'request parameter', collect: 'request body', file: 'uploaded file', fullUrl: 'request URL', path: 'request URL' });
const WHOLE_REQUEST = new Set(['all', 'validated', 'json', 'safe', 'collect', 'getParameterMap', 'PostForm']);

/*
 * Whether the expression starting at `index` is a request source, and what
 * kind: the roles say which parameters are a request, a Gin, Echo or Fiber
 * context, or a Laravel or Symfony request.
 */
function sourceAt(tokens, index, roles, language) {
  const token = tokens[index];
  if (!token || token.t !== 'id') return null;
  const next = tokens[index + 1];
  const accessor = next && next.t === 'punc' && (next.v === '.' || next.v === '->' || next.v === '?->') ? tokens[index + 2] : null;
  if (language === 'go') {
    if (roles.request.has(token.v) && accessor) {
      const field = accessor.v;
      if (GO_REQUEST_CALLS[field]) return { kind: GO_REQUEST_CALLS[field], end: index + 3 };
      if (field === 'URL') {
        const part = tokens[index + 4];
        if (part && (part.v === 'Query' || part.v === 'RawQuery')) return { kind: 'query string', end: index + 5 };
        if (part && (part.v === 'Path' || part.v === 'RawPath' || part.v === 'String')) return { kind: 'request URL', end: index + 5 };
      }
      if (field === 'Header' || field === 'Form' || field === 'PostForm' || field === 'MultipartForm') return { kind: field === 'Header' ? 'request header' : 'form field', end: index + 3 };
      if (field === 'Body') return { kind: 'request body', end: index + 3, whole: true };
    }
    if (roles.gin.has(token.v) && accessor && GIN_CALLS[accessor.v]) return { kind: GIN_CALLS[accessor.v], end: index + 3 };
    if (roles.echo.has(token.v) && accessor && ECHO_CALLS[accessor.v]) return { kind: ECHO_CALLS[accessor.v], end: index + 3 };
    if (roles.fiber.has(token.v) && accessor && FIBER_CALLS[accessor.v]) return { kind: FIBER_CALLS[accessor.v], end: index + 3, whole: accessor.v === 'Body' };
    /* mux.Vars(r)["id"], chi.URLParam(r, "id") */
    if ((token.v === 'mux' && accessor && accessor.v === 'Vars') || (token.v === 'chi' && accessor && (accessor.v === 'URLParam' || accessor.v === 'URLParamFromCtx'))) return { kind: 'route parameter', end: index + 3 };
    return null;
  }
  if (language === 'java') {
    if (roles.request.has(token.v) && accessor && SERVLET_CALLS[accessor.v]) return { kind: SERVLET_CALLS[accessor.v], end: index + 3, whole: accessor.v === 'getParameterMap' || accessor.v === 'getInputStream' };
    return null;
  }
  /* PHP */
  if (PHP_SUPERGLOBALS[token.v]) return { kind: PHP_SUPERGLOBALS[token.v], end: index + 1, whole: !isPunc(next, '[') };
  if (token.v === '$_SERVER' && isPunc(next, '[')) {
    const key = tokens[index + 2];
    if (key && key.t === 'str' && PHP_SERVER_KEYS.test(key.v)) return { kind: key.v.startsWith('HTTP_') ? 'request header' : 'request URL', end: index + 4 };
    return null;
  }
  if (token.v === 'file_get_contents' && isPunc(next, '(') && tokens[index + 2] && tokens[index + 2].t === 'str' && tokens[index + 2].v === 'php://input') return { kind: 'request body', end: index + 4, whole: true };
  if ((token.v === 'request' || token.v === 'Request' || token.v === 'Input') && isPunc(next, '(') && tokens[index + 2] && tokens[index + 2].t === 'str') return { kind: 'request parameter', end: index + 3 };
  if ((token.v === 'Request' || token.v === 'Input') && isPunc(next, '::') && accessor && LARAVEL_CALLS[accessor.v]) return { kind: LARAVEL_CALLS[accessor.v], end: index + 3, whole: WHOLE_REQUEST.has(accessor.v) };
  if (token.v === 'request' && isPunc(next, '(') && isPunc(tokens[index + 2], ')') && (isPunc(tokens[index + 3], '->')) && tokens[index + 4] && LARAVEL_CALLS[tokens[index + 4].v]) {
    return { kind: LARAVEL_CALLS[tokens[index + 4].v], end: index + 5, whole: WHOLE_REQUEST.has(tokens[index + 4].v) };
  }
  if (roles.request.has(token.v) && accessor) {
    /* Symfony: $request->query->get(), ->request->get(), ->headers->get(), ->cookies->get() */
    if (['query', 'request', 'headers', 'cookies', 'files', 'attributes'].includes(accessor.v) && isPunc(tokens[index + 3], '->')) {
      return { kind: accessor.v === 'headers' ? 'request header' : accessor.v === 'cookies' ? 'cookie' : accessor.v === 'files' ? 'uploaded file' : 'request parameter', end: index + 5 };
    }
    if (LARAVEL_CALLS[accessor.v]) return { kind: LARAVEL_CALLS[accessor.v], end: index + 3, whole: WHOLE_REQUEST.has(accessor.v) };
  }
  return null;
}

/* ---- Sanitisers and string shaping ------------------------------------------------ */

/* Calls whose result no longer carries what the caller wrote in a dangerous form. */
const SANITISERS = table({
  go: /^(Atoi|ParseInt|ParseUint|ParseFloat|ParseBool|Itoa|FormatInt|Base|EscapeString|QueryEscape|PathEscape|HTMLEscapeString|JSEscapeString|Parse|ParseUUID|MustParse|len|cap|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|bool|Contains|HasPrefix|HasSuffix|EqualFold|Compare|Index|Count|Match|MatchString|IsAbs|Hash|Sum256|Sum|Equal|ConstantTimeCompare|NewString|Sprint\w*Int)$/,
  java: /^(parseInt|parseLong|parseDouble|parseFloat|parseBoolean|valueOf|fromString|escapeHtml\w*|escapeXml\w*|escapeEcmaScript|escapeJava|htmlEscape\w*|encodeForHTML\w*|encodeForSQL|encodeForURL|encodeForOS|encode|getName|normalize|isValid\w*|matches|equals\w*|contains|startsWith|endsWith|length|size|isEmpty|hashCode|sanitize\w*|clean|toInt|toLong|UUID|compare\w*)$/,
  php: /^(intval|floatval|boolval|abs|round|ceil|floor|count|strlen|mb_strlen|is_numeric|is_int|ctype_digit|ctype_alnum|ctype_alpha|htmlspecialchars|htmlentities|strip_tags|e|esc_html|esc_attr|esc_url|esc_sql|sanitize_\w+|filter_var|filter_input|escapeshellarg|escapeshellcmd|basename|realpath|urlencode|rawurlencode|addslashes|mysqli_real_escape_string|real_escape_string|quote|pg_escape_string|pg_escape_literal|password_hash|hash|md5|sha1|crc32|in_array|array_key_exists|isset|empty|preg_match|str_contains|str_starts_with|uniqid|json_encode|number_format|date|strtotime|checkdate|max|min)$/
});
/* Calls that shape a string and keep carrying what went into them. */
const SHAPERS = table({
  go: /^(Sprintf|Sprint|Sprintln|Join|TrimSpace|Trim|TrimPrefix|TrimSuffix|TrimLeft|TrimRight|ToLower|ToUpper|Replace|ReplaceAll|Split|SplitN|Fields|Title|Repeat|QueryUnescape|PathUnescape|Unquote|DecodeString|string|Clean|Dir|Ext|Get|Values|Value|Query|ReadAll|NewReader|NewBufferString|Bytes|String|Errorf)$/,
  java: /^(format|formatted|concat|join|trim|strip|toLowerCase|toUpperCase|replace|replaceAll|replaceFirst|substring|split|valueOf|toString|decode|getBytes|append|get|getOrDefault|getValue|getFirst|orElse|orElseGet|stream|collect|of|asList|copyOf|resolve|getDecoder|getUrlDecoder|getMimeDecoder|ByteArrayInputStream|StringReader|InputStreamReader|BufferedReader|BufferedInputStream|InputSource|StreamSource|String|StringBuilder|StringBuffer)$/,
  php: /^(sprintf|vsprintf|implode|join|trim|ltrim|rtrim|strtolower|strtoupper|ucfirst|lcfirst|ucwords|str_replace|str_ireplace|preg_replace|substr|mb_substr|urldecode|rawurldecode|base64_decode|stripslashes|json_decode|explode|array_map|array_values|array_merge|str_pad|str_repeat|nl2br|wordwrap|strval|trans|__|dirname|pathinfo|parse_url|http_build_query|stripcslashes|html_entity_decode|htmlspecialchars_decode|str|Str)$/
});

/* ---- Sinks ---------------------------------------------------------------------------- */

const GO_SQL = /^(Query|QueryRow|Exec|QueryContext|QueryRowContext|ExecContext|Prepare|PrepareContext|Raw|Select|Get|NamedExec|NamedQuery|MustExec|Queryx|QueryRowx)$/;
const GO_SQL_RECEIVER = /^(db|DB|tx|Tx|conn|Conn|stmt|pool|sqlx|sqlDB|database|dbConn|dbx|repo|store|q|gdb|orm|client|pgx|pg|mysql|sqlite|session|s\.db|h\.db|a\.db|r\.db|app\.db|svc\.db)$/i;
const JAVA_SQL = /^(executeQuery|executeUpdate|executeLargeUpdate|addBatch|prepareStatement|prepareCall|createQuery|createNativeQuery|createSQLQuery|nativeQuery)$/;
const JAVA_SQL_GENERIC = /^(execute|query|queryForObject|queryForList|queryForMap|queryForRowSet|queryForStream|update|batchUpdate)$/;
const PHP_SQL_FUNCTIONS = table({ mysqli_query: 1, mysqli_multi_query: 1, mysqli_real_query: 1, mysql_query: 0, pg_query: -1, pg_send_query: -1, sqlite_query: -1, mssql_query: 0, odbc_exec: 1, db2_exec: 1, oci_parse: 1 });
const PHP_SQL_METHODS = /^(query|exec|prepare|multi_query|real_query|unbuffered_query|select|insert|update|delete|statement|unprepared|affectingStatement|whereRaw|orWhereRaw|selectRaw|orderByRaw|havingRaw|groupByRaw|raw|get_results|get_row|get_var|get_col|fromRaw|joinRaw|executeQuery|executeStatement|executeUpdate|fetchAllAssociative|fetchAssociative|fetchOne|fetchFirstColumn|fetchAllNumeric|fetchNumeric|fetchAllKeyValue|iterateAssociative|createQuery|createNativeQuery)$/;
const PHP_COMMANDS = new Set(['exec', 'system', 'shell_exec', 'passthru', 'popen', 'proc_open', 'pcntl_exec', 'expect_popen']);
const PHP_PATHS = new Set(['file_get_contents', 'fopen', 'readfile', 'file', 'unlink', 'file_put_contents', 'copy', 'rename', 'opendir', 'scandir', 'mkdir', 'rmdir', 'parse_ini_file', 'highlight_file', 'show_source', 'fpassthru', 'gzopen', 'simplexml_load_file', 'glob', 'is_file', 'touch', 'symlink', 'chmod']);
const SHELLS = /^(\/bin\/)?(sh|bash|zsh|cmd|cmd\.exe|powershell|pwsh)$/;
/*
 * XML parsers that resolve external entities unless told not to. A file
 * that turns them off anywhere is taken at its word: the setting usually
 * sits on the factory, a few lines from the parse.
 */
/*
 * Every pattern below runs over a whole file somebody else wrote, so none may
 * scan without bound from a prefix the file can repeat: each alternative here
 * is a literal or a bounded call, and the test is made once per file.
 */
const JAVA_XML_HARDENED = /disallow-doctype-decl|FEATURE_SECURE_PROCESSING|external-general-entities|external-parameter-entities|load-external-dtd|setExpandEntityReferences\s*\(\s*false|SUPPORT_DTD|IS_SUPPORTING_EXTERNAL_ENTITIES|ACCESS_EXTERNAL_DTD|ACCESS_EXTERNAL_SCHEMA|ACCESS_EXTERNAL_STYLESHEET/;
const hardenedFiles = new WeakMap();
function xmlHardened(file) {
  if (!hardenedFiles.has(file)) hardenedFiles.set(file, JAVA_XML_HARDENED.test(file.text));
  return hardenedFiles.get(file);
}
const JAVA_XML_PARSE = table({
  parse: /^(builder|db|documentBuilder|docBuilder|dBuilder|domBuilder|parser|saxParser|xmlReader|reader|newDocumentBuilder\(\)|newSAXParser\(\))$/i,
  unmarshal: /(unmarshaller|^um$|createUnmarshaller\(\))$/i,
  createXMLStreamReader: /./,
  createXMLEventReader: /./,
  read: /^(saxReader|reader)$/i,
  build: /^(saxBuilder|sb)$/i
});
const PHP_XML_ENTITIES = /LIBXML_(NOENT|DTDLOAD|DTDATTR)/;

/* ---- The walk --------------------------------------------------------------------------- */

const CHECK_CALL = /^(Contains|HasPrefix|HasSuffix|IsAbs|MatchString|Match|Compare|EqualFold|contains|startsWith|endsWith|matches|equals|equalsIgnoreCase|isValid\w*|validate\w*|allow\w*|in_array|preg_match|str_starts_with|str_contains|str_ends_with|array_key_exists|ctype_\w+|is_numeric|filter_var|has|containsKey|isSafe\w*|safe\w*|check\w*|verify\w*)$/;

class Walker {
  constructor(file, language, tokens, program) {
    this.file = file;
    this.path = file.path;
    this.language = language;
    this.tokens = tokens;
    this.program = program;
    this.flows = [];
    this.summary = null;
    /* Names a condition has validated, each with the token ranges where that holds, and the same as lines. */
    this.validated = new Map();
    this.settled = [];
  }

  /* A name's value at token `at`: nothing where a condition has already proved it safe. */
  read(scope, name, at) {
    const value = scope.get(name);
    if (!value) return value;
    const ranges = this.validated.get(name);
    return ranges && ranges.some(([from, to]) => at >= from && at <= to) ? null : value;
  }

  /*
   * A condition that settles a value -- a number check, an anchored pattern,
   * an allow-list, equality with literals -- makes it safe inside the block
   * it guards; the negated check before an early exit makes it safe for the
   * rest of the function. Values built from it are settled with it.
   */
  validate(conditionFrom, conditionTo, blockFrom, blockTo, scope, fnEnd) {
    const { positive, negative } = this.conditionChecks(conditionFrom, conditionTo, scope);
    const mark = (names, from, to) => {
      if (!names.size || to < from) return;
      const all = new Set(names);
      for (const [other, value] of scope) {
        if (!value || all.has(other) || !Array.isArray(value.via)) continue;
        if ([...names].some(name => value.via.includes(name))) all.add(other);
      }
      const lineAt = index => (this.tokens[Math.min(index, this.tokens.length - 1)] || { line: 0 }).line;
      for (const name of all) {
        if (!this.validated.has(name)) this.validated.set(name, []);
        this.validated.get(name).push([from, to]);
        this.settled.push({ path: this.path, name, from: lineAt(from), to: lineAt(to) });
      }
    };
    mark(positive, blockFrom, blockTo);
    if (negative.size && this.exits(blockFrom, blockTo)) mark(negative, blockTo + 1, fnEnd);
  }

  /* Whether a block leaves: a return, a throw, an exit, a die, an abort. */
  exits(from, to) {
    for (let k = from; k <= to && k < this.tokens.length; k += 1) {
      const token = this.tokens[k];
      if (token.t === 'id' && /^(return|throw|exit|die|abort|continue|break|panic|http\.Error)$/.test(token.v)) return true;
      if (token.t === 'id' && /^(abort|abort_if|abort_unless)$/.test(token.v)) return true;
    }
    return false;
  }

  /* The names a condition validates when it holds (positive) and when it fails (negative). */
  conditionChecks(from, to, scope) {
    const tokens = this.tokens;
    const positive = new Set();
    const negative = new Set();
    const split = (start, stop) => {
      const parts = [];
      const ops = new Set();
      let depth = 0;
      let at = start;
      for (let k = start; k < stop; k += 1) {
        const t = tokens[k];
        if (isPunc(t, '(') || isPunc(t, '[')) depth += 1;
        else if (isPunc(t, ')') || isPunc(t, ']')) depth -= 1;
        else if (depth === 0 && (isPunc(t, '&&') || isPunc(t, '||') || isWord(t, 'and') || isWord(t, 'or'))) {
          parts.push([at, k]);
          ops.add(t.v === 'and' ? '&&' : t.v === 'or' ? '||' : t.v);
          at = k + 1;
        }
      }
      parts.push([at, stop]);
      return { parts, ops };
    };
    const strip = (start, stop) => {
      while (isPunc(tokens[start], '(') && closing(tokens, start) === stop - 1) { start += 1; stop -= 1; }
      return [start, stop];
    };
    const tainted = (start, stop) => {
      for (let k = start; k < stop; k += 1) if (tokens[k].t === 'id' && scope.get(tokens[k].v)) return tokens[k].v;
      return null;
    };
    /* one test: { name, negated } or null */
    const atom = (start, stop) => {
      [start, stop] = strip(start, stop);
      let negated = false;
      while (isPunc(tokens[start], '!')) { negated = !negated; start += 1; [start, stop] = strip(start, stop); }
      /* equality with a literal: $x == 'a', 'a' === strtolower($x), x == "a", "a".equals(x) */
      let depth = 0;
      for (let k = start; k < stop; k += 1) {
        const t = tokens[k];
        if (isPunc(t, '(') || isPunc(t, '[')) depth += 1;
        else if (isPunc(t, ')') || isPunc(t, ']')) depth -= 1;
        else if (depth === 0 && t.t === 'punc' && ['==', '===', '!=', '!=='].includes(t.v)) {
          const left = [start, k];
          const right = [k + 1, stop];
          const literalSide = [left, right].find(([a, b]) => b - a === 1 && (tokens[a].t === 'str' || tokens[a].t === 'num'));
          if (!literalSide) return null;
          const other = literalSide === left ? right : left;
          const name = tainted(other[0], other[1]);
          return name ? { name, negated: negated !== (t.v === '!=' || t.v === '!==') } : null;
        }
      }
      /* "lit".equals(x) */
      if (this.language === 'java' && tokens[start].t === 'str' && isPunc(tokens[start + 1], '.') && /^(equals|equalsIgnoreCase)$/.test(tokens[start + 2] && tokens[start + 2].v) && isPunc(tokens[start + 3], '(')) {
        const name = tainted(start + 4, closing(tokens, start + 3));
        return name ? { name, negated } : null;
      }
      /* a validating call */
      for (let k = start; k < stop; k += 1) {
        if (tokens[k].t !== 'id' || !isPunc(tokens[k + 1], '(')) continue;
        const callee = calleeAt(tokens, k + 1);
        const name = (callee.name || '').replace(/\(\)$/, '');
        const close = closing(tokens, k + 1);
        if (close === -1) return null;
        const { args } = argumentsOf(tokens, k + 1);
        const argName = args.length ? args.map(([a, b]) => tainted(a, b)).find(Boolean) || null : null;
        const receiver = callee.segments.length > 1 && scope.get(callee.segments[0]) ? callee.segments[0] : null;
        const validated = this.validatorOf(name, args, argName, receiver);
        return validated ? { name: validated, negated } : null;
      }
      return null;
    };
    const { parts, ops } = split(from, to);
    if (ops.size <= 1) {
      const or = ops.has('||');
      const tests = parts.map(([a, b]) => {
        const [s1, s2] = strip(a, b);
        const inner = split(s1, s2);
        /* a bracketed disjunction of equalities with the same name: (x == 'a' || x == 'b') */
        if (inner.parts.length > 1 && inner.ops.size === 1 && inner.ops.has('||')) {
          const each = inner.parts.map(([c, d]) => atom(c, d));
          if (each.every(test => test && !test.negated && test.name === each[0].name)) return { name: each[0].name, negated: false };
          return null;
        }
        return atom(a, b);
      });
      if (!or) {
        /* every conjunct holds inside the block; a single negated test fails into the exit */
        for (const test of tests) if (test && !test.negated) positive.add(test.name);
        if (tests.length === 1 && tests[0] && tests[0].negated) negative.add(tests[0].name);
        /* x != 'a' && x != 'b' before an exit: past it, x is one of them */
        if (tests.length > 1 && tests.every(test => test && test.negated && test.name === tests[0].name)) negative.add(tests[0].name);
      } else {
        /* x == 'a' || x == 'b': the one name, inside; !a(x) || !b(y): both, after the exit */
        if (tests.every(test => test && !test.negated && test.name === tests[0].name)) positive.add(tests[0].name);
        if (tests.every(test => test && test.negated)) for (const test of tests) negative.add(test.name);
      }
    }
    return { positive, negative };
  }

  /* Which name a call validates, if it is a check that settles a value's shape. */
  validatorOf(name, args, argName, receiver) {
    const tokens = this.tokens;
    const firstString = args[0] && args[0][1] - args[0][0] === 1 && tokens[args[0][0]].t === 'str' ? tokens[args[0][0]].v : null;
    if (this.language === 'php') {
      if (/^(is_numeric|is_int|is_integer|is_float|ctype_digit|ctype_alnum|ctype_alpha|ctype_xdigit|ctype_upper|ctype_lower|in_array|checkdate|isUuid|isUlid)$/.test(name)) return argName;
      if (name === 'array_key_exists' || name === 'isset') return null;
      if (name === 'preg_match' && firstString && /^(.)\^[\s\S]*\$\1[a-zA-Z]*$|^(.)\^[\s\S]*\\z\2[a-zA-Z]*$/.test(firstString)) return argName;
      if (name === 'filter_var' && args.slice(1).some(([a, b]) => tokens.slice(a, b).some(t => /^FILTER_VALIDATE_(INT|FLOAT|IP|EMAIL|BOOL|BOOLEAN|MAC)$/.test(t.v)))) return argName;
      return null;
    }
    if (this.language === 'java') {
      /* whole-string matches, and membership in an allow-list */
      if (name === 'matches' && receiver) return receiver;
      if ((name === 'equals' || name === 'equalsIgnoreCase') && (receiver || argName)) {
        const other = receiver ? args[0] : null;
        if (receiver && other && other[1] - other[0] === 1 && tokens[other[0]].t === 'str') return receiver;
        return null;
      }
      if (/^(contains|containsKey|isNumeric|isDigits|isAlphanumeric|isAlpha|isCreatable|isParsable)$/.test(name) && argName && !receiver) return argName;
      if (name === 'matches' && argName) return argName;
      return null;
    }
    /* Go: slices.Contains(allowed, x), a map lookup's ok comes as an assignment and is not read here */
    if (name === 'Contains' && args.length === 2 && argName && tokens[args[1][0]] && tokens[args[1][0]].v === argName && !scope_of_first(args, tokens)) return argName;
    return null;
  }

  /* Roles of a function's parameters, and the values they start with. */
  enter(fn, scope, summaryMode) {
    const roles = { request: new Set(), writer: new Set(), gin: new Set(), echo: new Set(), fiber: new Set(), response: new Set() };
    const params = parametersOf(this.tokens, fn.params, this.language);
    /* Go lists `a, b string`: a bare name takes the next parameter's type. */
    if (this.language === 'go') {
      for (let k = params.length - 2; k >= 0; k -= 1) if (!params[k].type && params[k + 1].type) params[k].type = params[k + 1].type;
    }
    const decorations = fn.decorations.join(' ');
    params.forEach(param => {
      if (!param.name) return;
      let value = null;
      const type = param.type;
      if (this.language === 'go') {
        if (/\*?(http|fasthttp)\.Request\b|\*?http\.Request$/.test(type)) roles.request.add(param.name);
        else if (/http\.ResponseWriter/.test(type)) roles.writer.add(param.name);
        else if (/\*?gin\.Context/.test(type)) roles.gin.add(param.name);
        else if (/echo\.Context/.test(type)) roles.echo.add(param.name);
        else if (/\*?fiber\.Ctx/.test(type)) roles.fiber.add(param.name);
      } else if (this.language === 'java') {
        const annotation = /@\s*(\w+)/.exec(param.text);
        if (annotation && SPRING_ANNOTATIONS[annotation[1]]) value = taint(SPRING_ANNOTATIONS[annotation[1]], this.path, fn.line, `a ${SPRING_ANNOTATIONS[annotation[1]]} enters here`);
        if (/\b(HttpServletRequest|ServletRequest|WebRequest|ServerHttpRequest)\b/.test(param.text)) roles.request.add(param.name);
        if (/\b(HttpServletResponse|ServletResponse)\b/.test(param.text)) roles.response.add(param.name);
        if (value && annotation && annotation[1] === 'RequestBody') value.whole = true;
      } else if (this.language === 'php') {
        if (/\b(Request|ServerRequestInterface|FormRequest|\w+Request)\b/.test(type) || (!type && param.name === '$request')) roles.request.add(param.name);
      }
      if (summaryMode && summaryMode.index === param.index) value = { ...taint('parameter', this.path, fn.line, 'a parameter'), param: param.index };
      scope.set(param.name, value);
    });
    /* A route file's closure: its parameters are the route's own. */
    if (this.language === 'php' && !fn.name && /(^|\/)routes\/[\w.-]+\.php$/.test(this.path)) {
      params.forEach(param => {
        if (param.name && !roles.request.has(param.name) && !scope.get(param.name)) scope.set(param.name, taint('route parameter', this.path, fn.line, 'a route parameter enters here'));
      });
    }
    /* A Laravel controller method's route parameters: a scalar parameter of a public method in a controller. */
    if (this.language === 'php' && /Controller\.php$/.test(this.path) && /\bpublic\b/.test(decorations)) {
      params.forEach(param => {
        if (param.name && !roles.request.has(param.name) && (!param.type || /^(int|string|\?string|\?int|mixed)$/.test(param.type)) && !scope.get(param.name)) {
          scope.set(param.name, { ...taint('route parameter', this.path, fn.line, 'a route parameter enters here'), weakRoute: true });
        }
      });
    }
    return { roles, params };
  }

  /* The value of tokens [from, to). */
  evaluate(from, to, scope, roles) {
    const tokens = this.tokens;
    let value = null;
    let literal = '';
    let built = false;
    let leadLiteral = null;
    let seenOperand = false;
    let comparison = false;
    for (let k = from; k < to; k += 1) {
      const token = tokens[k];
      if (!token) break;
      if (token.t === 'punc') {
        if (['==', '!=', '===', '!==', '<', '>', '<=', '>=', '&&', '||', '!', '<=>', 'instanceof'].includes(token.v)) comparison = true;
        if (token.v === '+' || (this.language === 'php' && token.v === '.') || token.v === '.=' || token.v === '+=') built = true;
        continue;
      }
      if (token.t === 'str' || token.t === 'shell') {
        literal += token.v;
        if (!seenOperand) leadLiteral = token.v;
        seenOperand = true;
        if (token.interp && token.interp.length) {
          for (const name of token.interp) {
            const inner = this.read(scope, name, k);
            if (inner) { value = merge(value, extend(inner, this.path, token.line, 'written into a string')); built = true; }
            if (/^\$_(GET|POST|REQUEST|COOKIE)$/.test(name)) { value = merge(value, taint(PHP_SUPERGLOBALS[name], this.path, token.line)); built = true; }
          }
        }
        continue;
      }
      if (token.t !== 'id') { seenOperand = true; continue; }
      /* PHP casts: (int)$x */
      if (this.language !== 'go' && /^(int|integer|float|double|bool|boolean|long|short)$/.test(token.v) && isPunc(tokens[k - 1], '(') && isPunc(tokens[k + 1], ')')) {
        const skip = this.operandEnd(k + 2, to);
        k = skip - 1;
        seenOperand = true;
        continue;
      }
      const source = sourceAt(tokens, k, roles, this.language);
      if (source) {
        if (source.kind) {
          const fresh = taint(source.kind, this.path, token.line, `a ${source.kind} enters here`);
          fresh.whole = Boolean(source.whole);
          value = merge(value, fresh);
        }
        seenOperand = true;
        k = this.skipCall(source.end, to) - 1;
        continue;
      }
      /* A call: sanitiser, shaper, helper or unknown. */
      const callOpen = this.callOpenAfter(k, to);
      if (callOpen !== -1) {
        const callee = calleeAt(tokens, callOpen);
        const close = closing(tokens, callOpen);
        if (close === -1) break;
        const name = callee.name ? callee.name.replace(/\(\)$/, '') : '';
        if (SANITISERS[this.language].test(name)) { k = close; seenOperand = true; continue; }
        const argsValue = this.evaluateArgs(callOpen, scope, roles);
        const receiverValue = callee.segments.length > 1 ? this.read(scope, callee.segments[0], k) || null : null;
        if (SHAPERS[this.language].test(name)) {
          const carried = merge(argsValue.value, receiverValue ? extend(receiverValue, this.path, token.line, `passed through ${name}`) : null);
          if (carried) value = merge(value, { ...carried, built: carried.built || /^(Sprintf|format|formatted|sprintf|vsprintf|concat|Join|join|implode|append)$/.test(name) });
          if (argsValue.literal) literal += argsValue.literal;
          if (!seenOperand && argsValue.literal) leadLiteral = argsValue.literalLead;
          if (/^(Sprintf|format|formatted|sprintf|vsprintf)$/.test(name)) built = true;
        } else {
          const helper = this.program ? this.program.helper(this.language, name, callee, this.path) : null;
          if (helper && helper.returns.size) {
            for (const index of helper.returns) {
              const arg = argsValue.each[index];
              if (arg) value = merge(value, extend(arg, this.path, token.line, `returned by ${name}`));
            }
          }
          /* a request object's own fields: dto.getName(), form.Name(), $input->name() */
          if (receiverValue && receiverValue.whole && /^(get[A-Z]\w*|is[A-Z]\w*|[A-Z]\w*)$/.test(name)) value = merge(value, extend(receiverValue, this.path, token.line, `read from ${callee.segments[0]}`));
        }
        seenOperand = true;
        k = close;
        continue;
      }
      /* A name. */
      const known = this.read(scope, token.v, k);
      if (known) {
        value = merge(value, known);
        if (!seenOperand) leadLiteral = null;
      }
      seenOperand = true;
      /* skip a member chain on the same operand: user.Name, $row['x'] */
      while (tokens[k + 1] && tokens[k + 1].t === 'punc' && (tokens[k + 1].v === '.' || tokens[k + 1].v === '->' || tokens[k + 1].v === '?->') && tokens[k + 2] && tokens[k + 2].t === 'id' && !isPunc(tokens[k + 3], '(')) {
        if (this.language === 'php' && tokens[k + 1].v === '.') break;
        k += 2;
      }
    }
    if (!value || comparison) return null;
    return { ...value, built: value.built || built, sql: value.sql || SQL_WORDS.test(literal), html: value.html || HTML_TEXT.test(literal), lead: leadLiteral !== null ? leadLiteral : value.lead };
  }

  /* Each argument's value and the literal text among them. */
  evaluateArgs(open, scope, roles) {
    const { args } = argumentsOf(this.tokens, open);
    const each = args.map(([start, end]) => this.evaluate(start, end, scope, roles));
    let value = null;
    each.forEach(item => { value = merge(value, item); });
    let literal = '';
    let literalLead = null;
    args.forEach(([start, end], index) => {
      for (let k = start; k < end; k += 1) if (this.tokens[k].t === 'str') { literal += this.tokens[k].v; if (index === 0 && literalLead === null && k === start) literalLead = this.tokens[k].v; }
    });
    return { value, each, literal, literalLead };
  }

  /* The '(' of a call whose callee starts at `k`, or -1. */
  callOpenAfter(k, to) {
    let m = k;
    while (m + 1 < to) {
      const next = this.tokens[m + 1];
      if (isPunc(next, '(')) return m + 1;
      if (next.t === 'punc' && (next.v === '.' || next.v === '->' || next.v === '::' || next.v === '?->') && this.tokens[m + 2] && this.tokens[m + 2].t === 'id') { m += 2; continue; }
      return -1;
    }
    return -1;
  }

  /* Past a source's own call and any calls chained on it. */
  skipCall(k, to) {
    let m = k;
    while (m < to) {
      const token = this.tokens[m];
      if (isPunc(token, '(') || isPunc(token, '[')) { const close = closing(this.tokens, m); if (close === -1) return to; m = close + 1; continue; }
      if (token && token.t === 'punc' && (token.v === '.' || token.v === '->' || token.v === '?->') && this.tokens[m + 1] && this.tokens[m + 1].t === 'id') { m += 2; continue; }
      break;
    }
    return m;
  }

  operandEnd(k, to) {
    let m = k;
    if (this.tokens[m] && this.tokens[m].t === 'id') m += 1;
    return this.skipCall(m, to);
  }

  /* End of the statement starting at `k`: the ';' or the line's end in Go. */
  statementEnd(k, end) {
    let depth = 0;
    const line = this.tokens[k] ? this.tokens[k].line : 0;
    for (let m = k; m < end; m += 1) {
      const token = this.tokens[m];
      if (token.t === 'punc' && (token.v === '(' || token.v === '[' || token.v === '{')) depth += 1;
      else if (token.t === 'punc' && (token.v === ')' || token.v === ']' || token.v === '}')) { if (depth === 0) return m; depth -= 1; }
      else if (depth === 0 && isPunc(token, ';')) return m;
      else if (this.language === 'go' && depth === 0 && token.line !== line && m > k) {
        /* Go ends a statement at a line break unless the line ends mid-expression */
        const previous = this.tokens[m - 1];
        if (!(previous.t === 'punc' && ['+', '-', '*', '/', ',', '(', '.', '&&', '||', '=', ':=', '{', '['].includes(previous.v))) return m;
      }
    }
    return end;
  }

  /* A function body: assignments, guards, sinks and the functions inside it. */
  walk(fn, scope, roles, nested) {
    const [open, close] = fn.body;
    this.walkRange(fn.arrow ? open + 1 : open + 1, close, scope, roles, nested, new Map(), fn);
  }

  /*
   * Statements in [from, to), into every block: an if, a loop, a switch, a
   * try, each branch read in turn with one scope, so what any branch assigns
   * is followed after it. A function inside is walked on its own with the
   * scope it closes over; one marked skipOnly is stepped over.
   */
  walkRange(from, to, scope, roles, nested, guards, fn) {
    const tokens = this.tokens;
    const saved = this.currentScope;
    this.currentScope = scope;
    let k = from;
    try {
      while (k < to) {
        const token = tokens[k];
        const inner = nested.get(k);
        if (inner) {
          if (!inner.skipOnly) {
            const childScope = new Map(scope);
            const { roles: childRoles } = this.enter(inner, childScope, null);
            for (const key of Object.keys(roles)) for (const name of roles[key]) childRoles[key].add(name);
            this.walkRange(inner.body[0] + 1, inner.body[1], childScope, childRoles, nested, new Map(guards), inner);
            this.currentScope = scope;
          }
          k = inner.body[1] + 1;
          continue;
        }
        if (token.t === 'punc' && (token.v === '{' || token.v === '}' || token.v === ';' || token.v === ':')) { k += 1; continue; }
        /* Java's try-with-resources: `try (Connection c = ds.getConnection(); ...) {` declares what the block reads */
        if (isWord(token, 'try') && isPunc(tokens[k + 1], '(')) {
          const close = closing(tokens, k + 1);
          if (close === -1 || close > to) { k += 1; continue; }
          this.walkRange(k + 2, close, scope, roles, nested, guards, fn);
          this.currentScope = scope;
          k = close + 1;
          continue;
        }
        if (token.t === 'id' && /^(else|try|finally|do|default)$/.test(token.v)) { k += 1; continue; }
        if (isWord(token, 'case')) { let m = k + 1; while (m < to && !isPunc(tokens[m], ':')) m += 1; k = m + 1; continue; }
        if (isWord(token, 'class') || isWord(token, 'interface') || isWord(token, 'trait') || isWord(token, 'enum')) {
          let m = k;
          while (m < to && !isPunc(tokens[m], '{')) m += 1;
          const end = m < to ? closing(tokens, m) : -1;
          k = end === -1 ? to : end + 1;
          continue;
        }
        if (token.t === 'id' && /^(if|elseif|while|for|foreach|switch|catch|synchronized|select|range)$/.test(token.v)) {
          k = this.header(k, to, scope, roles, guards, fn);
          continue;
        }
        const assigned = this.assignment(k, to);
        if (assigned) {
          this.assign(assigned, scope, roles, guards, fn);
          this.innerFunctions(k, assigned.valueEnd, scope, roles, nested, guards);
          k = assigned.valueEnd;
          continue;
        }
        const end = this.statementEnd(k, to);
        if (end > k) {
          this.statement(k, end, scope, roles, guards, fn);
          this.binders(k, end, scope, roles);
          this.innerFunctions(k, end, scope, roles, nested, guards);
          /* Go ends a statement at a line break: the next statement starts at `end` itself */
          k = isPunc(tokens[end], ';') ? end + 1 : end;
          continue;
        }
        k += 1;
      }
    } finally {
      this.currentScope = saved;
    }
  }

  /* Functions written inside a statement -- a handler passed inline -- walked with the scope they close over. */
  innerFunctions(from, to, scope, roles, nested, guards) {
    for (const [start, inner] of nested) {
      if (start <= from || start >= to || inner.skipOnly || inner.walked) continue;
      inner.walked = true;
      const childScope = new Map(scope);
      const { roles: childRoles } = this.enter(inner, childScope, null);
      for (const key of Object.keys(roles)) for (const name of roles[key]) childRoles[key].add(name);
      this.walkRange(inner.body[0] + 1, inner.body[1], childScope, childRoles, nested, new Map(guards), inner);
      this.currentScope = scope;
    }
  }

  assign(assigned, scope, roles, guards, fn) {
    const { names, valueStart, valueEnd, append } = assigned;
    const tokens = this.tokens;
    const value = this.evaluate(valueStart, valueEnd, scope, roles);
    this.sinksIn(valueStart, valueEnd, scope, roles, guards, fn);
    const line = tokens[valueStart] ? tokens[valueStart].line : tokens[valueEnd - 1] ? tokens[valueEnd - 1].line : 0;
    for (const name of names) {
      if (name === '_') continue;
      /* a new value is not the one the condition checked */
      const ranges = this.validated.get(name);
      if (ranges && !append) for (const range of ranges) if (valueStart >= range[0] && valueStart <= range[1]) range[1] = valueStart - 1;
      const previous = append ? this.read(scope, name, valueStart) : null;
      /* `via`: the names a value was held in on its way here, so a check on one settles what was built from it */
      scope.set(name, merge(previous, value ? { ...extend(value, this.path, line, `assigned to ${name}`), via: [...(value.via || []), name].slice(-12) } : null));
    }
    this.binders(valueStart, valueEnd, scope, roles);
  }

  /*
   * The head of a control statement: a condition's checks are guards, a
   * loop over a request value binds its variables, and the walk continues
   * at the block.
   */
  header(k, to, scope, roles, guards, fn) {
    const tokens = this.tokens;
    const keyword = tokens[k].v;
    if (this.language !== 'go' && isPunc(tokens[k + 1], '(')) {
      const close = closing(tokens, k + 1);
      if (close === -1) return to;
      if (keyword === 'if' || keyword === 'elseif' || keyword === 'while') this.noteGuards(k + 1, close, scope, guards);
      if (keyword === 'if' || keyword === 'elseif') {
        /* the block it guards: braces, or the one statement that follows */
        const blockEnd = isPunc(tokens[close + 1], '{') ? closing(tokens, close + 1) : this.statementEnd(close + 1, to);
        if (blockEnd !== -1) this.validate(k + 2, close, close + 1, blockEnd, scope, fn && fn.body ? fn.body[1] : to);
      }
      /* foreach ($items as $k => $v) and for (Type v : items) */
      const asAt = tokens.slice(k + 2, close).findIndex(t => isWord(t, 'as'));
      if (keyword === 'foreach' && asAt !== -1) {
        const split = k + 2 + asAt;
        const value = this.evaluate(k + 2, split, scope, roles);
        for (let m = split + 1; m < close; m += 1) if (tokens[m].t === 'id' && tokens[m].v.startsWith('$')) scope.set(tokens[m].v, value ? extend(value, this.path, tokens[m].line, `each item as ${tokens[m].v}`) : null);
      }
      const colonAt = keyword === 'for' ? tokens.slice(k + 2, close).findIndex(t => isPunc(t, ':')) : -1;
      if (colonAt > 0) {
        const split = k + 2 + colonAt;
        const variable = tokens[split - 1];
        const value = this.evaluate(split + 1, close, scope, roles);
        if (variable && variable.t === 'id') scope.set(variable.v, value ? extend(value, this.path, variable.line, `each item as ${variable.v}`) : null);
      }
      /* a classic for (init; cond; step) holds assignments */
      if (keyword === 'for' && colonAt <= 0) {
        const assigned = this.assignment(k + 2, close);
        if (assigned) this.assign({ ...assigned, valueEnd: Math.min(assigned.valueEnd, close) }, scope, roles, guards, fn);
      }
      this.sinksIn(k + 2, close, scope, roles, guards, fn);
      return close + 1;
    }
    /* Go: `if init; cond {`, `for k, v := range items {`, `switch x := y.(type) {` */
    let brace = k + 1;
    let depth = 0;
    for (; brace < to; brace += 1) {
      const t = tokens[brace];
      if (isPunc(t, '(') || isPunc(t, '[')) depth += 1;
      else if (isPunc(t, ')') || isPunc(t, ']')) depth -= 1;
      else if (depth === 0 && isPunc(t, '{')) {
        /* a composite literal in the header, `if x == (T{})`, is rare; the first brace opens the block */
        break;
      }
    }
    const semicolon = tokens.slice(k + 1, brace).findIndex(t => isPunc(t, ';'));
    const initEnd = semicolon === -1 ? k + 1 : k + 1 + semicolon;
    if (semicolon !== -1 || keyword === 'for') {
      const assigned = this.assignment(k + 1, semicolon === -1 ? brace : initEnd);
      if (assigned) this.assign({ ...assigned, valueEnd: Math.min(assigned.valueEnd, semicolon === -1 ? brace : initEnd) }, scope, roles, guards, fn);
    }
    if (keyword === 'if') {
      this.noteGuards(semicolon === -1 ? k + 1 : initEnd + 1, brace, scope, guards);
      const blockEnd = brace < to ? closing(tokens, brace) : -1;
      if (blockEnd !== -1) this.validate(semicolon === -1 ? k + 1 : initEnd + 1, brace, brace, blockEnd, scope, fn && fn.body ? fn.body[1] : to);
    }
    this.sinksIn(k + 1, brace, scope, roles, guards, fn);
    return brace;
  }

  /* `x := e`, `x = e`, `var x T = e`, `T x = e`, `$x = e`, `$x .= e`, `a, b := e`, `$x['k'] = e`. */
  assignment(k, close) {
    const tokens = this.tokens;
    let m = k;
    const names = [];
    if (isWord(tokens[m], 'var') || isWord(tokens[m], 'final') || isWord(tokens[m], 'const')) m += 1;
    const startName = m;
    while (m < close) {
      const token = tokens[m];
      if (token.t === 'id') {
        names.push(token.v);
        m += 1;
        /* PHP $x['k'] or Go x[k] as the target */
        if (isPunc(tokens[m], '[')) { const c = closing(tokens, m); if (c === -1) return null; m = c + 1; }
        /* Java/Go declared type between name and '=' is skipped: `String q =` has the type first */
        if (tokens[m] && tokens[m].t === 'id') { names.pop(); continue; }
        if (tokens[m] && tokens[m].t === 'punc' && tokens[m].v === '<') {
          /* a generic type: List<String> x = */
          let depth = 0;
          for (; m < close; m += 1) { if (isPunc(tokens[m], '<')) depth += 1; else if (isPunc(tokens[m], '>')) { depth -= 1; if (depth === 0) { m += 1; break; } } }
          names.pop();
          continue;
        }
        if (isPunc(tokens[m], ',')) { m += 1; continue; }
        break;
      }
      break;
    }
    if (!names.length || m === startName) return null;
    const op = tokens[m];
    if (!op || op.t !== 'punc' || !['=', ':=', '.=', '+=', '??='].includes(op.v)) return null;
    /* not a comparison or an arrow */
    if (isPunc(tokens[m + 1], '=') || isPunc(tokens[m + 1], '>')) return null;
    const valueStart = m + 1;
    const valueEnd = this.statementEnd(valueStart, close);
    return { names, valueStart, valueEnd, append: op.v === '.=' || op.v === '+=' || op.v === '??=' };
  }

  /* json.NewDecoder(r.Body).Decode(&x), c.ShouldBindJSON(&x), $x populated by a binder */
  binders(from, to, scope, roles) {
    const tokens = this.tokens;
    for (let k = from; k < to; k += 1) {
      if (!isPunc(tokens[k], '(')) continue;
      const callee = calleeAt(tokens, k);
      const name = callee.name ? callee.name.replace(/\(\)$/, '') : '';
      if (!BINDERS.test(name)) continue;
      const { args } = argumentsOf(tokens, k);
      let origin = null;
      if (name === 'Unmarshal' && args[0]) origin = this.evaluate(args[0][0], args[0][1], scope, roles);
      else if (name === 'Decode') {
        const chain = callee.segments.join('.');
        const decoder = /NewDecoder\(\)/.test(chain) ? this.decoderSource(k) : null;
        origin = decoder;
      } else {
        const receiver = callee.segments[0];
        if (roles.gin.has(receiver) || roles.echo.has(receiver) || roles.fiber.has(receiver)) origin = taint('request body', this.path, tokens[k].line, 'a request body enters here');
      }
      if (!origin) continue;
      for (const [start, end] of args) {
        if (isPunc(tokens[start], '&') && tokens[start + 1] && tokens[start + 1].t === 'id' && end === start + 2) {
          scope.set(tokens[start + 1].v, extend({ ...origin, whole: true }, this.path, tokens[k].line, `decoded into ${tokens[start + 1].v}`));
        }
      }
    }
  }

  /* The source a json.NewDecoder(...) reads. */
  decoderSource(decodeOpen) {
    const tokens = this.tokens;
    for (let k = decodeOpen - 1; k >= Math.max(0, decodeOpen - 30); k -= 1) {
      if (isWord(tokens[k], 'NewDecoder') && isPunc(tokens[k + 1], '(')) {
        const arg = tokens[k + 2];
        const field = tokens[k + 4];
        if (arg && field && field.v === 'Body') return taint('request body', this.path, tokens[k].line, 'a request body enters here');
      }
    }
    return null;
  }

  noteGuards(start, stop, scope, guards) {
    const tokens = this.tokens;
    for (let k = start; k < stop; k += 1) {
      const token = tokens[k];
      if (token.t !== 'id' || !isPunc(tokens[k + 1], '(')) continue;
      const callee = calleeAt(tokens, k + 1);
      const name = (callee.name || '').replace(/\(\)$/, '');
      if (!CHECK_CALL.test(name)) continue;
      const close = closing(tokens, k + 1);
      const names = new Set();
      for (let m = k + 2; m < close; m += 1) if (tokens[m].t === 'id' && scope.get(tokens[m].v)) names.add(tokens[m].v);
      for (const segment of callee.segments) if (scope.get(segment)) names.add(segment);
      for (const name2 of names) if (!guards.has(name2)) guards.set(name2, { path: this.path, line: token.line });
    }
  }

  /* A statement that is not an assignment: calls, echo, include, return. */
  statement(from, to, scope, roles, guards, fn) {
    const tokens = this.tokens;
    const first = tokens[from];
    if (this.language === 'php' && first && first.t === 'id' && ['echo', 'print'].includes(first.v)) {
      const value = this.evaluate(from + 1, to, scope, roles);
      if (value) this.report('html', value, first.line, guards, from + 1, to);
    }
    if (this.language === 'php' && first && first.t === 'id' && ['include', 'require', 'include_once', 'require_once'].includes(first.v)) {
      const value = this.evaluate(from + 1, to, scope, roles);
      if (value) this.report('code', value, first.line, guards, from + 1, to);
    }
    if (first && isWord(first, 'return')) {
      const value = this.evaluate(from + 1, to, scope, roles);
      if (value && this.summary && Number.isInteger(value.param)) this.summary.returns.add(value.param);
      /* Spring: return "redirect:" + x; a @ResponseBody string of HTML */
      if (value && this.language === 'java') {
        const literal = tokens[from + 1] && tokens[from + 1].t === 'str' ? tokens[from + 1].v : '';
        if (/^redirect:/.test(literal) && literal.length <= 'redirect:'.length) this.report('redirect', { ...value, lead: null }, first.line, guards, from + 1, to);
        else if (value.html && /\b(RestController|ResponseBody)\b/.test(`${fn.decorations.join(' ')} ${this.classDecorations(fn)}`)) this.report('html', value, first.line, guards, from + 1, to);
      }
    }
    this.sinksIn(from, to, scope, roles, guards, fn);
  }

  classDecorations(fn) {
    return this.program ? this.program.classAnnotations(this.path, fn.body[0]) : '';
  }

  /* Every call in [from, to) checked against the sinks. */
  sinksIn(from, to, scope, roles, guards, fn) {
    const tokens = this.tokens;
    for (let k = from; k < to; k += 1) {
      if (tokens[k].t === 'shell' && tokens[k].interp && tokens[k].interp.some(name => scope.get(name))) {
        const value = this.evaluate(k, k + 1, scope, roles);
        if (value) this.report('command', value, tokens[k].line, guards, k, k + 1);
      }
      if (!isPunc(tokens[k], '(')) continue;
      const callee = calleeAt(tokens, k);
      if (!callee.name) continue;
      const { args, close } = argumentsOf(tokens, k);
      this.sinkCall(callee, args, k, scope, roles, guards, fn);
      /* same-codebase helpers that pass a parameter to a sink */
      const helperName = callee.name.replace(/\(\)$/, '');
      const helper = this.program ? this.program.helper(this.language, helperName, callee, this.path) : null;
      if (helper && helper.sinks.length) {
        for (const sink of helper.sinks) {
          const arg = args[sink.param];
          if (!arg) continue;
          const value = this.evaluate(arg[0], arg[1], scope, roles);
          if (!value) continue;
          const through = extend(value, this.path, tokens[k].line, `passed to ${helperName}`);
          const flags = { built: Boolean(through.built || sink.flags.built), sql: Boolean(through.sql || sink.flags.sql), html: Boolean(through.html || sink.flags.html) };
          /* a sink that needs a built string: the caller's value must be one, or carry the need on */
          const unmet = sink.requires === 'built' && !(through.built || through.sql || through.whole);
          if (unmet && !(this.summary && through.kind === 'parameter')) continue;
          /* A helper of a helper: this function's parameter reaches the sink too, through the call. */
          if (this.summary && through.kind === 'parameter' && through.param !== undefined && through.param !== null) {
            if (this.summary.sinks.length < 8) this.summary.sinks.push({ kind: sink.kind, param: through.param, path: sink.path, line: sink.line, steps: [{ path: this.path, line: tokens[k].line, role: 'propagation', note: `passed to ${helperName}` }, ...sink.steps].slice(0, MAX_STEPS - 1), flags, requires: unmet ? 'built' : null });
            continue;
          }
          this.pushFlow(sink.kind, { ...through, ...flags, steps: [...through.steps, ...sink.steps].slice(0, MAX_STEPS) }, sink.path, sink.line, guards.get(this.firstName(arg[0], arg[1], scope)) || null, helper.file === this.path ? 'function' : 'file');
        }
      }
      if (close > k) continue;
    }
  }

  firstName(from, to, scope) {
    for (let k = from; k < to; k += 1) {
      const token = this.tokens[k];
      if (token.t === 'id' && scope.get(token.v)) return token.v;
      /* "... $name ..." names its variable inside the string */
      if (token.interp) for (const name of token.interp) if (scope.get(name)) return name;
    }
    return null;
  }

  arg(args, index, scope, roles) {
    const range = args[index];
    return range ? this.evaluate(range[0], range[1], scope, roles) : null;
  }

  /* The sinks of each language. */
  sinkCall(callee, args, open, scope, roles, guards, fn) {
    const name = callee.name.replace(/\(\)$/, '');
    const receiver = callee.receiver ? callee.receiver.replace(/\(\)$/, '') : null;
    const line = this.tokens[open].line;
    const text = callee.segments.join('.');
    const report = (kind, index, patch) => {
      const range = args[index];
      if (!range) return;
      const value = this.evaluate(range[0], range[1], scope, roles);
      if (value) this.report(kind, patch ? { ...value, ...patch } : value, line, guards, range[0], range[1]);
    };
    if (this.language === 'go') {
      if (GO_SQL.test(name) && receiver && (GO_SQL_RECEIVER.test(receiver) || /[Dd][Bb]$|[Tt]x$|[Cc]onn$|[Ss]tmt$|[Pp]ool$/.test(receiver))) {
        report('sql', /Context$/.test(name) ? 1 : 0);
        return;
      }
      if (name === 'Where' || name === 'Order' || name === 'Having' || name === 'Group' || name === 'Joins') {
        /* gorm: db.Where("name = " + x) -- the first argument built from a value */
        this.builtSql(this.arg(args, 0, scope, roles), line, guards, args[0], true);
        return;
      }
      if (receiver === 'exec' && (name === 'Command' || name === 'CommandContext')) {
        const offset = name === 'CommandContext' ? 1 : 0;
        const program = args[offset] ? this.tokens[args[offset][0]] : null;
        if (program && program.t === 'str' && SHELLS.test(program.v)) {
          for (let index = offset + 1; index < args.length; index += 1) report('command', index);
        } else report('command', offset);
        return;
      }
      if ((receiver === 'os' && /^(Open|OpenFile|ReadFile|Create|WriteFile|Remove|RemoveAll|Mkdir|MkdirAll|ReadDir|Chmod|Rename)$/.test(name)) || (receiver === 'ioutil' && /^(ReadFile|WriteFile|ReadDir)$/.test(name))) { report('path', 0); return; }
      if (receiver === 'http' && name === 'ServeFile') { report('path', 2); return; }
      if (roles.gin.has(receiver) && (name === 'File' || name === 'FileAttachment')) { report('path', 0); return; }
      if (roles.echo.has(receiver) && (name === 'File' || name === 'Attachment')) { report('path', 0); return; }
      if (roles.fiber.has(receiver) && (name === 'SendFile' || name === 'Download')) { report('path', 0); return; }
      if (receiver === 'http' && /^(Get|Head|Post|PostForm)$/.test(name)) { report('ssrf', 0); return; }
      if (receiver === 'http' && name === 'NewRequest') { report('ssrf', 1); return; }
      if (receiver === 'http' && name === 'NewRequestWithContext') { report('ssrf', 2); return; }
      if (receiver === 'http' && name === 'Redirect') { report('redirect', 2); return; }
      if ((roles.gin.has(receiver) || roles.echo.has(receiver)) && name === 'Redirect') { report('redirect', 1); return; }
      if (roles.fiber.has(receiver) && name === 'Redirect') { report('redirect', 0); return; }
      if (receiver === 'template' && name === 'HTML') { report('html', 0, { html: true }); return; }
      if (name === 'Parse' && /template\.New\(\)/.test(text)) { report('template', 0); return; }
      if (receiver === 'fmt' && /^Fprint(f|ln)?$/.test(name) && args[0]) {
        const writer = this.tokens[args[0][0]];
        if (writer && roles.writer.has(writer.v)) {
          const value = this.evaluateArgs(open, scope, roles);
          const tail = args.slice(1).map(([s, e]) => this.evaluate(s, e, scope, roles)).reduce(merge, null);
          if (tail && (value.literal && HTML_TEXT.test(value.literal) || tail.html)) this.report('html', { ...tail, html: true }, line, guards, args[1][0], args[args.length - 1][1]);
        }
        return;
      }
      if ((name === 'Write' && receiver && roles.writer.has(receiver)) || (receiver === 'io' && name === 'WriteString' && args[0] && roles.writer.has(this.tokens[args[0][0]].v))) {
        const index = name === 'Write' ? 0 : 1;
        const value = this.arg(args, index, scope, roles);
        if (value && value.html) this.report('html', value, line, guards, args[index][0], args[index][1]);
        return;
      }
      if (roles.gin.has(receiver) && name === 'Data' && args[1] && this.tokens[args[1][0]].t === 'str' && /html/i.test(this.tokens[args[1][0]].v)) { report('html', 2, { html: true }); return; }
      return;
    }
    if (this.language === 'java') {
      if (JAVA_SQL.test(name)) { report('sql', 0); return; }
      if (JAVA_SQL_GENERIC.test(name) && receiver && /(jdbc|template|stmt|statement|jdbcTemplate|namedParameterJdbcTemplate|conn|connection|session|em|entityManager|db)/i.test(receiver)) {
        this.builtSql(this.arg(args, 0, scope, roles), line, guards, args[0]);
        return;
      }
      if (name === 'exec' && /getRuntime\(\)/.test(text)) { report('command', 0); return; }
      if (callee.constructed && name === 'ProcessBuilder') {
        const program = args[0] ? this.tokens[args[0][0]] : null;
        if (program && program.t === 'str' && SHELLS.test(program.v)) { for (let index = 1; index < args.length; index += 1) report('command', index); } else report('command', 0);
        return;
      }
      if (name === 'command' && receiver && /ProcessBuilder|builder|pb/i.test(receiver)) { report('command', 0); return; }
      if (callee.constructed && /^(File|FileInputStream|FileOutputStream|FileReader|FileWriter|RandomAccessFile|PrintWriter)$/.test(name)) { report('path', args.length > 1 && name === 'File' ? 1 : 0); if (name === 'File' && args.length > 1) report('path', 0); return; }
      if ((receiver === 'Paths' && name === 'get') || (receiver === 'Path' && name === 'of')) { for (let index = 0; index < args.length; index += 1) report('path', index); return; }
      if (receiver === 'Files' && /^(readAllBytes|readString|readAllLines|newInputStream|newBufferedReader|lines|delete|deleteIfExists|write|writeString|copy|move|newOutputStream)$/.test(name)) { report('path', 0); return; }
      if (callee.constructed && name === 'URL') { report('ssrf', 0); return; }
      if (receiver && /restTemplate|rest|client|webClient|httpClient/i.test(receiver) && /^(getForObject|getForEntity|postForObject|postForEntity|exchange|put|delete|patchForObject|headForHeaders)$/.test(name)) { report('ssrf', 0); return; }
      if (name === 'uri' && /webClient|WebClient|client/i.test(text)) { report('ssrf', 0); return; }
      if (receiver === 'URI' && name === 'create' && /newBuilder/.test(this.contextText(open))) { report('ssrf', 0); return; }
      if (receiver === 'Jsoup' && name === 'connect') { report('ssrf', 0); return; }
      if (name === 'sendRedirect') { report('redirect', 0); return; }
      if (/^(write|print|println|append|printf|format)$/.test(name) && /getWriter\(\)|getOutputStream\(\)/.test(text)) {
        const value = this.arg(args, 0, scope, roles);
        if (value && value.html) this.report('html', value, line, guards, args[0][0], args[0][1]);
        return;
      }
      if (name === 'eval' && receiver && /engine|scriptEngine|js|nashorn|interpreter/i.test(receiver)) { report('code', 0); return; }
      if ((name === 'evaluate' || name === 'parse' || name === 'run') && receiver && /groovy|shell/i.test(receiver)) { report('code', 0); return; }
      if (name === 'parseExpression') { report('code', 0); return; }
      if (receiver === 'Ognl' && name === 'getValue') { report('code', 0); return; }
      if (callee.constructed && (name === 'ObjectInputStream' || name === 'XMLDecoder')) { report('deserialize', 0); return; }
      if (name === 'load' && /Yaml\(\)|yaml/i.test(text)) { report('deserialize', 0); return; }
      if (receiver === 'Velocity' && name === 'evaluate') { report('template', 3); return; }
      if (JAVA_XML_PARSE[name] && receiver && JAVA_XML_PARSE[name].test(receiver) && !xmlHardened(this.file)) {
        if ((name === 'read' && !/SAXReader/.test(this.file.text)) || (name === 'build' && !/SAXBuilder/.test(this.file.text))) return;
        report('xxe', 0);
        return;
      }
      if (callee.constructed && name === 'Template' && args.length > 1) { report('template', 1); return; }
      return;
    }
    /* PHP */
    if (Object.prototype.hasOwnProperty.call(PHP_SQL_FUNCTIONS, name) && callee.segments.length === 1) {
      const index = PHP_SQL_FUNCTIONS[name] === -1 ? (args.length > 1 ? 1 : 0) : PHP_SQL_FUNCTIONS[name];
      report('sql', index);
      return;
    }
    /* $pdo->query($q), $mysqli->query($q), DB::select($q), $wpdb->get_results($q), ->whereRaw($q); another receiver's update() is a model's */
    const sqlTarget = PHP_SQL_METHODS.test(name) && callee.segments.length > 1 && (/Raw$|^raw$/.test(name) || receiver === 'DB' || /^\$(pdo|db|dbh|mysqli|conn|connection|link|wpdb|database|pdoConn|sql|em|entityManager|dbal)$/i.test(receiver || '') || /->(db|pdo|conn|connection|mysqli|em|entityManager|dbal)$/.test(callee.segments.join('->')) ||
      (/^(executeQuery|executeStatement|executeUpdate|createQuery|createNativeQuery)$/.test(name) && /(conn|connection|db|em|manager|dbal)$/i.test(receiver || '')));
    if (sqlTarget) {
      const value = this.arg(args, 0, scope, roles);
      if (value && /Raw$|^raw$|^statement$|^unprepared$/.test(name)) this.report('sql', value, line, guards, args[0][0], args[0][1]);
      else this.builtSql(value, line, guards, args[0]);
      return;
    }
    if (PHP_COMMANDS.has(name) && callee.segments.length === 1) { report('command', 0); return; }
    if (['eval', 'assert', 'create_function'].includes(name) && callee.segments.length === 1) { report('code', name === 'create_function' ? 1 : 0); return; }
    if (name === 'unserialize' && callee.segments.length === 1) { report('deserialize', 0); return; }
    if (PHP_PATHS.has(name) && callee.segments.length === 1) {
      const index = name === 'rename' || name === 'copy' ? 0 : 0;
      report('path', index);
      if ((name === 'rename' || name === 'copy') && args[1]) report('path', 1);
      return;
    }
    if (name === 'move_uploaded_file') { report('path', 1); return; }
    /* Symfony and SPL: new BinaryFileResponse($path), new SplFileObject($path); Laravel: response()->download($path), Storage::get($path) */
    if (callee.constructed && /^(BinaryFileResponse|SplFileObject|SplFileInfo|File)$/.test(name)) { report('path', 0); return; }
    if ((name === 'download' || name === 'file') && /response\(\)/.test(text)) { report('path', 0); return; }
    if (receiver === 'Storage' && /^(get|download|delete|put|path|readStream|exists|url|response)$/.test(name)) { report('path', 0); return; }
    if (name === 'curl_init' && callee.segments.length === 1) { report('ssrf', 0); return; }
    if (name === 'curl_setopt' && args[1] && this.tokens[args[1][0]] && this.tokens[args[1][0]].v === 'CURLOPT_URL') { report('ssrf', 2); return; }
    if (name === 'fsockopen') { report('ssrf', 0); return; }
    if (receiver === 'Http' && /^(get|post|put|patch|delete|head|send)$/.test(name)) { report('ssrf', name === 'send' ? 1 : 0); return; }
    if (receiver && /client|guzzle|http/i.test(receiver) && /^(get|post|put|patch|delete|head|request|requestAsync|getAsync)$/.test(name)) { report('ssrf', /^request/.test(name) ? 1 : 0); return; }
    if (name === 'header' && callee.segments.length === 1 && args[0]) {
      const first = this.tokens[args[0][0]];
      if (first && first.t === 'str' && /^\s*Location\s*:\s*$/i.test(first.v)) {
        const value = this.arg(args, 0, scope, roles);
        if (value) this.report('redirect', { ...value, lead: null }, line, guards, args[0][0], args[0][1]);
      }
      return;
    }
    if ((name === 'redirect' && callee.segments.length === 1) || ((name === 'to' || name === 'away') && /redirect\(\)|Redirect/.test(text))) { report('redirect', 0); return; }
    /* Symfony: $this->redirect($url), new RedirectResponse($url) */
    if ((name === 'redirect' && /^\$this$/.test(receiver || '')) || (callee.constructed && (name === 'RedirectResponse' || name === 'TrustedRedirectResponse'))) { report('redirect', 0); return; }
    /* Symfony: new Response('<h1>' . $name) */
    if (callee.constructed && name === 'Response') {
      const value = this.arg(args, 0, scope, roles);
      if (value && value.html) this.report('html', value, line, guards, args[0][0], args[0][1]);
      return;
    }
    if (receiver && /twig|env/i.test(receiver) && name === 'createTemplate') { report('template', 0); return; }
    if (receiver === 'Blade' && name === 'render') { report('template', 0); return; }
    if ((name === 'printf' || name === 'print_r' || name === 'vprintf') && callee.segments.length === 1) { report('html', 0); return; }
    /* XML with entity substitution or DTD loading switched on: simplexml_load_string($x, ..., LIBXML_NOENT), $dom->loadXML($x, LIBXML_NOENT) */
    if ((/^(simplexml_load_string|loadXML|loadHTML)$/.test(name) || (callee.constructed && name === 'SimpleXMLElement')) && args[0]) {
      const flags = args.slice(1).map(([s, e]) => this.tokens.slice(s, e).map(t => t.v).join(' ')).join(' ');
      if (PHP_XML_ENTITIES.test(flags) || /libxml_disable_entity_loader\s*\(\s*false\s*\)/.test(this.file.text)) report('xxe', 0);
      return;
    }
    /* Laravel mass assignment: Model::create($request->all()) */
    if (/^(create|update|fill|forceCreate|forceFill|insert|updateOrCreate|firstOrCreate)$/.test(name) && callee.segments.length > 1) {
      const value = this.arg(args, name === 'updateOrCreate' || name === 'firstOrCreate' ? 1 : 0, scope, roles);
      if (value && value.whole) this.report('mass', value, line, guards, args[0][0], args[args.length - 1][1]);
    }
  }

  /*
   * A call that runs SQL only as dangerous as the string it is handed: one
   * built from a value, or carrying SQL words. A helper's bare parameter is
   * noted as needing that, and judged where the helper is called.
   */
  builtSql(value, line, guards, range, builtOnly = false) {
    if (!value || !range) return;
    if (value.built || (!builtOnly && (value.sql || value.whole))) this.report('sql', value, line, guards, range[0], range[1]);
    else if (this.summary && value.kind === 'parameter') this.report('sql', { ...value, requires: 'built' }, line, guards, range[0], range[1]);
  }

  contextText(open) {
    return this.tokens.slice(Math.max(0, open - 12), open).map(t => t.v).join('');
  }

  report(kind, value, line, guards, from, to) {
    if (!value) return;
    if (this.summary && value.param !== undefined && value.param !== null && value.kind === 'parameter') {
      if (this.summary.sinks.length < 8) this.summary.sinks.push({ kind, param: value.param, path: this.path, line, steps: [{ path: this.path, line, role: 'sink', note: `used in ${SINKS[kind].label}` }], flags: { built: value.built, sql: value.sql, html: value.html }, requires: value.requires || null });
      return;
    }
    if (value.kind === 'parameter') return;
    /* A request value in the path after a fixed origin, or after a local path, is not a choice of where to go. */
    if ((kind === 'ssrf' || kind === 'redirect') && value.lead && (ABSOLUTE_PREFIX.test(value.lead) || (kind === 'redirect' && LOCAL_PATH_PREFIX.test(value.lead)))) return;
    if (kind === 'html' && this.language === 'php' && !value.html && value.whole) return;
    const guard = guards.get(this.firstName(from, to, this.currentScope || new Map())) || null;
    this.pushFlow(kind, value, this.path, line, guard, null);
  }

  pushFlow(kind, value, path, line, guard, viaHelper) {
    if (this.flows.length >= MAX_FLOWS_PER_FILE) return;
    const spec = SINKS[kind];
    const steps = value.steps.slice(0, MAX_STEPS);
    if (!steps.some(step => step.role === 'sink')) steps.push({ path, line, role: 'sink', note: `used in ${spec.label}` });
    const judgement = JUDGEMENT_SINKS.has(kind);
    const weak = Boolean(value.weakRoute);
    const verdict = guard || judgement || weak ? 'needs-validation' : 'confirmed';
    const blocker = guard ? { reason: 'guarded', path: guard.path, line: guard.line } : judgement ? { reason: kind } : weak ? { reason: 'weak-source' } : null;
    this.flows.push({ rule: spec.rule, kind, severity: spec.severity, path, line, source: value.kind, verdict, blocker, trace: steps, viaHelper });
  }
}

/* ---- Routes -------------------------------------------------------------------------- */

const GO_ROUTER = /^(r|router|mux|m|app|e|api|v\d+|g|group|engine|srv|server|http|web|routes?|admin\w*|public\w*|private\w*|protected\w*|authed\w*|\w*[Rr]outer|\w*[Gg]roup|\w*[Mm]ux|\w*[Aa]pi|\w*[Aa]pp)$/;
const GO_ROUTE_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options|Handle|HandleFunc|Match)$/;
const SPRING_MAPPING = table({ GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE', RequestMapping: null });
const JAXRS_METHOD = /@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;
const ROUTE_TEXT = /^[A-Za-z0-9/_:.\-*[\]{}()$+?@~]*$/;

function safeRoute(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('/') || text.length > 120 || !ROUTE_TEXT.test(text)) return null;
  return text;
}
function joinRoute(prefix, route) {
  if (!prefix) return route;
  if (!route || route === '/') return prefix;
  return `${prefix.replace(/\/$/, '')}/${route.replace(/^\//, '')}`;
}

/* Whether the first of two arguments is the searched value rather than the list: strings.Contains(x, "..") is not an allow-list. */
function scope_of_first(args, tokens) {
  const [a, b] = args[0];
  return b - a === 1 && tokens[a].t === 'str';
}

/* The token index where a function's header begins, so a walk can step over it. */
function headerStartOf(tokens, fn) {
  let k = fn.params[0] - 1;
  while (k > 0 && !isWord(tokens[k], 'func') && !isWord(tokens[k], 'function') && !isWord(tokens[k], 'fn')) {
    if (tokens[k].line < fn.line) break;
    k -= 1;
  }
  return isWord(tokens[k], 'func') || isWord(tokens[k], 'function') || isWord(tokens[k], 'fn') ? k : fn.params[0] - 1;
}

/* The names in a token range, a dotted chain read as one: `requireAuth(handlers.Search)` is requireAuth, handlers.Search. */
function chainNames(tokens, from, to) {
  const names = [];
  for (let k = from; k < to; k += 1) {
    const token = tokens[k];
    if (token.t !== 'id') continue;
    if (isPunc(tokens[k - 1], '.') && k - 1 >= from && names.length) names[names.length - 1] += `.${token.v}`;
    else names.push(token.v);
  }
  return names;
}

/* Go's own wrappers around a handler, which guard nothing. */
const GO_PLAIN_WRAPPER = /^(http\.HandlerFunc|http\.Handler|http\.StripPrefix|http\.TimeoutHandler|http\.MaxBytesHandler|gin\.WrapF|gin\.WrapH|echo\.WrapHandler|adaptor\.\w+)$/;

/*
 * The endpoints a file declares, each with the handler's body range so its
 * guard and its writes can be read, and the middleware named beside it.
 */
function routesOf(tokens, language, path, functions, text) {
  const routes = [];
  const bodyText = (from, to) => tokens.slice(from, to + 1).map(t => (t.t === 'str' ? JSON.stringify(t.v) : t.v)).join(' ');
  const functionNamed = new Map(functions.filter(fn => fn.name).map(fn => [fn.name, fn]));
  if (language === 'go') {
    const groups = new Map();
    const uses = [];
    /* which router each name holds: r := gin.Default(), mux := http.NewServeMux(), func setup(e *echo.Echo) */
    const kinds = new Map();
    const MADE = [[/(\w+)\s*:?=\s*gin\.(?:Default|New)\(/g, 'gin'], [/(\w+)\s*:?=\s*echo\.New\(/g, 'echo'], [/(\w+)\s*:?=\s*fiber\.New\(/g, 'fiber'],
      [/(\w+)\s*:?=\s*chi\.NewRouter\(/g, 'chi'], [/(\w+)\s*:?=\s*mux\.NewRouter\(/g, 'gorilla'], [/(\w+)\s*:?=\s*http\.NewServeMux\(/g, 'go-http'],
      [/(\w+)\s+\*?gin\.(?:Engine|RouterGroup|IRouter\w*)\b/g, 'gin'], [/(\w+)\s+\*?echo\.(?:Echo|Group)\b/g, 'echo'], [/(\w+)\s+\*?fiber\.(?:App|Router)\b/g, 'fiber'],
      [/(\w+)\s+chi\.Router\b/g, 'chi'], [/(\w+)\s+\*?mux\.Router\b/g, 'gorilla'], [/(\w+)\s+\*?http\.ServeMux\b/g, 'go-http']];
    for (const [pattern, kind] of MADE) for (const match of text.matchAll(pattern)) if (!kinds.has(match[1])) kinds.set(match[1], kind);
    for (let k = 0; k < tokens.length; k += 1) {
      const token = tokens[k];
      if (!isPunc(tokens[k + 1], '(') || token.t !== 'id') continue;
      const callee = calleeAt(tokens, k + 1);
      const receiver = callee.receiver;
      const { args } = argumentsOf(tokens, k + 1);
      /* v1 := r.Group("/v1", auth) */
      if ((token.v === 'Group' || token.v === 'Route') && args[0] && tokens[args[0][0]].t === 'str') {
        const assigned = tokens[k - 3] && isPunc(tokens[k - 2], ':=') ? tokens[k - 3].v : tokens[k - 4] && isPunc(tokens[k - 3], ':=') ? tokens[k - 4].v : null;
        const words = args.slice(1).flatMap(([s, e]) => chainNames(tokens, s, e));
        const parentPrefix = groups.has(receiver) ? groups.get(receiver).prefix : '';
        if (assigned) {
          groups.set(assigned, { prefix: joinRoute(parentPrefix, tokens[args[0][0]].v), words: [...(groups.has(receiver) ? groups.get(receiver).words : []), ...words] });
          if (kinds.has(receiver) && !kinds.has(assigned)) kinds.set(assigned, kinds.get(receiver));
        }
        continue;
      }
      if (token.v === 'Use' && receiver) {
        const words = args.flatMap(([s, e]) => chainNames(tokens, s, e));
        if (groups.has(receiver)) groups.get(receiver).words.push(...words);
        else uses.push({ line: token.line, words, prefix: null, receiver });
        continue;
      }
      if (!GO_ROUTE_METHOD.test(token.v) || !receiver || !args[0] || tokens[args[0][0]].t !== 'str') continue;
      if (!(GO_ROUTER.test(receiver) || groups.has(receiver)) || (receiver === 'http' && !/^Handle/.test(token.v))) continue;
      let pattern = tokens[args[0][0]].v;
      let method = /^Handle|^Any$|^Match$/.test(token.v) ? 'ANY' : token.v.toUpperCase();
      /* Go 1.22: "POST /items/{id}" */
      const spaced = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/.exec(pattern);
      if (spaced) { method = spaced[1]; pattern = spaced[2]; }
      /* gorilla: .Methods("POST") after the call */
      const after = tokens.slice(argumentsOf(tokens, k + 1).close + 1, argumentsOf(tokens, k + 1).close + 6);
      const methods = after.findIndex(t => t.v === 'Methods');
      if (methods !== -1 && after[methods + 2] && after[methods + 2].t === 'str') method = after[methods + 2].v.toUpperCase();
      const group = groups.get(receiver);
      const route = safeRoute(joinRoute(group ? group.prefix : '', pattern)) || safeRoute(pattern);
      if (!route) continue;
      /* the handler: the last argument, a literal func or a named function */
      const handlerRange = args[args.length - 1];
      const middleware = [...(group ? group.words : []), ...args.slice(1, -1).flatMap(([s, e]) => chainNames(tokens, s, e))];
      /* a wrapped handler: requireAuth(handler) */
      const literal = functions.find(fn => handlerRange && fn.body[0] >= handlerRange[0] && fn.body[1] <= handlerRange[1]);
      const wrapped = handlerRange && !literal ? chainNames(tokens, handlerRange[0], handlerRange[1]) : [];
      /* the literal's own wrappers: requireAuth(func(w, r) { ... }) */
      if (literal) middleware.push(...chainNames(tokens, handlerRange[0], headerStartOf(tokens, literal)));
      if (wrapped.length > 1) middleware.push(...wrapped.slice(0, -1));
      const handlerName = wrapped.length ? wrapped[wrapped.length - 1].replace(/^.*\./, '') : null;
      let body = null;
      if (literal) body = literal;
      else if (handlerName) body = functionNamed.get(handlerName) || null;
      const framework = receiver === 'http' ? 'go-http' : kinds.get(receiver) ||
        (/gin\./.test(text) ? 'gin' : /echo\./.test(text) ? 'echo' : /fiber\./.test(text) ? 'fiber' : /chi\./.test(text) ? 'chi' : /mux\.NewRouter/.test(text) ? 'gorilla' : 'go-http');
      routes.push({
        method, route, path, line: token.line, framework, language, middleware: middleware.filter(word => !GO_PLAIN_WRAPPER.test(word)),
        handlerName: body ? null : handlerName,
        uses: uses.filter(use => use.receiver === receiver || use.receiver === 'http').map(({ line, words, prefix }) => ({ line, words, prefix })),
        bodyText: body ? bodyText(body.body[0], body.body[1]) : '',
        startLine: body ? tokens[body.body[0]].line : token.line,
        endLine: body ? tokens[body.body[1]].line : token.line,
        handlerLine: body ? body.line : null
      });
    }
    return routes;
  }
  if (language === 'java') {
    /* class-level @RequestMapping("/prefix") and @Path("/prefix") */
    const classPrefix = (() => {
      const match = /@(RequestMapping|Path)\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"\n]{0,300})"[^)]{0,600}\)\s*(?:@\w+(?:\([^)]{0,600}\))?\s*){0,16}(?:(?:public|final|abstract)\s+){0,3}class\b/.exec(text);
      return match ? match[2] : '';
    })();
    const classAuth = /@(PreAuthorize|Secured|RolesAllowed)\b[^{]{0,2000}?\bclass\b/.test(text);
    for (const fn of functions) {
      const decorations = fn.decorations.join(' ');
      const mapping = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b(?:\s*\(([^)]*)\))?/.exec(decorations);
      const jaxrs = JAXRS_METHOD.exec(decorations);
      if (!mapping && !jaxrs) continue;
      let method = mapping ? SPRING_MAPPING[mapping[1]] : jaxrs[1];
      if (mapping && !method) {
        const verb = /RequestMethod \. (GET|POST|PUT|PATCH|DELETE)/.exec(mapping[2] || '');
        method = verb ? verb[1] : 'ANY';
      }
      const pathMatch = mapping ? /"([^"]*)"/.exec(mapping[2] || '') : /@Path\s*\(\s*"([^"]*)"/.exec(decorations);
      const route = safeRoute(joinRoute(classPrefix, pathMatch ? pathMatch[1] : '')) || safeRoute(classPrefix) || null;
      const authDecorated = classAuth || /@(PreAuthorize|Secured|RolesAllowed|PostAuthorize)\b/.test(decorations);
      routes.push({
        method, route, path, line: fn.line, framework: jaxrs && !mapping ? 'jaxrs' : 'spring', language, middleware: [], authDecorated,
        bodyText: `${fn.decorations.join(' ')} ${tokens.slice(fn.params[0], fn.body[1] + 1).map(t => (t.t === 'str' ? JSON.stringify(t.v) : t.v)).join(' ')}`,
        startLine: fn.line, endLine: tokens[fn.body[1]].line, handlerLine: fn.line
      });
    }
    return routes;
  }
  /* Symfony: #[Route('/posts/{id}', methods: ['GET'])] on a method, under the class's own #[Route('/prefix')] */
  if (/#\s*\[\s*Route\s*\(/.test(text)) {
    const classMatch = /#\[\s*Route\s*\(\s*(?:path\s*:\s*)?['"]([^'"\n]{0,300})['"][^\]]{0,600}\]\s*(?:#\[[^\]]{0,600}\]\s*){0,16}(?:(?:final|abstract|readonly)\s+){0,3}class\b/.exec(text);
    const classPrefix = classMatch ? classMatch[1] : '';
    const classAuth = /#\[\s*(IsGranted|Security)\b[^\]]{0,600}\]\s*(?:#\[[^\]]{0,600}\]\s*){0,16}(?:(?:final|abstract|readonly)\s+){0,3}class\b/.test(text);
    for (const fn of functions) {
      if (!fn.name) continue;
      const decorations = fn.decorations.join(' ');
      const match = /#\s*\[\s*Route\s*\(\s*(?:path\s*:\s*)?"([^"]*)"/.exec(decorations);
      if (!match) continue;
      const listed = /methods\s*:\s*(\[[^\]]*\]|"[A-Za-z]+")/.exec(decorations);
      const verbs = listed ? (listed[1].match(/"([A-Za-z]+)"/g) || []).map(word => word.replace(/"/g, '').toUpperCase()) : [];
      const route = safeRoute(joinRoute(classPrefix, match[1]));
      if (!route) continue;
      routes.push({
        method: verbs.length ? verbs.join(',') : 'ANY', route, path, line: fn.line, framework: 'symfony', language, middleware: [],
        authDecorated: classAuth || /#\s*\[\s*(IsGranted|Security)\b/.test(decorations),
        bodyText: `${decorations} ${bodyText(fn.params[0], fn.body[1])}`,
        startLine: fn.line, endLine: tokens[fn.body[1]].line, handlerLine: fn.line
      });
    }
  }
  /* Laravel routes: Route::get('/x', ...)->middleware('auth'); Route::middleware('auth')->group(function () { ... }) */
  if (!/(^|\/)routes\/[\w.-]+\.php$/.test(path)) return routes;
  /* `use App\Http\Controllers\Admin\PostController;` says which PostController a route means. */
  const imported = new Map();
  for (const match of text.matchAll(/^\s*use\s+App\\Http\\Controllers\\([\w\\]+?)(?:\s+as\s+(\w+))?\s*;/gm)) {
    const relative = match[1].replace(/\\/g, '/');
    imported.set(match[2] || relative.replace(/^.*\//, ''), `app/Http/Controllers/${relative}.php`);
  }
  const groupStack = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    while (groupStack.length && k > groupStack[groupStack.length - 1].end) groupStack.pop();
    if (!isWord(token, 'Route') || !isPunc(tokens[k + 1], '::')) continue;
    const verb = tokens[k + 2];
    if (!verb) continue;
    /* the whole chained statement */
    const end = (() => { let depth = 0; for (let m = k; m < tokens.length; m += 1) { const t = tokens[m]; if (isPunc(t, '(') || isPunc(t, '[') || isPunc(t, '{')) depth += 1; else if (isPunc(t, ')') || isPunc(t, ']') || isPunc(t, '}')) depth -= 1; else if (depth === 0 && isPunc(t, ';')) return m; } return tokens.length - 1; })();
    const statement = tokens.slice(k, end);
    const middleware = [];
    statement.forEach((t, index) => {
      if (isWord(t, 'middleware') && isPunc(statement[index + 1], '(')) {
        const close = closing(statement, index + 1);
        for (let m = index + 2; m < close; m += 1) if (statement[m].t === 'str') middleware.push(statement[m].v);
      }
    });
    const groupAt = statement.findIndex(t => isWord(t, 'group'));
    if (groupAt !== -1) {
      const prefix = (() => { const at = statement.findIndex(t => isWord(t, 'prefix')); return at !== -1 && statement[at + 2] && statement[at + 2].t === 'str' ? statement[at + 2].v : ''; })();
      /* Route::controller(PostController::class)->group(...): the group's routes name only the method */
      const controllerAt = statement.findIndex((t, index) => isWord(t, 'controller') && isPunc(statement[index + 1], '('));
      const groupController = controllerAt !== -1 && statement[controllerAt + 2] && statement[controllerAt + 2].t === 'id' ? statement[controllerAt + 2].v : null;
      const parent = groupStack[groupStack.length - 1];
      groupStack.push({
        end, prefix: joinRoute(parent ? parent.prefix : '', prefix ? `/${prefix.replace(/^\//, '')}` : ''),
        middleware: [...(parent ? parent.middleware : []), ...middleware], controller: groupController || (parent ? parent.controller : null)
      });
      continue;
    }
    if (!/^(get|post|put|patch|delete|any|match|options|resource|apiResource)$/.test(verb.v)) continue;
    const open = k + 3;
    if (!isPunc(tokens[open], '(')) continue;
    const { args } = argumentsOf(tokens, open);
    const pathIndex = verb.v === 'match' ? 1 : 0;
    const pathToken = args[pathIndex] ? tokens[args[pathIndex][0]] : null;
    if (!pathToken || pathToken.t !== 'str') continue;
    const parent = groupStack[groupStack.length - 1];
    const route = safeRoute(joinRoute(parent ? parent.prefix : '', `/${pathToken.v.replace(/^\//, '')}`));
    if (!route) continue;
    const handlerRange = args[pathIndex + 1];
    const handler = handlerRange ? tokens.slice(handlerRange[0], handlerRange[1]) : [];
    let method = verb.v === 'resource' || verb.v === 'apiResource' ? 'POST,PUT,DELETE' : verb.v === 'any' ? 'ANY' : verb.v.toUpperCase();
    if (verb.v === 'match') {
      const verbs = args[0] ? tokens.slice(args[0][0], args[0][1]).filter(t => t.t === 'str').map(t => t.v.toUpperCase()) : [];
      method = verbs.length ? verbs.join(',') : 'ANY';
    }
    const closure = functions.find(fn => handlerRange && fn.body[0] >= handlerRange[0] && fn.body[1] <= handlerRange[1]);
    /* [PostController::class, 'store'], 'PostController@store', an invokable PostController::class, or 'store' in a controller group */
    let controller = handler.filter(t => t.t === 'id' && /Controller$/.test(t.v)).map(t => t.v)[0] || null;
    const named = handler.find(t => t.t === 'str');
    let controllerAction = null;
    if (!closure) {
      if (controller) controllerAction = named ? named.v : verb.v === 'resource' || verb.v === 'apiResource' ? null : '__invoke';
      else if (named && /^[\w\\]+@\w+$/.test(named.v)) { const [owner, name] = named.v.split('@'); controller = owner.replace(/^.*\\/, ''); controllerAction = name; }
      else if (named && parent && parent.controller && /^\w+$/.test(named.v)) { controller = parent.controller; controllerAction = named.v; }
    }
    routes.push({
      method, route, path, line: token.line, framework: 'laravel', language, middleware: [...(parent ? parent.middleware : []), ...middleware],
      bodyText: closure ? bodyText(closure.body[0], closure.body[1]) : handler.map(t => (t.t === 'str' ? JSON.stringify(t.v) : t.v)).join(' '),
      startLine: closure ? tokens[closure.body[0]].line : token.line, endLine: closure ? tokens[closure.body[1]].line : token.line,
      controller, controllerAction, controllerPath: controller ? imported.get(controller) || null : null
    });
  }
  return routes;
}

/* ---- The program: files, helper summaries, class annotations -------------------------- */

const LANGUAGE_OF = table({ go: 'go', java: 'java', php: 'php' });

class Program {
  constructor(files) {
    this.files = new Map();
    for (const file of files) {
      const ext = (/\.([a-z]+)$/.exec(file.path) || [])[1];
      const language = LANGUAGE_OF[ext];
      if (!language) continue;
      let tokens;
      try { tokens = lex(file.text, language); } catch { continue; }
      const functions = functionsOf(tokens, language);
      this.files.set(file.path, { file, language, tokens, functions });
    }
    this.summaries = new Map();
    this.parents = new Map();
    this.imports = new Map();
    this.implementors = new Map();
    this.byName = new Map();
    for (const [path, entry] of this.files) {
      for (const fn of entry.functions) {
        if (!fn.name) continue;
        const key = `${entry.language}:${fn.name}`;
        if (!this.byName.has(key)) this.byName.set(key, []);
        this.byName.get(key).push({ path, fn });
      }
    }
  }

  /* What a named function does with each parameter: which reach its return value, which reach a sink. */
  helper(language, name, callee, fromPath) {
    if (!name || !callee) return null;
    /* a function of this codebase: called by name, or on this object */
    /* Go: store.FindByEmail(x) names a function of an imported package */
    const imported = language === 'go' && callee.segments.length === 2 && this.goImports(fromPath).has(callee.segments[0]) ? callee.segments[0] : null;
    /* Java and PHP: userService.find(x), this.userService.find(x), $this->reports->forRegion($x) -- a field of a type declared here */
    const owner = callee.segments.filter(segment => !/^(this|\$this)$/.test(segment));
    const typed = (language === 'java' || language === 'php') && owner.length === 2 ? this.implementations(this.fieldType(fromPath, owner[0].replace(/^\$/, ''), language), language) : null;
    /* Go: h.products.SearchByName(x) through an interface -- the one method of that name the codebase defines */
    const goMethods = language === 'go' && callee.segments.length >= 2 && !imported
      ? (this.byName.get(`go:${name}`) || []).filter(entry => entry.fn.receiver) : [];
    const own = callee.segments.length === 1 || imported || (typed && typed.size) || goMethods.length === 1 || (callee.segments.length === 2 && /^(this|\$this|self|static|parent|super|s|h)$/.test(callee.segments[0]));
    if (!own) return null;
    let candidates = this.byName.get(`${language}:${name}`);
    if (goMethods.length === 1 && callee.segments.length >= 2 && !imported) candidates = goMethods;
    if (imported && candidates) candidates = candidates.filter(entry => this.goPackage(entry.path) === imported);
    if (typed && typed.size && candidates) candidates = candidates.filter(entry => typed.has(entry.path));
    if (!candidates || !candidates.length) return null;
    /* the same file first, then the class it extends; another file only when the name is unambiguous */
    const inherited = /^(super|parent)$/.test(callee.segments[0]);
    const local = inherited ? [] : candidates.filter(entry => entry.path === fromPath);
    const parentFile = this.parentFile(fromPath);
    const fromParent = parentFile ? candidates.filter(entry => entry.path === parentFile) : [];
    const pick = local.length === 1 ? local[0] : fromParent.length === 1 ? fromParent[0] : candidates.length === 1 ? candidates[0] : null;
    if (!pick) return null;
    const key = `${pick.path}:${pick.fn.line}:${name}`;
    if (this.summaries.has(key)) return this.summaries.get(key);
    const summary = { returns: new Set(), sinks: [], file: pick.path };
    this.summaries.set(key, summary);
    const entry = this.files.get(pick.path);
    const params = parametersOf(entry.tokens, pick.fn.params, entry.language);
    for (const param of params.slice(0, 6)) {
      if (!param.name) continue;
      const walker = new Walker(entry.file, entry.language, entry.tokens, this);
      walker.summary = { returns: new Set(), sinks: [] };
      const scope = new Map();
      const { roles } = walker.enter(pick.fn, scope, { index: param.index });
      const nested = new Map(entry.functions.filter(fn => fn !== pick.fn && fn.body[0] > pick.fn.body[0] && fn.body[1] < pick.fn.body[1]).map(fn => [this.headerStart(entry.tokens, fn), fn]));
      try { walker.walk(pick.fn, scope, roles, nested); } catch { continue; }
      for (const returned of walker.summary.returns) if (returned === param.index) summary.returns.add(param.index);
      for (const sink of walker.summary.sinks) if (sink.param === param.index) summary.sinks.push(sink);
    }
    return summary;
  }

  headerStart(tokens, fn) {
    return headerStartOf(tokens, fn);
  }

  /* The names a Go file imports packages under: the last element of each path, or its alias. */
  goImports(path) {
    if (this.imports.has(path)) return this.imports.get(path);
    const entry = this.files.get(path);
    const names = new Set();
    if (entry) {
      /* The first import block, found by position rather than by a pattern that rescans from every "import (". */
      const text = entry.file.text;
      const open = /\bimport\s*\(/.exec(text);
      const close = open ? text.indexOf(')', open.index + open[0].length) : -1;
      const lines = open && close > 0 ? text.slice(open.index + open[0].length, close).split('\n') : [];
      for (const match of entry.file.text.matchAll(/^\s*import\s+(\w+\s+)?"([^"]+)"/gm)) lines.push(`${match[1] || ''}"${match[2]}"`);
      for (const line of lines) {
        const match = /^\s*(\w+\s+)?"([^"]+)"/.exec(line);
        if (match) names.add(match[1] ? match[1].trim() : match[2].split('/').pop());
      }
    }
    this.imports.set(path, names);
    return names;
  }

  /* The type a field or constructor parameter of this file is declared with: `private final UserService userService;`, `private ReportService $reports`. */
  fieldType(path, field, language) {
    const entry = this.files.get(path);
    if (!entry || !/^\w+$/.test(field)) return null;
    const pattern = language === 'php'
      ? new RegExp(`(?:private|protected|public|readonly|var)\\s+(?:readonly\\s+)?\\??\\\\?(?:[\\w\\\\]+\\\\)?([A-Z]\\w*)\\s+\\$${field}\\b`)
      : new RegExp(`\\b([A-Z]\\w*)(?:<[^;=(){}]{0,200}>)?\\s+${field}\\s*[;=,)]`);
    const match = pattern.exec(entry.file.text);
    return match ? match[1] : null;
  }

  /* The files that implement a type: its own class, or the one class that implements the interface. */
  implementations(type, language) {
    if (!type) return null;
    const key = `${language}:${type}`;
    if (this.implementors.has(key)) return this.implementors.get(key);
    const declares = new RegExp(`\\b(class|interface|enum|record)\\s+${type}\\b`);
    const named = new RegExp(`\\b${type}\\b`);
    /* A class header up to its brace, at most a few hundred characters, then the words in it: never one pattern nesting two open scans. */
    const implementsIt = text => {
      for (const header of text.matchAll(/\bclass\s+\w+([^{]{0,600})\{/g)) {
        const clause = /\b(?:implements|extends)\b([^{]*)$/.exec(header[1]);
        if (clause && named.test(clause[1])) return true;
      }
      return false;
    };
    const found = new Set();
    for (const [path, entry] of this.files) {
      if (entry.language !== language) continue;
      const declared = declares.exec(entry.file.text);
      if (declared && declared[1] !== 'interface') found.add(path);
      else if (implementsIt(entry.file.text)) found.add(path);
    }
    this.implementors.set(key, found);
    return found;
  }

  /* The package a Go file declares. */
  goPackage(path) {
    const entry = this.files.get(path);
    const match = entry ? /^\s*package\s+(\w+)/m.exec(entry.file.text) : null;
    return match ? match[1] : null;
  }

  /* The file of the class this file's class extends, when exactly one file is named for it. */
  parentFile(path) {
    if (this.parents.has(path)) return this.parents.get(path);
    const entry = this.files.get(path);
    const match = entry ? /\bclass\s+\w+(?:\s*<[^>{]*>)?\s+extends\s+\\?(?:[\w\\]+\\)?([A-Z]\w*)/.exec(entry.file.text) : null;
    let found = null;
    if (match) {
      const ext = path.slice(path.lastIndexOf('.'));
      const named = [...this.files.keys()].filter(other => other !== path && (other === `${match[1]}${ext}` || other.endsWith(`/${match[1]}${ext}`)));
      if (named.length === 1) found = named[0];
    }
    this.parents.set(path, found);
    return found;
  }

  classAnnotations(path, at) {
    const entry = this.files.get(path);
    if (!entry) return '';
    const text = entry.file.text;
    /* the annotations before the nearest enclosing class declaration */
    const before = entry.tokens.slice(0, at);
    for (let k = before.length - 1; k >= 0; k -= 1) {
      if (isWord(before[k], 'class')) return decorationsBefore(entry.tokens, k).join(' ') + (/@RestController/.test(text) ? ' RestController' : '');
    }
    return '';
  }
}

/*
 * Trace every Go, Java and PHP file: routes first, then each function in
 * order, the functions inside it walked with the scope they close over.
 */
function analyseCFamily(files, options = {}) {
  const late = typeof options.late === 'function' ? options.late : () => false;
  const stats = { go: 0, java: 0, php: 0, functions: 0, routes: 0, flows: 0, helpers: 0, cut: 0, failed: 0 };
  const program = new Program(files.filter(file => typeof file.text === 'string' && file.text.length <= (options.maxBytes || 512 * 1024)));
  const flows = [];
  const routes = [];
  const settled = [];
  for (const [path, entry] of program.files) {
    if (late()) { stats.cut += 1; continue; }
    try {
      const fileRoutes = routesOf(entry.tokens, entry.language, path, entry.functions, entry.file.text);
      routes.push(...fileRoutes);
      const walker = new Walker(entry.file, entry.language, entry.tokens, program);
      /* top-level functions only; nested ones are walked from inside their parents */
      const outer = entry.functions.filter(fn => !entry.functions.some(other => other !== fn && other.body[0] < fn.body[0] && other.body[1] > fn.body[1]));
      const nested = new Map(entry.functions.filter(fn => !outer.includes(fn)).map(fn => [program.headerStart(entry.tokens, fn), fn]));
      for (const fn of outer) {
        const scope = new Map();
        const { roles } = walker.enter(fn, scope, null);
        walker.walk(fn, scope, roles, nested);
      }
      /* PHP runs top to bottom outside functions too: a plain script reads $_GET at the top level. */
      if (entry.language === 'php') {
        const covered = entry.functions.map(fn => [program.headerStart(entry.tokens, fn), fn.body[1]]);
        const top = { name: null, line: 1, params: null, body: [-1, entry.tokens.length], decorations: [] };
        const scope = new Map();
        const roles = { request: new Set(['$request']), writer: new Set(), gin: new Set(), echo: new Set(), fiber: new Set(), response: new Set() };
        const skipping = new Map(covered.map(([start, end]) => [start, { body: [start, end], params: [start, start], decorations: [], line: entry.tokens[start] ? entry.tokens[start].line : 1, skipOnly: true }]));
        walker.walkRange(0, entry.tokens.length, scope, roles, skipping, new Map(), top);
      }
      stats[entry.language] += 1;
      stats.functions += entry.functions.length;
      flows.push(...walker.flows);
      settled.push(...walker.settled);
    } catch {
      stats.failed += 1;
    }
  }
  resolveHandlers(routes, program);
  const unique = dedupe(flows);
  stats.routes = routes.length;
  stats.flows = unique.length;
  stats.helpers = unique.filter(flow => flow.viaHelper).length;
  return { flows: unique, routes, settled, stats };
}

/* The middleware a Laravel controller applies to one of its actions, from its constructor or its static middleware(). */
function controllerMiddleware(text, action) {
  const found = [];
  const listOf = raw => (String(raw || '').match(/['"]([^'"]+)['"]/g) || []).map(item => item.slice(1, -1));
  const applies = (kind, scope) => !scope || (kind === 'only' ? scope.includes(action) : !scope.includes(action));
  for (const match of text.matchAll(/\$this\s*->\s*middleware\s*\(\s*(\[[^\]]{0,600}\]|'[^'\n]{0,200}'|"[^"\n]{0,200}")\s*\)(?:\s*->\s*(only|except)\s*\(\s*(\[[^\]]{0,600}\]|'[^'\n]{0,200}'|"[^"\n]{0,200}")\s*\))?/g)) {
    if (applies(match[2], match[3] ? listOf(match[3]) : null)) found.push(...listOf(match[1]));
  }
  /* Laravel 11: public static function middleware(): array { return ['auth', new Middleware('auth', except: ['index'])]; } */
  /* The method's body runs to the first line that closes it, found in one pass and read no further than a few thousand characters. */
  const header = /static\s+function\s+middleware\s*\(\s*\)\s*(?::\s*array\s*)?\{/.exec(text);
  let declared = null;
  if (header) {
    const start = header.index + header[0].length;
    const closing = /\n[ \t]*\}/g;
    closing.lastIndex = start;
    const end = closing.exec(text);
    if (end && end.index - start <= 4000) declared = [null, text.slice(start, end.index)];
  }
  if (declared) {
    for (const match of declared[1].matchAll(/new\s+(?:\\?[\w\\]*\\)?Middleware\s*\(\s*(['"][^'"]+['"])(?:\s*,\s*(only|except)\s*:\s*(\[[^\]]*\]))?/g)) {
      if (applies(match[2], match[3] ? listOf(match[3]) : null)) found.push(...listOf(match[1]));
    }
    const plain = declared[1].replace(/new\s+(?:\\?[\w\\]*\\)?Middleware\s*\([^)]*\)/g, '');
    for (const match of plain.matchAll(/return\s*\[([^\]]*)\]/g)) found.push(...listOf(match[1]));
  }
  return found;
}

/*
 * A route whose handler is written elsewhere -- a Laravel controller's
 * method, a Go handler in another file -- takes that handler's range and
 * text, so its guard and its writes are read where they are written.
 */
function resolveHandlers(routes, program) {
  for (const route of routes) {
    let target = null;
    if (route.framework === 'laravel' && route.controller) {
      const candidates = route.controllerPath && program.files.has(route.controllerPath) ? [route.controllerPath]
        : [...program.files.keys()].filter(path => path === `${route.controller}.php` || path.endsWith(`/${route.controller}.php`));
      if (candidates.length !== 1) continue;
      const entry = program.files.get(candidates[0]);
      if (route.controllerAction) route.middleware = [...route.middleware, ...controllerMiddleware(entry.file.text, route.controllerAction)];
      const fn = route.controllerAction ? entry.functions.find(item => item.name === route.controllerAction) : null;
      if (fn) target = { path: candidates[0], entry, fn };
    } else if (route.language === 'go' && route.handlerName) {
      const candidates = program.byName.get(`go:${route.handlerName}`) || [];
      if (candidates.length === 1) target = { path: candidates[0].path, entry: program.files.get(candidates[0].path), fn: candidates[0].fn };
    }
    if (!target) continue;
    const { tokens } = target.entry;
    route.handlerPath = target.path;
    route.startLine = target.fn.line;
    route.endLine = tokens[target.fn.body[1]].line;
    route.handlerLine = target.fn.line;
    route.bodyText = `${target.fn.decorations.join(' ')} ${tokens.slice(target.fn.params[0], target.fn.body[1] + 1).map(t => (t.t === 'str' ? JSON.stringify(t.v) : t.v)).join(' ')}`;
  }
}

function dedupe(flows) {
  const seen = new Map();
  for (const flow of flows) {
    const key = `${flow.rule}\0${flow.path}\0${flow.line}`;
    const existing = seen.get(key);
    if (!existing || (existing.verdict !== 'confirmed' && flow.verdict === 'confirmed')) seen.set(key, flow);
  }
  return [...seen.values()];
}

const CFAMILY_FILE = /\.(go|java|php)$/;

module.exports = Object.freeze({ analyseCFamily, lex, functionsOf, routesOf, CFAMILY_FILE, SINKS });
