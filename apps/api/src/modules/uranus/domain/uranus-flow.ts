/*
 * Uranus: where a value comes from, and where it goes.
 *
 * A line rule can see `db.query(\`... ${id}\`)` and say a statement is built
 * from a variable. It cannot say whether `id` is a constant, a number the
 * code parsed, or the text of a request -- and those are the difference
 * between a style note and an injection. This module follows values:
 *
 *   sources   what a caller controls -- a request's body, query, route
 *             parameters, headers and cookies in Express, Fastify, Koa, Hono,
 *             Next.js route handlers and pages, server actions, SvelteKit,
 *             Remix, Supabase edge functions, Lambda, Flask, Django and
 *             FastAPI; the URL and messages in the browser; and a language
 *             model's reply, which is text somebody else's prompt shaped;
 *   steps     assignments, destructuring, string building, closures, helper
 *             functions in the same file, and functions imported from another
 *             file of the repository, one call deep;
 *   sanitisers the calls that make a value safe for its use -- a number
 *             parsed, a component encoded, a path reduced to its name, a
 *             schema's parse -- after which the value is no longer followed;
 *   checks    an `if` that tests the value before it is used: the flow is
 *             still reported, as something to confirm rather than a fact;
 *   sinks     the calls that turn text into an action: SQL, a shell, eval,
 *             an outbound request, the file system, a redirect, HTML, a
 *             template engine, a regular expression, a document database
 *             query, an object merge, a record written as it came.
 *
 * A flow is reported with its trace -- the file and line where the value
 * entered, each place it was carried, and the line that uses it -- and with
 * no text from any of them. The trace is what makes a finding checkable by a
 * person in a minute rather than argued about: it names the exact lines.
 *
 * It is not a compiler. It reads tokens, not types, and follows one call
 * across files, not the whole graph. What it cannot see it does not claim:
 * a flow it could not finish is not a finding, and the audit's coverage says
 * which languages were followed and which were only pattern-checked.
 */

import { getHeapStatistics } from 'node:v8';
import { lexJs, lexPython, matching, partners, splitArgs, opensWith } from './uranus-lex.ts';
import type { LogicalLine, PlainToken, TemplateToken, Token } from './uranus-lex.ts';
import { analyseCFamily, CFAMILY_FILE } from './uranus-cfamily.ts';
import type { CFamilyReading, Flow, Step } from './uranus-cfamily.ts';
import type { Route, RouteUse } from './uranus-surface.ts';

/* ---- Types ------------------------------------------------------------------------ */

type Tokens = readonly Token[];
type Severity = 'critical' | 'serious' | 'warning';
export type FlowSinkKind = 'sql' | 'command' | 'code' | 'ssrf' | 'path' | 'redirect' | 'dom' | 'html' | 'template' | 'regex' | 'nosql' | 'merge' | 'mass' | 'deserialize' | 'xxe' | 'prompt';
interface SinkSpec {
  readonly rule: string;
  readonly severity: Severity;
  readonly label: string;
}
interface Guard {
  readonly path: string;
  readonly line: number;
}
/* A tainted value, as the walk carries it; `param` is the position of the parameter it stands for while a helper is summarised. */
interface FlowValue {
  kind: string;
  weak: boolean;
  whole: boolean;
  param: number | null;
  sql: boolean;
  html: boolean;
  built: boolean;
  guarded: Guard | null;
  steps: Step[];
  object?: boolean;
  wholeInside?: FlowValue | null;
  spreadKw?: boolean;
}
type Value = FlowValue | null;
interface TaintExtra {
  readonly weak?: boolean | undefined;
  readonly whole?: boolean | undefined;
  readonly param?: number;
  readonly note?: string;
}
/* A name a declaration or parameter binds, and the key it was destructured from. */
interface Binding {
  name: string;
  key: string | null;
  rest?: boolean;
  decorator?: string;
}
/* A function found in the tokens: its parameters' bindings by position and where its body is. */
interface FnInfo {
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
/* One link of a member chain after its root: a computed index, a call, or a tagged template. */
interface IndexStep {
  readonly index: number;
  readonly computed: true;
  readonly open: number;
  readonly close: number;
  readonly args?: undefined;
  readonly tagged?: undefined;
}
interface CallStep {
  readonly index: number;
  readonly computed?: undefined;
  readonly args: Token[][];
  readonly open: number;
  readonly close: number;
  readonly line: number;
  readonly tagged?: undefined;
}
interface TaggedStep {
  readonly index: number;
  readonly computed?: undefined;
  readonly args?: undefined;
  readonly tagged: TemplateToken;
  readonly open: number;
  readonly close: number;
  readonly line: number;
}
type ChainStep = IndexStep | CallStep | TaggedStep;
interface Chain {
  readonly segments: string[];
  readonly calls: ChainStep[];
  readonly end: number;
  readonly start: number;
}
interface Resolved {
  readonly module: string | null;
  readonly name: string;
  readonly path: string[];
  readonly root: string;
}
/* Which names, in the function being walked, are the request, the response and the other carriers of a caller's input. */
interface Roles {
  request: Set<string>;
  response: Set<string>;
  honoCtx: Set<string>;
  params: Set<string>;
  context: Set<string>;
  urlNames: Set<string>;
  message: string | null;
  lambda: boolean;
}
interface HandlerRoles extends Roles {
  actionArgs: boolean;
}
interface PyRoles {
  request: Set<string>;
  lambda: string | null;
}
/* An endpoint the tracer finds, with where its handler's body lies once the walk reaches it. */
interface FlowRoute extends Route {
  route: string | null;
  middleware: string[];
  bodyStart?: number | null;
  bodyEnd?: number | null;
  bodyStartLine?: number;
  bodyEndLine?: number;
  view?: boolean;
  handlerName?: string;
}
type HintKind = 'route' | 'next-route' | 'kit' | 'action' | 'message' | 'lambda';
/* What is known of a function before the walk reaches it: the kind of handler it is, and its endpoint. */
interface Hint {
  readonly kind: HintKind;
  readonly route?: FlowRoute | null;
}
interface ImportEntry {
  readonly module: string;
  readonly name: string;
}
interface SummarySink {
  readonly kind: FlowSinkKind;
  readonly param: number;
  readonly path: string;
  readonly line: number;
  readonly steps: Step[];
  readonly guarded: Guard | null;
}
/* What a function's parameters reach: the sinks each one ends in, and the positions it returns. */
interface Summary {
  readonly sinks: SummarySink[];
  readonly returns: Set<number>;
  readonly fn: FnInfo | undefined;
  readonly name: string;
  readonly line: number | undefined;
}
type FunctionEntry =
  | { readonly fn: FnInfo; summary: Summary | null }
  | { readonly py: true; readonly lineIndex: number; readonly line: number; readonly name: string; readonly indent: number; summary: Summary | null };
/* A name a check settled, and the lines over which it holds. */
interface SettledName {
  readonly name: string;
  readonly from: number;
  readonly to: number;
}
export interface Settled extends SettledName {
  readonly path: string;
}
type FlowBlocker = { readonly reason: 'guarded'; readonly path: string; readonly line: number } | { readonly reason: 'weak-source' } | { readonly reason: FlowSinkKind };
/* A flow from a caller's input to a sink, as the JavaScript and Python walk reports it. */
export interface FlowRecord {
  readonly rule: string;
  readonly kind: FlowSinkKind;
  readonly severity: Severity;
  readonly path: string;
  readonly line: number;
  readonly source: string;
  readonly verdict: 'confirmed' | 'needs-validation';
  readonly blocker: FlowBlocker | null;
  readonly trace: Step[];
  readonly viaHelper: 'function' | 'file' | null;
}
interface ContextBase {
  readonly path: string;
  readonly program: Program;
  readonly imports: Map<string, ImportEntry>;
  readonly functions: Map<string, FunctionEntry>;
  readonly exportsMap: Map<string, string>;
  flows: FlowRecord[];
  routes: FlowRoute[];
  serverActions: boolean;
  readonly client: unknown;
  readonly text: string;
  handlerHints: Map<number, Hint>;
  namedHandlers: Map<string, Hint>;
  uses?: RouteUse[];
  settled?: SettledName[];
  nesting?: number;
  tooDeep?: boolean;
}
interface JsContext extends ContextBase {
  readonly language: 'javascript';
  readonly tokens: Token[];
}
interface PyContext extends ContextBase {
  readonly language: 'python';
  readonly lines: LogicalLine[];
}
type FileContext = JsContext | PyContext;
type Mode = 'summary' | 'flow';
interface Lead {
  readonly literal: string | null;
  readonly value: Value;
}
interface Found {
  readonly kind: string;
  readonly whole?: boolean;
  readonly weak?: boolean;
}
interface CallResult {
  readonly value: Value;
  readonly stop?: boolean;
}
/* A file as the audit hands it over; only one with its text is traced. */
export interface FlowFile {
  readonly path: string;
  readonly text?: unknown;
  readonly client?: unknown;
}
interface ReadableFile extends FlowFile {
  readonly text: string;
}

/* A token that matches nothing: what an index past either end of a list reads as. */
const NO_TOKEN: PlainToken = Object.freeze({ t: 'nl', v: '', line: 0, i: -1 });
function at(tokens: Tokens, index: number): Token {
  return tokens[index] ?? NO_TOKEN;
}
/* A lookup table read by names from the code: no inherited keys, so `toString` or `constructor` finds nothing. */
function frozenTable<T extends object>(entries: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), entries));
}
function table<T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return frozenTable(entries);
}
function entryOf<T>(lookup: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key === undefined ? undefined : lookup[key];
}
function lastOf(list: readonly string[]): string {
  return list[list.length - 1] ?? '';
}

const MAX_STEPS = 6;
const MAX_FLOWS_PER_FILE = 40;
/*
 * How deep one expression may sit inside others -- a call in an argument of a
 * call, a function in a function -- before what lies deeper is left unknown.
 * Real code stays within a few dozen; a crafted file of a hundred thousand
 * nested calls would otherwise be walked level by level until the stack gave
 * out, and the whole file with it.
 */
const MAX_NESTING = 100;
const SQL_WORDS = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE\s+INTO|CREATE|DROP|ALTER|TRUNCATE|WHERE|VALUES|FROM\s+\w)/i;
const HTML_TEXT = /<\s*[a-zA-Z!/]/;
const ABSOLUTE_PREFIX = /^\s*[a-z][a-z0-9+.-]*:\/\/[^/${}\s]+\//i;
const LOCAL_PATH_PREFIX = /^\s*\/(?![/\\])/;

/* ---- Taint -------------------------------------------------------------- */

/*
 * A tainted value: what kind of input it is, where it entered, how it
 * travelled, and a few facts about how it was built that decide whether a
 * given sink is dangerous -- a string that reads as SQL or HTML, a value
 * that is the whole request body, a value that leads a URL.
 */
function taint(kind: string, path: string, line: number, extra: TaintExtra = {}): FlowValue {
  return {
    kind,
    weak: Boolean(extra.weak),
    whole: Boolean(extra.whole),
    param: extra.param !== undefined && Number.isInteger(extra.param) ? extra.param : null,
    sql: false,
    html: false,
    built: false,
    guarded: null,
    steps: [{ path, line, role: 'entrypoint', note: extra.note || `${kind} enters here` }]
  };
}
function extend(value: FlowValue, path: string, line: number, note: string): FlowValue;
function extend(value: Value | undefined, path: string, line: number, note: string): Value;
function extend(value: Value | undefined, path: string, line: number, note: string): Value {
  if (!value) return null;
  const last = value.steps[value.steps.length - 1];
  const steps: Step[] = last && last.path === path && last.line === line ? value.steps : [...value.steps, { path, line, role: 'propagation', note }];
  return { ...value, steps: steps.slice(0, MAX_STEPS) };
}
function merge(a: Value | undefined, b: Value | undefined): Value {
  if (!a) return b ?? null;
  if (!b) return a;
  /* A strong source outranks a weak one, and a real source a parameter placeholder. */
  const rank = (value: FlowValue): number => (value.param !== null ? 0 : value.weak ? 1 : 2);
  const first = rank(b) > rank(a) ? b : a;
  return { ...first, sql: a.sql || b.sql, html: a.html || b.html, built: a.built || b.built, guarded: first.guarded };
}

/* ---- Scope -------------------------------------------------------------- */

class Scope {
  readonly parent: Scope | null;
  readonly vars: Map<string, Value>;
  constructor(parent?: Scope | null) {
    this.parent = parent || null;
    this.vars = new Map();
  }
  lookup(name: string): Value | undefined {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      if (scope.vars.has(name)) return scope.vars.get(name);
    }
    return undefined;
  }
  declare(name: string, value: Value | undefined): void { this.vars.set(name, value || null); }
  assign(name: string, value: Value | undefined): void {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      if (scope.vars.has(name)) { scope.vars.set(name, value || null); return; }
    }
    this.vars.set(name, value || null);
  }
}

/* ---- Sources ------------------------------------------------------------- */

const REQUEST_FIELDS = table<string>({
  body: 'request body', query: 'query string', params: 'route parameter', headers: 'request header',
  cookies: 'cookie', signedCookies: 'cookie', files: 'uploaded file', file: 'uploaded file', rawBody: 'request body',
  url: 'request URL', originalUrl: 'request URL', path: 'request path', hostname: 'request host', host: 'request host',
  queryStringParameters: 'query string', pathParameters: 'route parameter', multiValueQueryStringParameters: 'query string'
});
const REQUEST_BODY_CALLS = new Set(['json', 'formData', 'text', 'arrayBuffer', 'blob', 'parseBody']);
const HONO_CALLS = table<string>({ query: 'query string', queries: 'query string', param: 'route parameter', header: 'request header', json: 'request body', parseBody: 'request body', formData: 'request body', text: 'request body' });
const PY_REQUEST_FIELDS = table<string>({
  args: 'query string', form: 'request body', values: 'request body', json: 'request body', get_json: 'request body',
  data: 'request body', files: 'uploaded file', cookies: 'cookie', headers: 'request header', GET: 'query string',
  POST: 'request body', body: 'request body', query_params: 'query string', path_params: 'route parameter',
  COOKIES: 'cookie', FILES: 'uploaded file', META: 'request header', stream: 'request body', url: 'request URL',
  full_path: 'request URL', path: 'request path'
});
const BROWSER_LOCATION = /^(window\.|document\.|self\.|globalThis\.)?location\.(search|hash|href|pathname)$|^document\.(URL|documentURI|referrer|baseURI)$|^window\.name$/;

/* ---- Sanitisers and propagation -------------------------------------------- */

/*
 * Calls whose result is safe whatever went in: a number, a boolean, an
 * encoded component, a hash, a file's bare name, a schema's parsed output, a
 * validation verdict. Anything else is assumed to carry its input through.
 */
const SANITISER = /^(parseInt|parseFloat|Number|Boolean|BigInt|isNaN|isFinite|encodeURIComponent|escape\w*|htmlEscape|escapeHtml|escapeRegExp|sanitiz\w*|sanitis\w*|purify|clean\w*|validate\w*|verify\w*|isValid\w*|hash\w*|digest|createHash|compare\w*|bcrypt\w*|argon2\w*|uuid\w*|randomUUID|basename|extname|safeParse|parseAsync|safeParseAsync|toNumber|toInteger|toInt|int|float|bool|quote|secure_filename|escape_string|mark_safe_escape|quote_plus|urlencode|slugify|test|includes|startsWith|endsWith|indexOf|lastIndexOf|has|some|every|count\w*|exists|size|toFixed|len|isdigit|isnumeric|isalnum|abs|round|floor|ceil|max|min|typeof|format_number|UUID|uuid4|urlsafe_b64encode|assertPublic\w*|assertSafe\w*|assertAllowed\w*|assertTrusted\w*|assertHttps\w*|requireHttps\w*|requireSafe\w*|ensureSafe\w*|toSafe\w*|safeUrl|safePath|safeJoin|safe_join|cleanPath|normali[sz]eSafe\w*|resolveInside|within\w*)$/;
/* `.parse` is a schema's validation -- except JSON's and a URL module's, which only restructure the input. */
const PASS_THROUGH_PARSE = /^(JSON|url|querystring|qs|URLSearchParams|path|yaml|YAML|toml|json|ast)$/;

/* ---- Sinks -------------------------------------------------------------------- */

/*
 * Sink kinds, the rule each reports under, and how bad a confirmed flow is.
 * A flow into a sink from a model's reply is AI-001 whatever the sink, since
 * the fix is the same: the reply is data, never code or markup.
 */
export const SINKS = frozenTable<Record<FlowSinkKind, SinkSpec>>({
  sql: { rule: 'SEC-001', severity: 'critical', label: 'a SQL statement' },
  command: { rule: 'SEC-011', severity: 'critical', label: 'a shell command' },
  code: { rule: 'SEC-010', severity: 'critical', label: 'code that is executed' },
  ssrf: { rule: 'SEC-021', severity: 'serious', label: 'an outbound request' },
  path: { rule: 'SEC-022', severity: 'serious', label: 'a file path' },
  redirect: { rule: 'SEC-020', severity: 'warning', label: 'a redirect' },
  dom: { rule: 'SEC-002', severity: 'serious', label: 'the page’s HTML' },
  html: { rule: 'SEC-033', severity: 'serious', label: 'an HTML response' },
  template: { rule: 'SEC-030', severity: 'critical', label: 'a server-side template' },
  regex: { rule: 'SEC-026', severity: 'warning', label: 'a regular expression' },
  nosql: { rule: 'SEC-029', severity: 'serious', label: 'a database query object' },
  merge: { rule: 'SEC-027', severity: 'serious', label: 'an object merge' },
  mass: { rule: 'SEC-028', severity: 'serious', label: 'a record written as it arrived' },
  deserialize: { rule: 'SEC-024', severity: 'critical', label: 'a deserializer' },
  xxe: { rule: 'SEC-034', severity: 'serious', label: 'an XML parser that resolves external entities' },
  prompt: { rule: 'AI-002', severity: 'warning', label: 'a model’s instructions' }
});
const MODEL_SINK_SEVERITY = frozenTable<Partial<Record<FlowSinkKind, Severity>>>({ code: 'critical', command: 'critical', sql: 'serious', dom: 'serious', html: 'serious', template: 'critical', deserialize: 'critical', path: 'serious', ssrf: 'serious' });
/* Sinks whose danger depends on facts the code does not show: always something to confirm. */
const JUDGEMENT_SINKS: ReadonlySet<FlowSinkKind> = new Set<FlowSinkKind>(['nosql', 'merge', 'mass', 'prompt']);

const CHILD_PROCESS = /^(node:)?child_process$/;
const FS_MODULE = /^(node:)?fs(\/promises)?$|^fs-extra$/;
const DB_OBJECT = /^(db|pool|client|conn|connection|knex|sequelize|sql|database|pg|mysql|sqlite|tx|trx|cursor|con|session|engine|prisma|supabase|query|dbClient|pgClient|mysqlClient|repo|repository|em|manager|dataSource|queryRunner)$/i;
const MONGO_METHODS = new Set(['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments', 'where', 'find_one', 'update_one', 'update_many', 'delete_one', 'delete_many', 'count_documents', 'find_one_and_update']);
const MASS_METHODS = new Set(['create', 'insert', 'insertMany', 'insertOne', 'update', 'upsert', 'updateOne', 'save', 'build', 'findByIdAndUpdate', 'findOneAndUpdate', 'createMany', 'bulkCreate', 'insert_one', 'insert_many']);
const MERGE_CALLS = /^(merge|mergeWith|defaultsDeep|deepMerge|deepmerge|mergeDeep|extend|assignDeep|set|setWith|unset)$/;
const HTTP_CLIENT_ROOTS = /^(axios|got|needle|superagent|undici|ky|ofetch|\$fetch|http|https)$/;
const MODEL_CHAINS = /(chat\.completions\.create|completions\.create|responses\.create|messages\.create|generate_content|generateContent|ChatCompletion\.create|Completion\.create)$/;
const MODEL_ROOTS = /^(openai|anthropic|client|ai|llm|model|chain|groq|mistral|cohere|genai|gemini|together|replicate|ollama|bedrock|chat|agent|oai|claude)$/i;
const VERCEL_AI = new Set(['generateText', 'streamText', 'generateObject', 'streamObject']);

/* NestJS parameter decorators and what each hands the method. */
const NEST_SOURCES = table<string>({ Body: 'request body', Query: 'query string', Param: 'route parameter', Headers: 'request header', UploadedFile: 'uploaded file', Cookies: 'cookie' });
const EMPTY_ROLES: Roles = Object.freeze<Roles>({ request: new Set(), response: new Set(), honoCtx: new Set(), params: new Set(), context: new Set(), urlNames: new Set(), message: null, lambda: false });
/* Object keys under which a whole request body becomes a stored record. */
const WRITE_KEYS = /^(data|values|set|\$set|attributes|fields|update|doc|document|record|row|payload|input)$/;
/* new Model(req.body) */
const MASS_CONSTRUCT = /^[A-Z][A-Za-z0-9]*$/;
/* Free functions whose result does not carry their argument. */
const NON_CARRYING = /^(require|setTimeout|setInterval|clearTimeout|clearInterval|log|emit|next|resolve|reject|done|cb|callback|push|json|status|alert|confirm|t|i18n|translate|track|captureException|notFound|Boolean|Number|isNaN|isFinite|String\.raw)$/;
/* Methods that pass their argument through, reshaped. */
const CARRYING_METHOD = /^(join|resolve|normalize|format|concat|from|stringify|parse|decodeURIComponent|decodeURI|toString|trim|trimStart|trimEnd|toLowerCase|toUpperCase|slice|substring|substr|replace|replaceAll|split|padStart|padEnd|entries|values|keys|fromEntries|at|flat|map|filter|find|reduce|assign)$/;

/* A test on a value: an allow-list, a comparison, a validator. */
const CHECK_TEXT = /\b(includes|has|startsWith|endsWith|test|match|indexOf|isValid\w*|validate\w*|allow\w*|whitelist|safe\w*|isAbsolute|relative|normalize|isInteger|isSafeInteger|isUUID|isEmail|isURL|matches|contains|in)\b|===|!==|==|!=/;
/* A lookup in a fixed set: ALLOWED.has(x), allowedHosts.includes(x), x in ALLOWED. */
/* Checks that settle a value's shape outright: an integer, a UUID, a whole-string pattern. */
const STRONG_CHECK = /\bNumber\s*\.\s*(isInteger|isSafeInteger)\s*\(|\b(isUUID|isUuid|uuidValidate|isInt|isNumeric|isMongoId)\s*\(|\/\^[^/]*\$\/[a-z]*\s*\.\s*test\s*\(/;
const ALLOW_LIST = /\b([A-Z][A-Z0-9_]{2,}|\w*(allow|whitelist|permitted|trusted|safe|valid)\w*)\s*\.\s*(has|includes)\s*\(|\bin\s+([A-Z][A-Z0-9_]{2,}|\w*(allow|whitelist|permitted|trusted)\w*)\b/i;

function isStr(token: Token | undefined): token is Token & { t: 'str' } { return token !== undefined && (token.t === 'str'); }
function isPunc(token: Token | undefined, value: string): boolean { return token !== undefined && token.t === 'punc' && token.v === value; }
function isWord(token: Token | undefined, value: string): boolean { return token !== undefined && (token.t === 'id' || token.t === 'kw') && token.v === value; }

/* Every string literal and template text in a token range, joined: how a sink's argument reads. */
function literalText(tokens: Tokens): string {
  let out = '';
  for (const token of tokens) {
    if (token.t === 'str') out += `${token.v} `;
    else if (token.t === 'tpl') out += `${token.parts.join(' ')} `;
  }
  return out;
}
/* The literal text an argument opens with, before any value is spliced in. */
function leadingLiteral(tokens: Tokens): string | null {
  const first = tokens.find(token => !(token.t === 'punc' && token.v === '('));
  if (!first) return null;
  if (first.t === 'str') return first.v;
  if (first.t === 'tpl') return first.parts[0] ?? null;
  return null;
}

/* ---- Binding patterns ------------------------------------------------------ */

/*
 * The names a declaration or a parameter binds: a name, or every name inside
 * an object or array pattern, skipping defaults and type annotations.
 */
function bindingNames(tokens: Tokens): Binding[] {
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
function parameters(tokens: Tokens): Binding[][] {
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

const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'with', 'super', 'import']);

/*
 * Whether a function starts at tokens[i], and if so where its parameters and
 * body are. Declarations, expressions, arrows (with or without parentheses,
 * with a block or an expression body) and object and class methods.
 */
function functionAt(tokens: Tokens, i: number, end: number): FnInfo | null {
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
function arrowBody(tokens: Tokens, start: number, bodyAt: number, params: Binding[][], end: number, line: number, isAsync: boolean): FnInfo {
  if (isPunc(tokens[bodyAt], '{')) {
    const bodyEnd = matching(tokens, bodyAt);
    return { start, name: null, params, bodyStart: bodyAt + 1, bodyEnd, next: bodyEnd + 1, line, isAsync, block: true, arrow: true };
  }
  const stop = expressionEnd(tokens, bodyAt, end, true);
  return { start, name: null, params, bodyStart: bodyAt, bodyEnd: stop, next: stop, line, isAsync, block: false, arrow: true };
}
/* A generic parameter list is short; one left open is not looked for to the end of the file. */
const MAX_TYPE_PARAMETERS = 256;
function skipAngles(tokens: Tokens, index: number): number {
  let depth = 0;
  for (let cursor = index; cursor < Math.min(tokens.length, index + MAX_TYPE_PARAMETERS); cursor += 1) {
    if (isPunc(tokens[cursor], '<')) depth += 1;
    else if (isPunc(tokens[cursor], '>')) { depth -= 1; if (depth === 0) return cursor + 1; }
    else if (isPunc(tokens[cursor], '>>')) { depth -= 2; if (depth <= 0) return cursor + 1; }
  }
  return index;
}
/* Past a return-type annotation, to the token that ends it. */
function skipType(tokens: Tokens, index: number, until: string, end: number): number {
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

const CONTINUES = new Set(['.', '?.', '+', '-', '*', '/', '%', '&&', '||', '??', '?', ':', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '|', '&', '^', '=>', '=', '+=', '-=', '**', 'instanceof', 'in', ',']);

/*
 * Where an expression starting at `index` ends: at a top-level semicolon or
 * comma, at a bracket that closes something it did not open, or at a line
 * break where the next line cannot continue it. A bracket it opens is stepped
 * over to its partner -- nothing inside one can end it -- so an arrow nested
 * in an arrow does not walk the rest of the file again at every level. One
 * that never closes before `end` runs the expression to `end`.
 */
function expressionEnd(tokens: Tokens, index: number, end: number, stopAtComma = true): number {
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

/* ---- The analysis of one file ------------------------------------------------ */

/*
 * One file's context: its path, what it imports, which of its functions are
 * request handlers, and where results go. `mode` is 'summary' when a function
 * is being read to learn what its parameters reach, and 'flow' when real
 * sources are followed; only 'flow' reports.
 */
function fileContext(file: ReadableFile, program: Program): ContextBase {
  return {
    path: file.path,
    program,
    imports: new Map(),
    functions: new Map(),
    exportsMap: new Map(),
    flows: [],
    routes: [],
    serverActions: false,
    client: file.client,
    text: file.text,
    handlerHints: new Map(),
    namedHandlers: new Map()
  };
}

/* ---- JavaScript: imports and exports ------------------------------------------- */

function jsImports(tokens: Tokens, ctx: FileContext): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (isWord(token, 'import') && !isPunc(tokens[index + 1], '(') && !isPunc(tokens[index + 1], '.')) {
      /* import a, { b as c }, * as d from 'm' */
      let cursor = index + 1;
      if (isWord(tokens[cursor], 'type')) cursor += 1;
      const bindings: { local: string; imported: string }[] = [];
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
            if (isWord(tokens[inner + 1], 'as') && renamed) { bindings.push({ local: renamed.v, imported: name.v }); inner += 2; continue; }
            if (isPunc(tokens[inner + 1], ',') || isPunc(tokens[inner + 1], '}')) bindings.push({ local: name.v, imported: name.v });
          }
          cursor = close + 1;
          continue;
        }
        cursor += 1;
        if (cursor - index > 80) break;
      }
      const from = isWord(tokens[cursor], 'from') ? tokens[cursor + 1] : tokens[cursor];
      if (isStr(from)) for (const binding of bindings) ctx.imports.set(binding.local, { module: from.v, name: binding.imported });
      continue;
    }
    /* const x = require('m'), const { a, b: c } = require('m'), const x = require('m').y */
    if ((isWord(token, 'const') || isWord(token, 'let') || isWord(token, 'var')) && tokens[index + 1]) {
      const patternEnd = isPunc(tokens[index + 1], '{') || isPunc(tokens[index + 1], '[') ? matching(tokens, index + 1) : index + 1;
      if (!isPunc(tokens[patternEnd + 1], '=')) continue;
      let cursor = patternEnd + 2;
      if (isWord(tokens[cursor], 'await')) cursor += 1;
      const specifier = tokens[cursor + 2];
      if (isWord(tokens[cursor], 'require') && isPunc(tokens[cursor + 1], '(') && isStr(specifier)) {
        const module = specifier.v;
        const property = isPunc(tokens[cursor + 4], '.') ? tokens[cursor + 5]?.v ?? null : null;
        const names = bindingNames(tokens.slice(index + 1, patternEnd + 1));
        for (const binding of names) {
          ctx.imports.set(binding.name, { module, name: property || (binding.key || (names.length === 1 && !isPunc(tokens[index + 1], '{') ? '*' : binding.name)) });
        }
      }
    }
  }
}

function jsExports(tokens: Tokens, ctx: FileContext): void {
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
        const target = tokens[index + 6]?.t === 'id' ? at(tokens, index + 6).v : exported.v;
        ctx.exportsMap.set(exported.v, target);
      }
    }
    const exported = tokens[index + 2];
    if (isWord(token, 'exports') && isPunc(tokens[index + 1], '.') && exported && isPunc(tokens[index + 3], '=') && !isPunc(tokens[index - 1], '.')) {
      const target = tokens[index + 4]?.t === 'id' ? at(tokens, index + 4).v : exported.v;
      ctx.exportsMap.set(exported.v, target);
    }
  }
}

/* ---- JavaScript: the walker ---------------------------------------------------------- */

/*
 * What the current function knows about its own parameters: which name is
 * the request, which the response, and whether its parameters are values a
 * caller controls (a server action's arguments).
 */
function handlerRoles(fn: FnInfo, hint: Hint | null): HandlerRoles {
  const roles: HandlerRoles = { request: new Set(), response: new Set(), honoCtx: new Set(), params: new Set(), urlNames: new Set(), actionArgs: false, message: null, lambda: false, context: new Set() };
  const names = fn.params.map(param => (param.length === 1 && param[0] && !param[0].key ? param[0].name : null));
  const destructured = fn.params.map(param => (param[0] && param[0].key !== null ? param : null));
  if (hint && hint.kind === 'route') {
    if (names[0]) roles.request.add(names[0]);
    if (names[1]) roles.response.add(names[1]);
    if (names[0] && /^(c|ctx|context)$/.test(names[0])) roles.honoCtx.add(names[0]);
  }
  if (hint && hint.kind === 'next-route') {
    if (names[0]) roles.request.add(names[0]);
    if (names[1]) roles.context.add(names[1]);
    if (destructured[1]) for (const binding of destructured[1]) if (binding.key === 'params') roles.params.add(binding.name);
  }
  if (hint && hint.kind === 'kit') {
    /* SvelteKit, Remix and React Router: ({ request, params, url, cookies }) */
    for (const binding of destructured[0] || []) {
      if (binding.key === 'request') roles.request.add(binding.name);
      if (binding.key === 'params') roles.params.add(binding.name);
      if (binding.key === 'url') roles.urlNames.add(binding.name);
    }
    if (names[0]) roles.context.add(names[0]);
  }
  if (hint && hint.kind === 'action') roles.actionArgs = true;
  if (hint && hint.kind === 'message' && names[0]) roles.message = names[0];
  if (hint && hint.kind === 'lambda' && names[0]) { roles.request.add(names[0]); roles.lambda = true; }
  /* By name, anywhere: (req, res), (request, reply), Koa's ctx. */
  names.forEach((name, position) => {
    if (!name) return;
    if (/^(req|request)$/.test(name)) roles.request.add(name);
    if (/^(res|response|reply)$/.test(name) && position > 0) roles.response.add(name);
    if (name === 'ctx' && position === 0) { roles.request.add(name); roles.honoCtx.add(name); }
  });
  return roles;
}

/*
 * A member chain starting at index: `a.b?.c[d]("x").e`. Returns its segments
 * (property names; a computed index is "[]"), the calls along it, and where
 * it ends. The analysis reads a chain as one expression.
 */
function readChain(tokens: Tokens, index: number, end: number): Chain | null {
  const segments: string[] = [];
  const calls: ChainStep[] = [];
  let cursor = index;
  const first = tokens[cursor];
  if (!first || (first.t !== 'id' && !(first.t === 'kw' && ['this', 'super', 'import'].includes(first.v)))) return null;
  segments.push(first.v);
  cursor += 1;
  const start = index;
  while (cursor < end) {
    const token = at(tokens, cursor);
    const next = tokens[cursor + 1];
    if ((isPunc(token, '.') || isPunc(token, '?.')) && next) {
      if (next.t === 'id' || next.t === 'kw') { segments.push(next.v); cursor += 2; continue; }
      if (isPunc(next, '(')) { cursor += 1; continue; }
      if (isPunc(next, '[')) { cursor += 1; continue; }
      break;
    }
    if (isPunc(token, '!') && (isPunc(tokens[cursor + 1], '.') || isPunc(tokens[cursor + 1], '['))) { cursor += 1; continue; }
    if (isPunc(token, '[')) {
      const close = matching(tokens, cursor);
      const inside = tokens.slice(cursor + 1, close);
      const only = inside[0];
      if (inside.length === 1 && isStr(only)) segments.push(only.v);
      else segments.push('[]');
      calls.push({ index: segments.length - 1, computed: true, open: cursor, close });
      cursor = close + 1;
      continue;
    }
    if (isPunc(token, '(')) {
      const { args, close } = splitArgs(tokens, cursor);
      calls.push({ index: segments.length - 1, args, open: cursor, close, line: token.line });
      cursor = close + 1;
      continue;
    }
    if (token.t === 'tpl' && segments.length) {
      /* A tagged template: sql`...`, $`...` */
      calls.push({ index: segments.length - 1, tagged: token, open: cursor, close: cursor, line: token.line });
      cursor += 1;
      continue;
    }
    break;
  }
  return { segments, calls, end: cursor, start };
}

/*
 * Resolve what a callee is: the module it came from and the name it has
 * there, so `exec` imported from child_process and `db.exec` are told apart.
 */
function resolveCallee(segments: readonly string[], ctx: FileContext): Resolved {
  const root = segments[0] ?? '';
  const imported = ctx.imports.get(root);
  if (imported) {
    const rest = segments.slice(1);
    if (imported.name === '*' || imported.name === 'default') return { module: imported.module, name: rest.length ? lastOf(rest) : imported.name, path: rest, root };
    return { module: imported.module, name: rest.length ? lastOf(rest) : imported.name, path: [imported.name, ...rest], root };
  }
  return { module: null, name: lastOf(segments), path: segments.slice(1), root };
}

/* ---- The evaluation of expressions -------------------------------------------------- */

/*
 * The walker. One instance per file per mode; it walks a token range with a
 * scope, evaluates each expression for taint, reports sinks, and descends
 * into nested functions with a child scope so closures see their parents.
 */
class JsWalker {
  tokens: Tokens;
  readonly ctx: FileContext;
  readonly mode: Mode;
  readonly program: Program;
  summaryOf: Summary | null;
  sub: boolean;
  pyRoles: PyRoles | undefined;
  inRoute: boolean | undefined;
  /* how far a check made in the function being walked holds: its last line */
  bodyEndLine: number | undefined;
  constructor(tokens: Tokens, ctx: FileContext, mode: Mode, program: Program) {
    this.tokens = tokens;
    this.ctx = ctx;
    this.mode = mode;
    this.program = program;
    this.summaryOf = null;
    this.sub = false;
  }

  /* A walker over a template's interpolation: the same file, scope and mode, another token list. */
  child(tokens: Tokens): JsWalker {
    const walker = new JsWalker(tokens, this.ctx, this.mode, this.program);
    walker.summaryOf = this.summaryOf;
    walker.sub = true;
    walker.pyRoles = this.pyRoles;
    walker.inRoute = this.inRoute;
    return walker;
  }

  /* ---- statements ---- */
  walk(start: number, end: number, scope: Scope, roles: Roles | null): void {
    const tokens = this.tokens;
    let index = start;
    let guard = 0;
    while (index < end) {
      if ((guard += 1) > 200000) break;
      const token = tokens[index];
      if (!token) break;
      if (isWord(token, 'import') && !isPunc(tokens[index + 1], '(') && !isPunc(tokens[index + 1], '.')) {
        index = expressionEnd(tokens, index, end, false) + 1;
        continue;
      }
      if (isWord(token, 'const') || isWord(token, 'let') || isWord(token, 'var')) {
        index = this.declaration(index + 1, end, scope, roles);
        continue;
      }
      if (isWord(token, 'return') || isWord(token, 'throw')) {
        const stop = expressionEnd(tokens, index + 1, end, false);
        const value = stop > index + 1 ? this.expression(index + 1, stop, scope, roles) : null;
        if (isWord(token, 'return') && value && this.summaryOf && value.param !== null) this.summaryOf.returns.add(value.param);
        index = stop + 1;
        continue;
      }
      if ((isWord(token, 'if') || isWord(token, 'while') || isWord(token, 'switch')) && isPunc(tokens[index + 1], '(')) {
        const close = matching(tokens, index + 1);
        if (!isWord(token, 'switch')) this.guard(index + 2, close, scope);
        this.expression(index + 2, close, scope, roles);
        index = close + 1;
        continue;
      }
      if (isWord(token, 'for') && (isPunc(tokens[index + 1], '(') || (isWord(tokens[index + 1], 'await') && isPunc(tokens[index + 2], '(')))) {
        const open = isPunc(tokens[index + 1], '(') ? index + 1 : index + 2;
        const close = matching(tokens, open);
        /* for (const x of list): x carries what the list carries. */
        let ofAt = -1;
        for (let cursor = open + 1; cursor < close; cursor += 1) if (isWord(tokens[cursor], 'of') || isWord(tokens[cursor], 'in')) { ofAt = cursor; break; }
        if (ofAt > 0) {
          let head = open + 1;
          if (['const', 'let', 'var'].includes(at(tokens, head).v)) head += 1;
          const names = bindingNames(tokens.slice(head, ofAt));
          const value = this.expression(ofAt + 1, close, scope, roles);
          for (const binding of names) scope.declare(binding.name, value && extend(value, this.ctx.path, at(tokens, head).line, 'taken from a list in a loop'));
        } else {
          this.walk(open + 1, close, scope, roles);
        }
        index = close + 1;
        continue;
      }
      if (isWord(token, 'catch') && isPunc(tokens[index + 1], '(')) {
        const close = matching(tokens, index + 1);
        for (const binding of bindingNames(tokens.slice(index + 2, close))) scope.declare(binding.name, null);
        index = close + 1;
        continue;
      }
      if (isWord(token, 'class')) {
        let cursor = index + 1;
        while (cursor < end && !isPunc(tokens[cursor], '{')) cursor += 1;
        if (cursor >= end) { index = cursor; continue; }
        const close = matching(tokens, cursor);
        this.walk(cursor + 1, close, new Scope(scope), roles);
        index = close + 1;
        continue;
      }
      /* Decorators on a class member: skip the @Name(...) and keep going. */
      if (isPunc(token, '@') && tokens[index + 1]?.t === 'id') {
        let cursor = index + 2;
        while (isPunc(tokens[cursor], '.') && tokens[cursor + 1]) cursor += 2;
        if (isPunc(tokens[cursor], '(')) cursor = matching(tokens, cursor) + 1;
        index = cursor;
        continue;
      }
      const fn = functionAt(tokens, index, end);
      if (fn && (fn.name || fn.method)) {
        this.enterFunction(fn, scope, roles, fn.name);
        index = fn.next;
        continue;
      }
      if (isPunc(token, '{')) {
        const close = matching(tokens, index);
        this.walk(index + 1, close, new Scope(scope), roles);
        index = close + 1;
        continue;
      }
      if (token.t === 'punc' && [';', ',', ')', '}', ']', ':'].includes(token.v)) { index += 1; continue; }
      if (token.t === 'kw' && ['else', 'try', 'finally', 'do', 'export', 'default', 'case', 'break', 'continue', 'async'].includes(token.v)) { index += 1; continue; }
      const stop = expressionEnd(tokens, index, end, false);
      if (stop <= index) { index += 1; continue; }
      this.statement(index, stop, scope, roles);
      index = stop + 1;
    }
  }

  declaration(start: number, end: number, scope: Scope, roles: Roles | null): number {
    const tokens = this.tokens;
    let index = start;
    while (index < end) {
      const patternStart = index;
      let patternEnd = index;
      if (isPunc(tokens[index], '{') || isPunc(tokens[index], '[')) patternEnd = matching(tokens, index);
      let cursor = patternEnd + 1;
      if (isPunc(tokens[cursor], '!')) cursor += 1;
      if (isPunc(tokens[cursor], ':')) {
        /* A type annotation between the name and the '=': skip it. */
        let depth = 0;
        cursor += 1;
        while (cursor < end) {
          const t = at(tokens, cursor);
          if (t.t === 'punc' && '(<[{'.includes(t.v)) depth += 1;
          if (t.t === 'punc' && ')>]}'.includes(t.v)) depth -= 1;
          if (depth <= 0 && (isPunc(t, '=') || isPunc(t, ';') || isPunc(t, ','))) break;
          if (depth === 0 && t.line > at(tokens, patternEnd).line && !isPunc(t, '|') && !isPunc(t, '&')) break;
          cursor += 1;
        }
      }
      const names = bindingNames(tokens.slice(patternStart, patternEnd + 1));
      if (!isPunc(tokens[cursor], '=')) {
        for (const binding of names) scope.declare(binding.name, null);
        if (isPunc(tokens[cursor], ',')) { index = cursor + 1; continue; }
        return cursor;
      }
      const valueStart = cursor + 1;
      const fn = functionAt(tokens, valueStart, end);
      const only = names.length === 1 ? names[0] : undefined;
      if (fn && only) {
        scope.declare(only.name, null);
        this.enterFunction(fn, scope, roles, only.name);
        const stop = expressionEnd(tokens, fn.next, end, true);
        if (stop > fn.next) this.expression(fn.next, stop, scope, roles);
        if (!isPunc(tokens[stop], ',')) return stop + 1;
        index = stop + 1;
        continue;
      }
      const stop = expressionEnd(tokens, valueStart, end, true);
      const value = this.expression(valueStart, stop, scope, roles);
      const destructured = isPunc(tokens[patternStart], '{') || isPunc(tokens[patternStart], '[');
      for (const binding of names) {
        let bound = value;
        if (bound && destructured && !binding.rest) bound = { ...bound, whole: false, object: false, wholeInside: null };
        scope.declare(binding.name, bound && extend(bound, this.ctx.path, at(tokens, patternStart).line, bound.built ? 'built into a string' : destructured ? 'taken out of an object' : 'assigned to a variable'));
      }
      if (!isPunc(tokens[stop], ',')) return stop + 1;
      index = stop + 1;
    }
    return index;
  }

  statement(start: number, stop: number, scope: Scope, roles: Roles | null): void {
    const tokens = this.tokens;
    let depth = 0;
    for (let index = start; index < stop; index += 1) {
      const token = at(tokens, index);
      if (token.t === 'punc' && '([{'.includes(token.v)) depth += 1;
      if (token.t === 'punc' && ')]}'.includes(token.v)) depth -= 1;
      if (depth !== 0 || token.t !== 'punc') continue;
      if (token.v === '=>') break;
      if (['=', '+=', '||=', '??=', '&&='].includes(token.v)) {
        const value = this.expression(index + 1, stop, scope, roles);
        this.assignTarget(start, index, value, scope, roles, token);
        return;
      }
    }
    this.expression(start, stop, scope, roles);
  }

  assignTarget(start: number, eq: number, value: Value, scope: Scope, roles: Roles | null, operator: Token): void {
    const tokens = this.tokens;
    const target = tokens.slice(start, eq);
    const head = target[0];
    if (!head) return;
    const line = at(tokens, start).line;
    const last = target[target.length - 1];
    /* element.innerHTML = x, element.outerHTML += x: the DOM. */
    if (last && (last.v === 'innerHTML' || last.v === 'outerHTML') && (isPunc(target[target.length - 2], '.') || isPunc(target[target.length - 2], '?.'))) {
      if (value) this.sink('dom', value, line);
      return;
    }
    /* window.location = x / location.href = x: a redirect in the browser. */
    const targetText = target.map(t => t.v).join('');
    if (/^(window\.|document\.)?location(\.href)?$/.test(targetText) && value && !value.weak) {
      this.sink('redirect', value, line);
      return;
    }
    /* obj[a][b] = v with a key the caller chose: prototype pollution. */
    if (target.filter(t => isPunc(t, '[')).length >= 2) {
      const chain = readChain(tokens, start, eq);
      if (chain) {
        const keyTaint = chain.calls.filter(call => call.computed).map(call => this.expression(call.open + 1, call.close, scope, roles)).find(Boolean);
        if (keyTaint && keyTaint.param === null) this.sink('merge', keyTaint, line);
        else if (keyTaint && keyTaint.param !== null) this.sink('merge', keyTaint, line);
      }
    }
    if (target.length === 1 && head.t === 'id') {
      const previous = scope.lookup(head.v);
      let next = value && extend(value, this.ctx.path, line, value.built ? 'built into a string' : 'assigned to a variable');
      if (operator.v !== '=') next = merge(previous || null, next);
      scope.assign(head.v, next);
      return;
    }
    if (isPunc(head, '{') || isPunc(head, '[') || (isPunc(head, '(') && isPunc(target[1], '{'))) {
      for (const binding of bindingNames(isPunc(head, '(') ? target.slice(1) : target)) {
        scope.assign(binding.name, value && extend({ ...value, whole: false }, this.ctx.path, line, 'taken out of an object'));
      }
    }
  }

  /* if (cond): a value tested before use is still followed, marked as checked. */
  guard(start: number, stop: number, scope: Scope): void {
    const tokens = this.tokens;
    const text = tokens.slice(start, stop).map(t => t.v).join(' ');
    if (!CHECK_TEXT.test(text)) return;
    /* An allow-list lookup or a check of the value's whole shape settles it; any other test leaves it to be confirmed. */
    const allowList = ALLOW_LIST.test(text) || STRONG_CHECK.test(text);
    for (let index = start; index < stop; index += 1) {
      const token = at(tokens, index);
      if (token.t !== 'id' || isPunc(tokens[index - 1], '.') || isPunc(tokens[index - 1], '?.')) continue;
      /* settled: a line that splices only settled names is not a lead either, whatever the name held */
      if (allowList && this.mode === 'flow' && Array.isArray(this.ctx.settled)) this.ctx.settled.push({ name: token.v, from: token.line, to: this.bodyEndLine || Infinity });
      const value = scope.lookup(token.v);
      if (!value) continue;
      if (allowList) scope.assign(token.v, null);
      else if (!value.guarded) scope.assign(token.v, { ...value, guarded: { path: this.ctx.path, line: token.line } });
    }
  }

  enterFunction(fn: FnInfo, scope: Scope, roles: Roles | null, name: string | null): void {
    const child = new Scope(scope);
    const hint = this.sub ? null : this.hintFor(fn, name);
    const inner = handlerRoles(fn, hint);
    fn.params.forEach((param, position) => {
      for (const binding of param) {
        let value: Value = null;
        const nest = binding.decorator === undefined ? undefined : entryOf(NEST_SOURCES, binding.decorator);
        if (this.mode === 'summary' && this.summaryOf && this.summaryOf.fn === fn) {
          value = taint('parameter', this.ctx.path, fn.line, { param: position, note: 'a parameter' });
        } else if (inner.actionArgs) {
          value = taint('action argument', this.ctx.path, fn.line, { note: 'a server action’s argument, sent by the browser' });
        } else if (binding.decorator && nest) {
          value = taint(nest, this.ctx.path, fn.line, { whole: binding.decorator === 'Body' && param.length === 1, note: `${nest} enters here` });
        } else if (inner.params.has(binding.name)) {
          value = taint('route parameter', this.ctx.path, fn.line, { note: 'a route parameter enters here' });
        }
        child.declare(binding.name, value);
        if (binding.decorator === 'Req' || binding.decorator === 'Request') inner.request.add(binding.name);
        if (binding.decorator === 'Res' || binding.decorator === 'Response') inner.response.add(binding.name);
      }
    });
    const parentRoles = roles || EMPTY_ROLES;
    const merged: Roles = {
      request: new Set([...parentRoles.request, ...inner.request]),
      response: new Set([...parentRoles.response, ...inner.response]),
      honoCtx: new Set([...parentRoles.honoCtx, ...inner.honoCtx]),
      params: new Set([...parentRoles.params, ...inner.params]),
      context: new Set([...parentRoles.context, ...inner.context]),
      urlNames: new Set([...parentRoles.urlNames, ...inner.urlNames]),
      message: inner.message || parentRoles.message,
      lambda: inner.lambda || parentRoles.lambda
    };
    /* A parameter that reuses the parent's request name is not the request here. */
    for (const param of fn.params) for (const binding of param) {
      if (!inner.request.has(binding.name)) { merged.request.delete(binding.name); merged.honoCtx.delete(binding.name); }
      if (!inner.response.has(binding.name)) merged.response.delete(binding.name);
    }
    /* how far a check made in this function holds: to its last line */
    const outerEnd = this.bodyEndLine;
    this.bodyEndLine = this.tokens[fn.bodyEnd]?.line ?? outerEnd;
    if (fn.block) this.walk(fn.bodyStart, fn.bodyEnd, child, merged);
    else {
      const value = this.expression(fn.bodyStart, fn.bodyEnd, child, merged);
      if (value && this.summaryOf && this.summaryOf.fn === fn && value.param !== null) this.summaryOf.returns.add(value.param);
    }
    this.bodyEndLine = outerEnd;
    if (hint && hint.route && this.mode === 'flow') {
      hint.route.bodyStart = fn.bodyStart;
      hint.route.bodyEnd = fn.bodyEnd;
      hint.route.handlerLine = fn.line;
    }
  }

  hintFor(fn: FnInfo, name: string | null): Hint | null {
    const hint = this.ctx.handlerHints.get(fn.start);
    if (hint) return hint;
    const named = name ? this.ctx.namedHandlers.get(name) : undefined;
    if (named) return named;
    return null;
  }

  /* ---- expressions ---- */
  /* Every walker evaluates through here, so nesting is counted once for the file, whichever walker recurses. */
  expression(start: number, stop: number, scope: Scope, roles: Roles | null): Value {
    const ctx = this.ctx;
    const depth = ctx.nesting || 0;
    if (depth >= MAX_NESTING) { ctx.tooDeep = true; return null; }
    ctx.nesting = depth + 1;
    try { return this.evaluate(start, stop, scope, roles); } finally { ctx.nesting = depth; }
  }

  evaluate(start: number, stop: number, scope: Scope, roles: Roles | null): Value {
    const ternary = this.ternary(start, stop, scope, roles);
    if (ternary !== undefined) return ternary;
    const tokens = this.tokens;
    let result: Value = null;
    let index = start;
    let concat = false;
    let sawString = false;
    let sawTemplate = false;
    while (index < stop) {
      const token = tokens[index];
      if (!token) break;
      const fn = functionAt(tokens, index, stop);
      if (fn) {
        this.enterFunction(fn, scope, roles, null);
        index = Math.max(fn.next, index + 1);
        continue;
      }
      if (token.t === 'tpl') {
        result = merge(result, this.template(token, scope, roles));
        sawString = true;
        sawTemplate = true;
        index += 1;
        continue;
      }
      if (token.t === 'str') { sawString = true; index += 1; continue; }
      if (isPunc(token, '+')) { concat = true; index += 1; continue; }
      if (isWord(token, 'new')) {
        const chain = readChain(tokens, index + 1, stop);
        if (chain) {
          result = merge(result, this.newExpression(chain, scope, roles));
          index = Math.max(chain.end, index + 2);
          continue;
        }
        index += 1;
        continue;
      }
      if (token.t === 'id' || (token.t === 'kw' && ['this', 'super'].includes(token.v))) {
        const chain = readChain(tokens, index, stop);
        if (chain) {
          result = merge(result, this.chain(chain, scope, roles, undefined));
          index = Math.max(chain.end, index + 1);
          continue;
        }
      }
      if (isPunc(token, '(') || isPunc(token, '[') || isPunc(token, '{')) {
        const close = matching(tokens, index);
        let value: Value;
        if (isPunc(token, '{')) value = this.objectLiteral(index, close, scope, roles);
        else if (isPunc(token, '[')) value = this.arrayLiteral(index, close, scope, roles);
        else value = this.expression(index + 1, close, scope, roles);
        /* (await x.json()).field and (a || b).trim(): keep reading the chain on the value. */
        if (isPunc(token, '(') && (isPunc(tokens[close + 1], '.') || isPunc(tokens[close + 1], '?.'))) {
          const virtual: Token[] = [{ t: 'id', v: '#value', line: token.line, i: close }, ...tokens.slice(close + 1, stop)];
          const chain = readChain(virtual, 0, virtual.length);
          if (chain) {
            const inner = new Scope(scope);
            inner.declare('#value', value);
            const walker = this.child(virtual);
            result = merge(result, walker.chain(chain, inner, roles, undefined));
            index = close + chain.end;
            continue;
          }
        }
        result = merge(result, value);
        index = close + 1;
        continue;
      }
      index += 1;
    }
    if (result && sawString && (concat || sawTemplate)) {
      const text = literalText(tokens.slice(start, stop));
      result = { ...result, built: true, sql: result.sql || SQL_WORDS.test(text), html: result.html || HTML_TEXT.test(text), whole: false, wholeInside: null };
    }
    return result;
  }

  /*
   * cond ? a : b. A condition that checks the value against an allow-list or
   * compares it (`ALLOWED.includes(x) ? x : 'name'`) makes the result one of
   * a known set: nothing to follow. Otherwise the result is either branch.
   */
  ternary(start: number, stop: number, scope: Scope, roles: Roles | null): Value | undefined {
    const tokens = this.tokens;
    let depth = 0;
    let question = -1;
    let colon = -1;
    let nested = 0;
    for (let index = start; index < stop; index += 1) {
      const token = at(tokens, index);
      if (token.t === 'punc' && '([{'.includes(token.v)) depth += 1;
      if (token.t === 'punc' && ')]}'.includes(token.v)) depth -= 1;
      if (depth !== 0 || token.t !== 'punc') continue;
      if (token.v === '=>') return undefined;
      if (token.v === '?') { if (question < 0) question = index; else nested += 1; }
      else if (token.v === ':' && question >= 0) { if (nested) nested -= 1; else { colon = index; break; } }
    }
    if (question <= start || colon < 0) return undefined;
    this.expression(start, question, scope, roles);
    const condition = tokens.slice(start, question).map(t => t.v).join(' ');
    const yes = this.expression(question + 1, colon, scope, roles);
    const no = this.expression(colon + 1, stop, scope, roles);
    if (ALLOW_LIST.test(condition)) return null;
    return merge(yes, no);
  }

  template(token: TemplateToken, scope: Scope, roles: Roles | null): Value {
    let value: Value = null;
    for (const expr of token.exprs) value = merge(value, this.child(expr).expression(0, expr.length, scope, roles));
    if (!value) return null;
    const text = token.parts.join(' ');
    return { ...value, built: true, sql: value.sql || SQL_WORDS.test(text), html: value.html || HTML_TEXT.test(text), whole: false, wholeInside: null };
  }

  arrayLiteral(open: number, close: number, scope: Scope, roles: Roles | null): Value {
    const value = this.expression(open + 1, close, scope, roles);
    return value ? { ...value, whole: false, wholeInside: null } : null;
  }

  objectLiteral(open: number, close: number, scope: Scope, roles: Roles | null): Value {
    const tokens = this.tokens;
    let result: Value = null;
    let wholeInside: Value = null;
    let index = open + 1;
    while (index < close) {
      const token = tokens[index];
      if (!token) break;
      /* dangerouslySetInnerHTML={{ __html: value }} */
      if (token.t === 'id' && token.v === '__html' && isPunc(tokens[index + 1], ':')) {
        const stop = expressionEnd(tokens, index + 2, close, true);
        const value = this.expression(index + 2, stop, scope, roles);
        if (value) this.sink('dom', value, token.line);
        index = stop + 1;
        continue;
      }
      const fn = functionAt(tokens, index, close);
      if (fn) { this.enterFunction(fn, scope, roles, fn.name); index = Math.max(fn.next, index + 1); continue; }
      if ((token.t === 'id' || token.t === 'str' || token.t === 'kw') && isPunc(tokens[index + 1], ':')) {
        const stop = expressionEnd(tokens, index + 2, close, true);
        const value = this.expression(index + 2, stop, scope, roles);
        if (value && (value.whole || value.wholeInside) && WRITE_KEYS.test(token.v)) wholeInside = value.whole ? value : value.wholeInside ?? null;
        result = merge(result, value);
        index = stop + 1;
        continue;
      }
      if (isPunc(token, '...')) {
        const stop = expressionEnd(tokens, index + 1, close, true);
        const value = this.expression(index + 1, stop, scope, roles);
        if (value && value.whole) wholeInside = value;
        result = merge(result, value);
        index = stop + 1;
        continue;
      }
      if (token.t === 'id' && (isPunc(tokens[index + 1], ',') || index + 1 >= close)) {
        const value = scope.lookup(token.v) || null;
        if (value && value.whole && WRITE_KEYS.test(token.v)) wholeInside = value;
        result = merge(result, value);
        index += 2;
        continue;
      }
      index += 1;
    }
    if (!result) return null;
    return { ...result, whole: false, object: true, wholeInside };
  }

  newExpression(chain: Chain, scope: Scope, roles: Roles | null): Value {
    const call = chain.calls[0];
    if (!call || !call.args) return null;
    /* The constructor is the chain up to its own call: new a.B(x).c() constructs a.B. */
    const name = chain.segments[call.index] ?? '';
    const args = call.args.map(arg => this.argValue(arg, scope, roles));
    const line = call.line;
    const any = args.find(Boolean);
    if (name === 'Function' && any) { this.sink('code', any, line); return null; }
    if (name === 'RegExp' && args[0]) { this.sink('regex', args[0], line); return null; }
    if (name === 'Response' && args[0]?.html) { this.sink('html', args[0], line); return null; }
    const first = args[0];
    if (/^(Worker|Script)$/.test(name) && first && (chain.segments[0] === 'vm' || name === 'Worker')) { this.sink('code', first, line); return null; }
    let value: Value = null;
    if ((name === 'URL' || name === 'URLSearchParams' || name === 'Request' || name === 'Headers') && first) value = extend(first, this.ctx.path, line, 'parsed as a URL');
    else if (MASS_CONSTRUCT.test(name) && first && (first.whole || first.wholeInside) && !/^(URL|Map|Set|Error|Date|Promise|Response|Request|Headers|FormData|Blob|Buffer|Array|Object|String|Number|RegExp|WeakMap|NextResponse)$/.test(name)) {
      this.sink('mass', first.whole ? first : first.wholeInside, line);
      return null;
    }
    /* new URLSearchParams(location.search).get('q'): the chain goes on from the new object. */
    for (const next of chain.calls.slice(1)) {
      if (next.computed) continue;
      const result = this.call(chain.segments.slice(0, next.index + 1), next, value, scope, roles);
      value = result ? result.value : null;
    }
    return value;
  }

  /* An argument's value: its tokens evaluated where they sit. */
  argValue(arg: Tokens | undefined, scope: Scope, roles: Roles | null): Value {
    const head = arg?.[0];
    const tail = arg?.[arg.length - 1];
    if (!arg || !head || !tail) return null;
    const first = head.i;
    const last = tail.i;
    if (Number.isInteger(first) && Number.isInteger(last) && this.tokens[first] === head && this.tokens[last] === tail) {
      return this.expression(first, last + 1, scope, roles);
    }
    return this.child(arg).expression(0, arg.length, scope, roles);
  }

  /*
   * The value that leads an argument: the first operand before any `+`, or
   * a template's first piece. `fetch(BASE + id)` is led by a constant, and
   * `res.redirect('/x/' + id)` by a local path; only a value the caller
   * controls at the front can choose where a request or a redirect goes.
   */
  lead(arg: Tokens | undefined, scope: Scope, roles: Roles | null): Lead {
    const first = arg?.[0];
    if (!arg || !first) return { literal: null, value: null };
    if (first.t === 'str') return { literal: first.v, value: null };
    if (first.t === 'tpl') {
      const opening = first.parts[0];
      if (opening) return { literal: opening, value: null };
      const expr = first.exprs[0];
      return { literal: null, value: expr ? this.child(expr).expression(0, expr.length, scope, roles) : null };
    }
    let depth = 0;
    let cut = arg.length;
    for (let index = 0; index < arg.length; index += 1) {
      const token = at(arg, index);
      if (token.t === 'punc' && '([{'.includes(token.v)) depth += 1;
      if (token.t === 'punc' && ')]}'.includes(token.v)) depth -= 1;
      if (depth === 0 && isPunc(token, '+')) { cut = index; break; }
    }
    return { literal: null, value: this.argValue(arg.slice(0, cut), scope, roles) };
  }

  /* Is this chain something a caller sends? */
  source(segments: readonly string[], chain: Chain, roles: Roles | null): Found | null {
    const root = segments[0] ?? '';
    if (roles && roles.request.has(root)) {
      const field = segments[1];
      const nested = entryOf(REQUEST_FIELDS, segments[2]);
      if (roles.honoCtx.has(root) && field === 'req') {
        if (nested) return { kind: nested };
        return null;
      }
      if (root === 'ctx' && field === 'request' && nested) return { kind: nested, whole: segments.length === 3 && segments[2] === 'body' };
      const kind = entryOf(REQUEST_FIELDS, field);
      if (root === 'ctx' && (field === 'query' || field === 'params') && kind) return { kind };
      if (field && kind) {
        if (roles.lambda && !['body', 'queryStringParameters', 'pathParameters', 'headers', 'multiValueQueryStringParameters'].includes(field)) return null;
        if (field === 'url' && chain.calls.length) return { kind };
        /* the whole body, or the whole parsed query string (qs turns ?a[$ne]=1 into an object) */
        return { kind, whole: segments.length === 2 && (field === 'body' || field === 'query') && !chain.calls.length };
      }
      if (field === 'nextUrl' && segments.includes('searchParams')) return { kind: 'query string' };
    }
    if (roles && roles.context.has(root) && segments[1] === 'params') return { kind: 'route parameter' };
    if (roles && roles.urlNames && roles.urlNames.has(root) && segments[1] === 'searchParams') return { kind: 'query string' };
    if (roles && roles.message && roles.message === root && segments[1] === 'data') return { kind: 'message from another window' };
    const joined = segments.join('.');
    /* location.hash.slice(1): the URL is what the first call is made on */
    const opening = chain.calls[0];
    const head = opening ? segments.slice(0, opening.index).join('.') : joined;
    if (BROWSER_LOCATION.test(joined) || BROWSER_LOCATION.test(head)) return { kind: 'the page’s URL' };
    if (/^(router)\.query$/.test(joined) || /^(this\.)?\$route\.(query|params)$/.test(joined) || /^route\.(query|params)$/.test(joined)) return { kind: 'the page’s URL' };
    return null;
  }

  chain(chain: Chain, scope: Scope, roles: Roles | null, receiver?: Value): Value {
    const tokens = this.tokens;
    const segments = chain.segments;
    const line = tokens[chain.start]?.line ?? 0;
    let value = receiver;
    if (value === undefined) {
      const found = this.source(segments, chain, roles);
      if (found) value = taint(found.kind, this.ctx.path, line, { whole: found.whole, weak: found.weak });
      else {
        const held = scope.lookup(segments[0] ?? '');
        value = held || null;
      }
      if (!value && segments[0] === 'useSearchParams') value = taint('the page’s URL', this.ctx.path, line);
      /* A count is not content: x.length, x.size, x.byteLength carry nothing the caller wrote. */
      if (value && segments.slice(1).some(segment => /^(length|size|byteLength|count|isArray)$/.test(segment))) value = null;
      /* A field read off the whole body is no longer the whole body. */
      if (value && segments.length > 1 && value.whole && !found) value = { ...value, whole: false, wholeInside: null };
    }
    for (const call of chain.calls) {
      if (call.computed) {
        this.expression(call.open + 1, call.close, scope, roles);
        if (value && value.whole) value = { ...value, whole: false };
        continue;
      }
      const calleeSegments = segments.slice(0, call.index + 1);
      const result = this.call(calleeSegments, call, value, scope, roles);
      value = result ? result.value : null;
      if (result && result.stop) break;
    }
    return value;
  }

  /*
   * One call: report a sink if a caller's value reaches one, and say what the
   * call returns -- nothing for a sanitiser, the model's reply for a model,
   * the argument for a helper that returns it, the receiver for a method.
   */
  call(segments: readonly string[], call: CallStep | TaggedStep, receiver: Value, scope: Scope, roles: Roles | null): CallResult {
    const name = lastOf(segments);
    const line = call.line || 0;
    if (call.tagged) {
      const value = this.template(call.tagged, scope, roles);
      /* sql`...` from a tagged-template library is parameterised; zx's $`...` runs a shell. */
      if (value && segments.length === 1 && segments[0] === '$') this.sink('command', value, line);
      return { value: null, stop: true };
    }
    const args = call.args.map(arg => this.argValue(arg, scope, roles));
    const resolved = resolveCallee(segments, this.ctx);
    const module = resolved.module || '';
    const root = segments[0] ?? '';
    const objectName = segments.length > 1 ? segments[segments.length - 2] ?? '' : '';
    const r = roles || EMPTY_ROLES;

    /* A request's body, read by a call: await request.json(), c.req.query('q'). */
    if (r.request.has(root) && segments.length === 2 && REQUEST_BODY_CALLS.has(name)) {
      return { value: taint('request body', this.ctx.path, line, { whole: name === 'json' || name === 'formData' }) };
    }
    const hono = entryOf(HONO_CALLS, name);
    if (r.honoCtx.has(root) && segments[1] === 'req' && hono) {
      return { value: taint(hono, this.ctx.path, line, { whole: name === 'json' || name === 'parseBody' }) };
    }
    if (receiver && ['get', 'getAll'].includes(name) && (segments.includes('searchParams') || segments.includes('query') || receiver.kind === 'query string' || receiver.kind === 'the page’s URL' || receiver.kind === 'request body')) {
      return { value: extend({ ...receiver, whole: false }, this.ctx.path, line, 'read from the request') };
    }

    /* A model's reply is data somebody else's prompt shaped. */
    const chainText = segments.join('.');
    const modelCall = (MODEL_CHAINS.test(chainText) && (MODEL_ROOTS.test(root) || /openai|anthropic|groq|mistral|cohere|google|genai|@ai-sdk/i.test(module)) &&
      call.args.some(arg => arg.some(t => t.t === 'id' && ['model', 'messages', 'contents', 'input', 'prompt'].includes(t.v)))) || (VERCEL_AI.has(name) && segments.length === 1);
    if (modelCall) {
      this.promptSink(call, scope, roles);
      return { value: taint('model reply', this.ctx.path, line, { note: 'a language model’s reply enters here' }) };
    }

    /* Sanitisers. */
    if (SANITISER.test(name) && !(name === 'parse' && PASS_THROUGH_PARSE.test(objectName))) return { value: null };

    if (this.sinkForCall(segments, module, name, objectName, args, call, receiver, r, line, scope, roles)) return { value: null };

    /* A helper this file or an imported file defines. */
    const summary = this.summaryFor(segments, resolved);
    if (summary) {
      args.forEach((value, position) => {
        if (!value) return;
        for (const sink of summary.sinks.filter(entry => entry.param === position)) this.throughHelper(value, sink, line, call.args[position] ?? null, scope, roles);
      });
      const returned = [...summary.returns].map(position => args[position]).find(Boolean);
      return { value: returned ? extend(returned, this.ctx.path, line, 'passed through a function') : null };
    }

    const any = args.find(Boolean);
    /* Methods on a tainted value carry it: .trim(), .toString(), .then(...). */
    if (receiver) {
      if (/^(then|catch|finally)$/.test(name)) return { value: receiver };
      if (/^(json|text|formData)$/.test(name) && receiver.kind === 'request body') return { value: receiver };
      return { value: extend({ ...receiver, whole: false, wholeInside: null }, this.ctx.path, line, 'transformed') };
    }
    if (any && segments.length === 1 && !NON_CARRYING.test(name)) return { value: extend({ ...any, whole: false }, this.ctx.path, line, 'passed through a function') };
    if (any && segments.length > 1 && CARRYING_METHOD.test(name)) {
      if (name === 'stringify' || name === 'parse') return { value: { ...any, whole: false, wholeInside: null } };
      return { value: extend({ ...any, whole: false, wholeInside: null }, this.ctx.path, line, name === 'join' || name === 'resolve' ? 'joined into a path' : 'transformed') };
    }
    return { value: null };
  }

  /* A system prompt or a system message built from what a caller sent. */
  promptSink(call: CallStep, scope: Scope, roles: Roles | null): void {
    const tokens = this.tokens;
    for (let index = call.open + 1; index < call.close; index += 1) {
      const token = tokens[index];
      if (!token) break;
      if (token.t === 'id' && (token.v === 'system' || token.v === 'instructions') && isPunc(tokens[index + 1], ':')) {
        const stop = expressionEnd(tokens, index + 2, call.close, true);
        const value = this.expression(index + 2, stop, scope, roles);
        if (value && value.kind !== 'model reply') this.sink('prompt', value, token.line);
      }
      if (token.t === 'id' && token.v === 'role' && isPunc(tokens[index + 1], ':') && tokens[index + 2]?.t === 'str' && at(tokens, index + 2).v === 'system') {
        let cursor = index + 3;
        while (cursor < call.close && !(at(tokens, cursor).t === 'id' && at(tokens, cursor).v === 'content' && isPunc(tokens[cursor + 1], ':')) && !isPunc(tokens[cursor], '}')) cursor += 1;
        const content = tokens[cursor];
        if (content && content.v === 'content') {
          const stop = expressionEnd(tokens, cursor + 2, call.close, true);
          const value = this.expression(cursor + 2, stop, scope, roles);
          if (value && value.kind !== 'model reply') this.sink('prompt', value, content.line);
        }
      }
    }
  }

  sinkForCall(segments: readonly string[], module: string, name: string, objectName: string, args: readonly Value[], call: CallStep, receiver: Value, r: Roles, line: number, scope: Scope, roles: Roles | null): boolean {
    const first = args[0];
    const root = segments[0] ?? '';
    const argTokens = (index: number): Tokens => call.args[index] || [];
    /* Code. */
    if ((segments.length === 1 && (name === 'eval' || name === 'Function')) || ((/^(node:)?vm$/.test(module) || root === 'vm') && /^(runIn\w*|compileFunction)$/.test(name))) {
      const value = args.find(Boolean);
      if (value) { this.sink('code', value, line); return true; }
      return false;
    }
    if ((name === 'setTimeout' || name === 'setInterval') && segments.length === 1 && first && first.built) { this.sink('code', first, line); return true; }
    /* Shell. */
    const childProcess = CHILD_PROCESS.test(module) || /^(child_process|cp|childProcess|proc)$/.test(root);
    if ((childProcess || /^(shell|shelljs)$/.test(root)) && /^(exec|execSync)$/.test(name)) {
      if (first) { this.sink('command', first, line); return true; }
      return false;
    }
    if (childProcess && /^(spawn|spawnSync|execFile|execFileSync)$/.test(name)) {
      const shell = call.args.some(arg => arg.some((t, i) => t.v === 'shell' && isPunc(arg[i + 1], ':') && arg[i + 2] !== undefined && at(arg, i + 2).v !== 'false'));
      if (first && shell) { this.sink('command', first, line); return true; }
      return false;
    }
    if ((module === 'execa' || root === 'execa') && /^(command|commandSync|execaCommand|execaCommandSync)$/.test(name) && first) { this.sink('command', first, line); return true; }
    /* SQL. */
    if (/^(\$queryRawUnsafe|\$executeRawUnsafe|unsafe)$/.test(name) && first) { this.sink('sql', first, line); return true; }
    if (name === 'raw' && /^(knex|db|trx|sequelize|sql|Prisma|drizzle|database)$/i.test(objectName) && first) { this.sink('sql', first, line); return true; }
    if (/^(whereRaw|orWhereRaw|havingRaw|orderByRaw|joinRaw|selectRaw|groupByRaw|fromRaw)$/.test(name) && first && first.built) { this.sink('sql', first, line); return true; }
    if (/^(query|execute|exec|all|get|run|prepare|each|many|one|none|any|oneOrNone|manyOrNone|result|sql)$/.test(name) && segments.length > 1 && first) {
      const dbLike = DB_OBJECT.test(objectName) || /(^pg$|mysql|sqlite|postgres|mssql|oracledb|pg-promise|sequelize|knex|@neondatabase|@vercel\/postgres|@planetscale|libsql|drizzle|typeorm|mikro-orm)/.test(module);
      if (first.sql && (dbLike || /^(query|execute)$/.test(name))) { this.sink('sql', first, line); return true; }
      if (dbLike && first.built && /^(query|execute|exec|all|run|prepare|many|one|none|any)$/.test(name)) { this.sink('sql', first, line); return true; }
    }
    if (segments.length === 1 && /^(query|execute|sql)$/.test(name) && first && first.sql) { this.sink('sql', first, line); return true; }
    /* Server-side templates. */
    if ((/^(ejs|pug|jade|handlebars|Handlebars|nunjucks|mustache|Mustache|_|lodash|dot|hogan|Eta|eta)$/.test(root) || /^(ejs|pug|handlebars|nunjucks|mustache|lodash|eta)$/.test(module)) && /^(render|compile|template|renderString|compileTemplate)$/.test(name) && first) {
      this.sink('template', first, line); return true;
    }
    /* Outbound requests from the server. */
    const httpCall = (segments.length === 1 && (/^(fetch|got|needle|ky|ofetch|\$fetch|axios|undiciFetch)$/.test(name) || (name === 'request' && /^(request|undici|needle|got)$/.test(module))) && !r.request.has(root) && !this.ctx.functions.has(name)) ||
      (HTTP_CLIENT_ROOTS.test(root) && !r.request.has(root) && /^(get|post|put|patch|delete|head|request|options|stream)$/.test(name) && segments.length === 2) ||
      (/^(axios|got|node-fetch|undici|needle|superagent|ky|ofetch|cross-fetch|isomorphic-fetch|http|https|node:http|node:https)$/.test(module) && (segments.length === 1 || /^(get|post|put|patch|delete|head|request|fetch|stream)$/.test(name)));
    if (httpCall && first && !this.ctx.client) {
      const lead = this.lead(argTokens(0), scope, roles);
      const fixed = lead.literal !== null && (ABSOLUTE_PREFIX.test(lead.literal) || LOCAL_PATH_PREFIX.test(lead.literal));
      if (!fixed && lead.value) { this.sink('ssrf', lead.value, line); return true; }
      return false;
    }
    /* Files. */
    const fsCall = (FS_MODULE.test(module) || /^(fs|fsp|fse|fsPromises)$/.test(root) || (root === 'fs' && segments[1] === 'promises')) &&
      /^(readFile|readFileSync|createReadStream|writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|readdir|readdirSync|rename|renameSync|copyFile|copyFileSync|open|openSync|cp|cpSync)$/.test(name);
    const sendFile = r.response.has(root) && /^(sendFile|download|attachment)$/.test(name);
    const rooted = sendFile && call.args.some(arg => arg.some((t, i) => t.v === 'root' && isPunc(arg[i + 1], ':')));
    if ((fsCall || (sendFile && !rooted)) && first) { this.sink('path', first, line); return true; }
    /* Redirects. */
    const redirect = (r.response.has(root) && name === 'redirect') || (root === 'ctx' && name === 'redirect') || (r.honoCtx.has(root) && name === 'redirect') ||
      (root === 'NextResponse' && name === 'redirect') || (root === 'Response' && name === 'redirect') ||
      (segments.length === 1 && name === 'redirect' && /^(next\/navigation|@remix-run\/node|@remix-run\/react|@remix-run\/server-runtime|react-router|react-router-dom|@sveltejs\/kit|next\/server)$/.test(module));
    if (redirect) {
      const position = /^\d/.test(String(argTokens(0)[0]?.v || '')) ? 1 : 0;
      const lead = this.lead(argTokens(position), scope, roles);
      if (lead.value && (lead.literal === null || !LOCAL_PATH_PREFIX.test(lead.literal))) { this.sink('redirect', lead.value, line); return true; }
      return false;
    }
    /* An HTML response built from what the caller sent -- or the raw text itself, which Express sends as text/html. */
    if (r.response.has(root) && /^(send|write|end)$/.test(name) && first && first.html) { this.sink('html', first, line); return true; }
    if (r.response.has(root) && name === 'send' && first && !first.object && !first.whole && /^(query string|route parameter|request header)$/.test(first.kind) && !first.built) {
      this.sink('html', { ...first, weak: true }, line); return true;
    }
    if (root === 'c' && name === 'html' && first && first.built) { this.sink('html', first, line); return true; }
    /* The DOM. */
    if ((name === 'write' || name === 'writeln') && root === 'document' && first) { this.sink('dom', first, line); return true; }
    if (name === 'insertAdjacentHTML' && args[1]) { this.sink('dom', args[1], line); return true; }
    if (/^(html|append|prepend|after|before|replaceWith)$/.test(name) && /^(\$|jQuery)$/.test(root) === false && segments.length > 1 && /^\$/.test(root) && first) { this.sink('dom', first, line); return true; }
    /* Regular expressions from input. */
    if (segments.length === 1 && name === 'RegExp' && first) { this.sink('regex', first, line); return true; }
    /* Document databases: a request's own object as the query. */
    if (MONGO_METHODS.has(name) && segments.length > 1 && first && first.param === null && (first.whole || (first.object && first.kind !== 'parameter'))) {
      const mongo = /^[A-Z]/.test(root) || /collection|model|coll|users|posts|db/i.test(objectName) || /mongoose|mongodb/.test(module);
      if (mongo && (first.whole || argTokens(0).some(t => t.t === 'id' && (t.v === 'body' || t.v === 'query')))) { this.sink('nosql', first, line); return true; }
    }
    /* A record written as it arrived. */
    if (MASS_METHODS.has(name) && segments.length > 1) {
      const carried = args.map(value => value && (value.whole ? value : value.wholeInside)).find(Boolean);
      const hashing = segments.some(segment => /^(createHash|createHmac|createCipheriv|createDecipheriv|createSign|createVerify|hash|hmac|digest|sha\w*|md5|crc32|hasher|checksum)$/i.test(segment));
      if (carried && !hashing && !/^(Map|Set|cache|redis|localStorage|sessionStorage|headers|form|params|url|searchParams|res|response|hash|hmac|cipher|sign|verify|progress|bar|spinner|state|store|ref)$/i.test(objectName)) { this.sink('mass', carried, line); return true; }
    }
    const spread = name === 'assign' && root === 'Object' ? args.slice(1).find(value => value && value.whole) : undefined;
    if (spread) {
      this.sink('mass', spread, line); return true;
    }
    /* Deep merges and path setters with keys a caller chose. */
    if (MERGE_CALLS.test(name) && (root === '_' || root === 'lodash' || /lodash|deepmerge|merge|dot-prop|object-path|extend|defaults/.test(module) || (segments.length === 1 && /^(merge|deepMerge|deepmerge|mergeDeep|defaultsDeep)$/.test(name)))) {
      if (name === 'set' || name === 'setWith' || name === 'unset') {
        if (args[1] && args[1].param === null) { this.sink('merge', args[1], line); return true; }
        return false;
      }
      const value = args.slice(1).find(Boolean);
      if (value) { this.sink('merge', value, line); return true; }
    }
    /* Deserialisers that run what they read. */
    if (/^(unserialize|deserialize)$/.test(name) && (/node-serialize|serialize-javascript|funcster|cryo/.test(module) || /^serialize$/i.test(root)) && first) { this.sink('deserialize', first, line); return true; }
    if (name === 'load' && (root === 'yaml' || /js-yaml/.test(module)) && first && call.args.some(arg => arg.some(t => /DEFAULT_FULL_SCHEMA|FULL_SCHEMA/.test(String(t.v))))) { this.sink('deserialize', first, line); return true; }
    /* libxmljs with entity substitution switched on: parseXml(text, { noent: true }) */
    if (/^(parseXml|parseXmlString|parseXmlAsync)$/.test(name) && (/libxmljs/.test(module) || /^libxml/i.test(root)) && first &&
      call.args.slice(1).some(arg => arg.some((t, index) => t.v === 'noent' && arg[index + 2]?.v === 'true'))) { this.sink('xxe', first, line); return true; }
    void receiver;
    return false;
  }

  summaryFor(segments: readonly string[], resolved: Resolved): Summary | null {
    const program = this.program;
    const only = segments.length === 1 ? segments[0] : undefined;
    if (only !== undefined && !resolved.module) {
      const local = this.ctx.functions.get(only);
      if (local) return program.summary(this.ctx.path, only, true);
    }
    const module = resolved.module;
    if (module && (module.startsWith('.') || /^[@~]\//.test(module))) {
      const target = program.resolve(this.ctx.path, module);
      if (!target) return null;
      const exported = resolved.path[0] ?? 'default';
      return program.summary(target, exported);
    }
    return null;
  }

  throughHelper(value: FlowValue, sink: SummarySink, line: number, argTokens: Tokens | null, scope: Scope, roles: Roles | null): void {
    /* A URL or a redirect target led by a fixed origin or a local path where it is built is not the caller's to choose. */
    if ((sink.kind === 'ssrf' || sink.kind === 'redirect') && argTokens && argTokens.length) {
      const lead = this.lead(argTokens, scope, roles);
      if (lead.literal !== null && (ABSOLUTE_PREFIX.test(lead.literal) || LOCAL_PATH_PREFIX.test(lead.literal))) return;
      if (lead.literal === null && !lead.value) return;
    }
    if (value.param !== null && this.summaryOf) {
      /* A parameter handed on to a helper that misuses it: this function misuses it too. */
      this.summaryOf.sinks.push({ ...sink, param: value.param, steps: [...value.steps.slice(1), { path: this.ctx.path, line, role: 'propagation', note: 'passed to a function' }, ...sink.steps] });
      return;
    }
    if (this.mode !== 'flow') return;
    /* A SQL helper that splices its argument into its own statement counts; one that passes it as a parameter does not. */
    const steps: Step[] = [...value.steps, { path: this.ctx.path, line, role: 'propagation', note: 'passed to a function' }, ...sink.steps];
    this.report(sink.kind, { ...value, steps, guarded: value.guarded || sink.guarded || null }, sink.path, sink.line, sink.path !== this.ctx.path ? 'file' : 'function');
  }

  sink(kind: FlowSinkKind, value: Value | undefined, line: number): void {
    if (!value) return;
    if (value.param !== null) {
      if (this.summaryOf) this.summaryOf.sinks.push({ kind, param: value.param, path: this.ctx.path, line, steps: value.steps.slice(1), guarded: value.guarded });
      return;
    }
    if (this.mode !== 'flow') return;
    this.report(kind, value, this.ctx.path, line, null);
  }

  report(kind: FlowSinkKind, value: FlowValue, path: string, line: number, viaHelper: 'function' | 'file' | null): void {
    if (this.ctx.flows.length >= MAX_FLOWS_PER_FILE) return;
    const spec = SINKS[kind];
    const model = value.kind === 'model reply';
    let rule = spec.rule;
    let severity = spec.severity;
    if (model) {
      const modelSeverity = MODEL_SINK_SEVERITY[kind];
      if (!modelSeverity) return;
      rule = 'AI-001';
      severity = modelSeverity;
    }
    if (kind === 'prompt' && model) return;
    const steps = value.steps.slice(0, MAX_STEPS);
    steps.push({ path, line, role: 'sink', note: `used in ${spec.label}` });
    const judgement = JUDGEMENT_SINKS.has(kind);
    const verdict = value.weak || value.guarded || judgement ? 'needs-validation' : 'confirmed';
    let blocker: FlowBlocker | null = null;
    if (value.guarded) blocker = { reason: 'guarded', path: value.guarded.path, line: value.guarded.line };
    else if (value.weak) blocker = { reason: 'weak-source' };
    else if (judgement) blocker = { reason: kind };
    this.ctx.flows.push({ rule, kind, severity, path, line, source: value.kind, verdict, blocker, trace: steps, viaHelper });
  }
}

/* ---- Route registrations and handler shapes, found before the walk ---------------- */

const ROUTER_OBJECT = /^(app|router|api|server|r|route|routes|fastify|instance|v1|v2|admin\w*|\w*[Rr]outer|\w*[Aa]pp|hono|elysia|srv)$/;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'all', 'options', 'head']);
const ROUTE_TEXT = /^[A-Za-z0-9/_:.\-*[\]{}()$+?@~]*$/;

export function safeRoute(value: unknown): string | null {
  const text = String(value || '').trim();
  if (!text.startsWith('/') || text.length > 120 || !ROUTE_TEXT.test(text)) return null;
  return text;
}

/*
 * Express-style registrations -- app.post('/x', mw, handler), router.route('/x').get(h),
 * fastify.get('/x', opts, h), app.get('/x', c => ...) in Hono -- and the
 * handler functions they name, found once so the walker knows which
 * parameter is the request when it reaches each handler.
 */
function jsRoutes(tokens: Tokens, ctx: FileContext): void {
  const hints = new Map<number, Hint>();
  const named = new Map<string, Hint>();
  /* The router's own name for the endpoint list; they all register the same way. */
  const framework = /['"]hono(\/[\w-]+)?['"]/.test(ctx.text) ? 'hono'
    : /['"](koa|koa-router|@koa\/router)['"]/.test(ctx.text) ? 'koa'
      : /['"]fastify['"]/.test(ctx.text) ? 'fastify' : 'express';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (token.t !== 'id' || !isPunc(tokens[index + 1], '.')) continue;
    if (isPunc(tokens[index - 1], '.')) continue;
    const object = token.v;
    let cursor = index + 2;
    let path: string | null = null;
    /* router.route('/x').get(...) */
    const mounted = tokens[cursor + 2];
    if (tokens[cursor]?.v === 'route' && isPunc(tokens[cursor + 1], '(') && isStr(mounted)) {
      path = mounted.v;
      cursor = matching(tokens, cursor + 1) + 1;
      if (!isPunc(tokens[cursor], '.')) continue;
      cursor += 1;
    }
    const method = tokens[cursor];
    if (!method || !HTTP_METHODS.has(String(method.v)) || !isPunc(tokens[cursor + 1], '(')) continue;
    if (!ROUTER_OBJECT.test(object) && !path) continue;
    const { args, close } = splitArgs(tokens, cursor + 1);
    if (!args.length) continue;
    let handlerArgs = args;
    if (!path) {
      const opening = args[0]?.[0];
      if (!opening || !(isStr(opening) || (opening.t === 'tpl' && opening.exprs.length === 0))) continue;
      path = opening.t === 'tpl' ? opening.parts.join('') : opening.v;
      handlerArgs = args.slice(1);
    }
    const route = safeRoute(path);
    if (!route) continue;
    const entry: FlowRoute = {
      method: method.v === 'del' ? 'DELETE' : method.v === 'all' ? 'ANY' : method.v.toUpperCase(),
      route, path: ctx.path, line: token.line, framework, middleware: [], bodyStart: null, bodyEnd: null
    };
    const hint: Hint = { kind: 'route', route: entry };
    handlerArgs.forEach((arg, position) => {
      const opening = arg[0];
      const closing = arg[arg.length - 1];
      if (!opening || !closing) return;
      const place = tokens.indexOf(opening, cursor + 1);
      const fn = place >= 0 ? functionAt(tokens, place, close) : null;
      if (fn) {
        if (position === handlerArgs.length - 1) hints.set(fn.start, hint);
        else hints.set(fn.start, { kind: 'route', route: null });
        return;
      }
      /* A named handler or middleware: auth, requireUser, controller.create. */
      const words = arg.filter(t => t.t === 'id').map(t => t.v);
      if (position < handlerArgs.length - 1) entry.middleware.push(...words);
      else if (words.length) {
        named.set(lastOf(words), hint);
        entry.handlerName = lastOf(words);
        if (words.length > 1) entry.middleware.push(...words.slice(0, -1));
      }
      /* A wrapped handler: withAuth(async (req, res) => ...) */
      for (let inner = place; inner >= 0 && inner < tokens.indexOf(closing, place); inner += 1) {
        const nested = functionAt(tokens, inner, close);
        if (nested) { hints.set(nested.start, hint); entry.middleware.push(...words.slice(0, 1)); break; }
      }
    });
    ctx.routes.push(entry);
  }
  /* Global middleware: app.use(requireAuth), app.use('/api', auth, router). */
  const uses: RouteUse[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (token.t === 'id' && ROUTER_OBJECT.test(token.v) && isPunc(tokens[index + 1], '.') && isWord(tokens[index + 2], 'use') && isPunc(tokens[index + 3], '(')) {
      const { args } = splitArgs(tokens, index + 3);
      const mount = args[0]?.[0];
      const prefix = isStr(mount) ? safeRoute(mount.v) : null;
      const words = args.flat().filter(t => t.t === 'id').map(t => t.v);
      uses.push({ line: token.line, prefix, words });
    }
  }
  ctx.uses = uses;
  /* Message listeners: addEventListener('message', e => ...), window.onmessage = e => ... */
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    const event = tokens[index + 2];
    if (token.v === 'addEventListener' && isPunc(tokens[index + 1], '(') && isStr(event) && event.v === 'message' && isPunc(tokens[index + 3], ',')) {
      const fn = functionAt(tokens, index + 4, tokens.length);
      if (fn) hints.set(fn.start, { kind: 'message' });
    }
    if (token.v === 'onmessage' && isPunc(tokens[index + 1], '=')) {
      const fn = functionAt(tokens, index + 2, tokens.length);
      if (fn) hints.set(fn.start, { kind: 'message' });
    }
  }
  ctx.handlerHints = hints;
  ctx.namedHandlers = named;
}

/*
 * File-based routers: a Next.js route handler's exported GET/POST, a pages
 * API route's default export, a server action file, SvelteKit's +server,
 * Remix and React Router's action and loader, a Supabase edge function.
 */
const NEXT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

type FileRouteKind = 'next-app' | 'next-pages' | 'kit' | 'kit-actions' | 'remix' | 'edge' | 'lambda';

export function routeFromPath(path: string, kind: FileRouteKind | null): string {
  let route = path.replace(/^src\//, '');
  if (kind === 'next-app') route = route.replace(/^(app)\//, '/').replace(/\/route\.[a-z]+$/, '').replace(/\/\([^/)]+\)/g, '');
  if (kind === 'next-pages') route = route.replace(/^pages\//, '/').replace(/\.[a-z]+$/, '').replace(/\/index$/, '');
  if (kind === 'kit') route = route.replace(/^routes\//, '/').replace(/\/\+server\.[a-z]+$|\/\+page\.server\.[a-z]+$/, '').replace(/\/\([^/)]+\)/g, '');
  if (kind === 'remix') route = route.replace(/^app\/routes\//, '/').replace(/\.[a-z]+$/, '').replace(/\./g, '/').replace(/\$(\w+)/g, ':$1').replace(/\/_index$|\/index$/, '').replace(/\/route$/, '');
  if (kind === 'edge') route = route.replace(/^supabase\/functions\//, '/functions/v1/').replace(/\/index\.[a-z]+$/, '');
  route = route || '/';
  return safeRoute(route.startsWith('/') ? route : `/${route}`) || '/';
}

export function fileRouteKind(path: string): FileRouteKind | null {
  const plain = path.replace(/^src\//, '');
  if (/^app\/.*route\.(js|ts|mjs)$/.test(plain) || /^app\/route\.(js|ts)$/.test(plain)) return 'next-app';
  if (/^pages\/api\/.+\.(js|ts|mjs)$/.test(plain)) return 'next-pages';
  if (/^routes\/.*\+server\.(js|ts)$/.test(plain)) return 'kit';
  if (/^routes\/.*\+page\.server\.(js|ts)$/.test(plain)) return 'kit-actions';
  if (/^app\/routes\/.+\.(jsx?|tsx?)$/.test(path)) return 'remix';
  if (/^supabase\/functions\/[^/]+\/index\.(ts|js)$/.test(path)) return 'edge';
  if (/(^|\/)(netlify\/functions|api|functions|lambda|handlers?)\/[^/]+\.(js|ts|mjs)$/.test(path)) return 'lambda';
  return null;
}

function fileRoutes(tokens: Tokens, ctx: FileContext): void {
  const kind = fileRouteKind(ctx.path);
  const hints = ctx.handlerHints;
  const useServerFile = opensWith(ctx.text, 'use server');
  ctx.serverActions = useServerFile;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (!isWord(token, 'export')) continue;
    let cursor = index + 1;
    const isDefault = isWord(tokens[cursor], 'default');
    if (isDefault) cursor += 1;
    let fnAt = cursor;
    let name: string | null = null;
    const declared = tokens[cursor + 1];
    if (isWord(tokens[cursor], 'async') && isWord(tokens[cursor + 1], 'function')) { name = tokens[cursor + 2]?.t === 'id' ? at(tokens, cursor + 2).v : null; }
    else if (isWord(tokens[cursor], 'function')) { name = declared?.t === 'id' ? declared.v : null; }
    else if ((isWord(tokens[cursor], 'const') || isWord(tokens[cursor], 'let')) && declared && isPunc(tokens[cursor + 2], '=')) {
      name = declared.v;
      fnAt = cursor + 3;
      /* export const POST = withAuth(async (req) => ...): the inner function. */
      if (!functionAt(tokens, fnAt, tokens.length)) {
        for (let inner = fnAt; inner < Math.min(tokens.length, fnAt + 12); inner += 1) {
          if (functionAt(tokens, inner, tokens.length)) { fnAt = inner; break; }
        }
      }
    }
    const fn = functionAt(tokens, fnAt, tokens.length);
    if (!fn) continue;
    const line = token.line;
    const add = (method: string, framework: string, hintKind: HintKind): void => {
      const entry: FlowRoute = { method, route: routeFromPath(ctx.path, kind === 'kit-actions' ? 'kit' : kind), path: ctx.path, line, framework, middleware: [], bodyStart: null, bodyEnd: null };
      ctx.routes.push(entry);
      hints.set(fn.start, { kind: hintKind, route: entry });
    };
    if (kind === 'next-app' && name && NEXT_METHODS.has(name)) add(name, 'next', 'next-route');
    else if (kind === 'next-pages' && isDefault) add('ANY', 'next-pages', 'route');
    else if (kind === 'kit' && name && NEXT_METHODS.has(name)) add(name, 'sveltekit', 'kit');
    else if (kind === 'remix' && (name === 'action' || name === 'loader')) add(name === 'action' ? 'POST' : 'GET', 'remix', 'kit');
    else if (kind === 'lambda' && (name === 'handler' || isDefault)) add('ANY', 'serverless', 'lambda');
    else if (useServerFile && name) {
      const entry: FlowRoute = { method: 'ACTION', route: null, action: true, path: ctx.path, line, framework: 'server-action', middleware: [], bodyStart: null, bodyEnd: null };
      ctx.routes.push(entry);
      hints.set(fn.start, { kind: 'action', route: entry });
    }
  }
  /* SvelteKit form actions: export const actions = { default: async ({ request }) => ... } */
  if (kind === 'kit-actions') {
    for (let index = 0; index < tokens.length; index += 1) {
      if (at(tokens, index).v === 'actions' && isPunc(tokens[index + 1], '=') && isPunc(tokens[index + 2], '{')) {
        const close = matching(tokens, index + 2);
        for (let inner = index + 3; inner < close; inner += 1) {
          const fn = functionAt(tokens, inner, close);
          if (fn) {
            const entry: FlowRoute = { method: 'POST', route: routeFromPath(ctx.path, 'kit'), path: ctx.path, line: at(tokens, inner).line, framework: 'sveltekit', middleware: [], bodyStart: null, bodyEnd: null };
            ctx.routes.push(entry);
            hints.set(fn.start, { kind: 'kit', route: entry });
            inner = fn.next;
          }
        }
      }
    }
  }
  /* Supabase edge function and Deno: serve(async (req) => ...), Deno.serve(...) */
  if (kind === 'edge') {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = at(tokens, index);
      if ((token.v === 'serve' || (token.v === 'Deno' && tokens[index + 2]?.v === 'serve')) && tokens.slice(index, index + 4).some(t => isPunc(t, '('))) {
        const open = tokens.findIndex((t, i) => i > index && isPunc(t, '('));
        for (let inner = open + 1; inner < Math.min(tokens.length, open + 8); inner += 1) {
          const fn = functionAt(tokens, inner, tokens.length);
          if (fn) {
            const entry: FlowRoute = { method: 'ANY', route: routeFromPath(ctx.path, 'edge'), path: ctx.path, line: token.line, framework: 'supabase-edge', middleware: [], bodyStart: null, bodyEnd: null };
            ctx.routes.push(entry);
            hints.set(fn.start, { kind: 'route', route: entry });
            break;
          }
        }
        break;
      }
    }
  }
  /* Inline server actions: a function whose body opens with 'use server'. */
  for (let index = 0; index < tokens.length; index += 1) {
    const fn = functionAt(tokens, index, tokens.length);
    const directive = fn ? tokens[fn.bodyStart] : undefined;
    if (fn && fn.block && isStr(directive) && directive.v === 'use server' && !hints.has(fn.start)) {
      const entry: FlowRoute = { method: 'ACTION', route: null, action: true, path: ctx.path, line: at(tokens, index).line, framework: 'server-action', middleware: [], bodyStart: null, bodyEnd: null };
      ctx.routes.push(entry);
      hints.set(fn.start, { kind: 'action', route: entry });
    }
  }
}

/* ---- Functions a file defines, for summaries ------------------------------------------ */

function jsFunctions(tokens: Tokens, ctx: FileContext): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (isWord(token, 'function') || (isWord(token, 'async') && isWord(tokens[index + 1], 'function'))) {
      const fn = functionAt(tokens, index, tokens.length);
      if (fn && fn.name) ctx.functions.set(fn.name, { fn, summary: null });
      continue;
    }
    const declared = tokens[index + 1];
    if ((isWord(token, 'const') || isWord(token, 'let') || isWord(token, 'var')) && declared && declared.t === 'id' && isPunc(tokens[index + 2], '=')) {
      const fn = functionAt(tokens, index + 3, tokens.length);
      if (fn) {
        fn.name = declared.v;
        ctx.functions.set(fn.name, { fn, summary: null });
      }
    }
  }
}

/* ---- Python ------------------------------------------------------------------------ */

const PY_ROUTE_DECORATOR = /^@(\w+)\.(route|get|post|put|patch|delete|api_route|websocket)$/;
const PY_AUTH_DECORATOR = /^@(login_required|jwt_required|auth\.login_required|requires_auth|token_required|permission_required|admin_required|roles_required|roles_accepted|fresh_jwt_required|authenticated|requires_login|user_passes_test|staff_member_required|api_view|permission_classes|authentication_classes)/;

/* A Python decorator or statement line read back as the text it was written as. */
function lineText(line: LogicalLine): string {
  return line.tokens.map(t => t.v).join('');
}

class PyWalker extends JsWalker {
  readonly lines: LogicalLine[];
  constructor(lines: LogicalLine[], ctx: FileContext, mode: Mode, program: Program) {
    super([], ctx, mode, program);
    this.lines = lines;
    this.inRoute = false;
  }

  override child(tokens: Tokens): PyWalker {
    const walker = new PyWalker([], this.ctx, this.mode, this.program);
    walker.tokens = tokens;
    walker.summaryOf = this.summaryOf;
    walker.sub = true;
    walker.pyRoles = this.pyRoles;
    walker.inRoute = this.inRoute;
    return walker;
  }

  /* Python's request object is a module-level name in Flask and Django's first view parameter. */
  pySource(segments: readonly string[]): Found | null {
    const root = segments[0] ?? '';
    const roles = this.pyRoles;
    if (root === 'request' || (roles && roles.request.has(root))) {
      const field = segments[1];
      const kind = entryOf(PY_REQUEST_FIELDS, field);
      if (field && kind) return { kind, whole: segments.length === 2 && ['json', 'form', 'data', 'values', 'POST'].includes(field) };
    }
    return null;
  }

  override source(segments: readonly string[]): Found | null {
    return this.pySource(segments);
  }

  run(): void {
    this.block(0, this.lines.length, new Scope(null), null, -1);
  }

  /* Statements from line `start` while their indentation is deeper than `indent`. */
  block(start: number, end: number, scope: Scope, roles: Roles | null, indent: number): number {
    let index = start;
    let decorators: LogicalLine[] = [];
    while (index < end) {
      const line = this.lines[index];
      if (!line || line.indent <= indent) return index;
      const tokens = line.tokens;
      const first = tokens[0];
      if (isPunc(first, '@')) {
        decorators.push(line);
        index += 1;
        continue;
      }
      const defAt = isWord(first, 'def') ? 0 : isWord(first, 'async') && isWord(tokens[1], 'def') ? 1 : -1;
      if (defAt >= 0) {
        const bodyEnd = this.blockEnd(index + 1, end, line.indent);
        this.pyFunction(line, defAt, index + 1, bodyEnd, scope, roles, decorators);
        decorators = [];
        index = bodyEnd;
        continue;
      }
      decorators = [];
      if (isWord(first, 'class')) {
        const bodyEnd = this.blockEnd(index + 1, end, line.indent);
        this.block(index + 1, bodyEnd, new Scope(scope), roles, line.indent);
        index = bodyEnd;
        continue;
      }
      this.pyStatement(line, scope, roles);
      index += 1;
    }
    return index;
  }

  blockEnd(start: number, end: number, indent: number): number {
    let index = start;
    while (index < end && (this.lines[index]?.indent ?? indent) > indent) index += 1;
    return index;
  }

  pyFunction(line: LogicalLine, defAt: number, start: number, end: number, scope: Scope, roles: Roles | null, decorators: readonly LogicalLine[]): void {
    const tokens = line.tokens;
    const name = tokens[defAt + 1]?.v ?? null;
    const open = defAt + 2;
    if (!isPunc(tokens[open], '(')) { this.block(start, end, new Scope(scope), roles, line.indent); return; }
    const { args } = splitArgs(tokens, open);
    const params = args.map(arg => {
      const nameToken = arg.find(t => t.t === 'id');
      const star = isPunc(arg[0], '*') || isPunc(arg[0], '**');
      const annotated = arg.map(t => t.v).join(' ');
      return { name: nameToken ? nameToken.v : null, star, depends: /\bDepends\s*\(/.test(annotated), typed: annotated };
    });
    const child = new Scope(scope);
    /* the first route decorator, as written */
    const decoratorLine = decorators.find(d => PY_ROUTE_DECORATOR.test(lineText(d).split('(')[0] ?? ''));
    const routeDecorator = decoratorLine ? lineText(decoratorLine) : undefined;
    const authDecorated = decorators.some(d => PY_AUTH_DECORATOR.test(lineText(d)));
    const inner: PyRoles = { request: new Set(), lambda: null };
    const lastLine = this.lines[end - 1]?.line ?? line.line;
    let route: FlowRoute | null = null;
    if (decoratorLine && routeDecorator && this.mode === 'flow') {
      const pathToken = decoratorLine.tokens.find(t => t.t === 'str');
      const verb = /^@\w+\.(\w+)/.exec(routeDecorator)?.[1];
      let method = verb !== undefined && verb !== 'route' && verb !== 'api_route' ? verb.toUpperCase() : 'GET';
      const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(routeDecorator.replace(/'/g, '"'))?.[1];
      if (methods !== undefined) method = methods.replace(/["\s]/g, '').split(',').filter(Boolean).map(m => m.toUpperCase()).join(',') || method;
      route = { method, route: pathToken ? safeRoute(pathToken.v) || '/' : '/', path: this.ctx.path, line: line.line, framework: /FastAPI|fastapi|APIRouter/.test(this.ctx.text) ? 'fastapi' : 'flask', middleware: decorators.map(lineText), bodyStartLine: line.line, bodyEndLine: lastLine, authDecorated };
      this.ctx.routes.push(route);
    }
    const djangoView = /(^|\/)views?(\/|\.py$)/.test(this.ctx.path) && params[0]?.name === 'request';
    if (djangoView && !route && this.mode === 'flow') {
      route = { method: 'ANY', route: null, view: true, path: this.ctx.path, line: line.line, framework: 'django', middleware: decorators.map(lineText), bodyStartLine: line.line, bodyEndLine: lastLine, authDecorated };
      this.ctx.routes.push(route);
    }
    const lambda = (name === 'lambda_handler' || name === 'handler') && params[0]?.name === 'event';
    params.forEach((param, position) => {
      if (!param.name || param.name === 'self' || param.name === 'cls') return;
      let value: Value = null;
      if (this.mode === 'summary' && this.summaryOf && this.summaryOf.name === name && this.summaryOf.line === line.line) value = taint('parameter', this.ctx.path, line.line, { param: position, note: 'a parameter' });
      else if (routeDecorator && /FastAPI|fastapi|APIRouter/.test(this.ctx.text) && !param.depends && !/\b(Request|Session|BackgroundTasks|Response|WebSocket|AsyncSession|Depends)\b/.test(param.typed) && !param.star) {
        value = taint(/\bBody\b|:\s*[A-Z]\w*(Create|Update|In|Schema|Model|Payload|Request)\b/.test(param.typed) ? 'request body' : 'route parameter', this.ctx.path, line.line, { note: 'a request value enters here' });
      }
      if (param.name === 'request' && (djangoView || routeDecorator)) inner.request.add('request');
      child.declare(param.name, value);
    });
    if (lambda) inner.lambda = 'event';
    const previousRoles = this.pyRoles;
    const previousRoute = this.inRoute;
    this.pyRoles = { request: new Set([...(previousRoles ? previousRoles.request : []), ...inner.request]), lambda: inner.lambda || (previousRoles ? previousRoles.lambda : null) };
    this.inRoute = Boolean(routeDecorator || djangoView) || previousRoute;
    const outerEnd = this.bodyEndLine;
    this.bodyEndLine = this.lines[end - 1]?.line ?? outerEnd;
    this.block(start, end, child, roles, line.indent);
    this.bodyEndLine = outerEnd;
    this.pyRoles = previousRoles;
    this.inRoute = previousRoute;
  }

  pyStatement(line: LogicalLine, scope: Scope, roles: Roles | null): void {
    const tokens = line.tokens;
    const first = tokens[0];
    this.tokens = tokens;
    if (isWord(first, 'return')) {
      const value = this.expression(1, tokens.length, scope, roles);
      if (value && this.summaryOf && value.param !== null) this.summaryOf.returns.add(value.param);
      if (value && value.html && !value.weak && this.inRoute) this.sink('html', value, line.line);
      return;
    }
    if (isWord(first, 'if') || isWord(first, 'elif') || isWord(first, 'while')) {
      /* The condition ends at the top-level colon; a body on the same line is a statement of its own. */
      let depth = 0;
      let colon = tokens.length;
      for (let index = 1; index < tokens.length; index += 1) {
        const token = at(tokens, index);
        if (token.t === 'punc' && '([{'.includes(token.v)) depth += 1;
        if (token.t === 'punc' && ')]}'.includes(token.v)) depth -= 1;
        if (depth === 0 && isPunc(token, ':')) { colon = index; break; }
      }
      this.guard(1, colon, scope);
      this.expression(1, colon, scope, roles);
      if (colon < tokens.length - 1) this.pyStatement({ tokens: tokens.slice(colon + 1).map((token, position) => ({ ...token, i: position })), line: line.line, indent: line.indent }, scope, roles);
      return;
    }
    if (isWord(first, 'for')) {
      const inAt = tokens.findIndex(t => isWord(t, 'in'));
      if (inAt > 0) {
        const value = this.expression(inAt + 1, tokens.length - 1, scope, roles);
        for (const token of tokens.slice(1, inAt)) if (token.t === 'id') scope.declare(token.v, value && extend(value, this.ctx.path, line.line, 'taken from a list in a loop'));
      }
      return;
    }
    if (isWord(first, 'with')) {
      const asAt = tokens.findIndex(t => isWord(t, 'as'));
      const stop = asAt > 0 ? asAt : tokens.length - 1;
      const value = this.expression(1, stop, scope, roles);
      const bound = tokens[asAt + 1];
      if (asAt > 0 && bound && bound.t === 'id') scope.declare(bound.v, value);
      return;
    }
    if (first && first.t === 'kw' && ['import', 'from', 'pass', 'break', 'continue', 'global', 'nonlocal', 'raise', 'try', 'except', 'finally', 'else', 'assert', 'del'].includes(first.v)) {
      if (first.v === 'raise' || first.v === 'assert') this.expression(1, tokens.length, scope, roles);
      return;
    }
    /* Assignment: targets = value, at the top level. */
    let depth = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = at(tokens, index);
      if (token.t === 'punc' && '([{'.includes(token.v)) depth += 1;
      if (token.t === 'punc' && ')]}'.includes(token.v)) depth -= 1;
      if (depth === 0 && token.t === 'punc' && ['=', '+=', ':='].includes(token.v)) {
        const value = this.expression(index + 1, tokens.length, scope, roles);
        const targets = tokens.slice(0, index);
        /* a: int = x -- annotation; a, b = x -- tuple */
        const colon = targets.findIndex(t => isPunc(t, ':'));
        const names = (colon >= 0 ? targets.slice(0, colon) : targets).filter((t, i, all) => t.t === 'id' && !isPunc(all[i - 1], '.') && !isPunc(all[i + 1], '.') && !isPunc(all[i + 1], '['));
        /* obj[key] = value with a caller-chosen key: prototype pollution has no Python twin; nothing to do. */
        for (const target of names) {
          const previous = scope.lookup(target.v);
          let next: Value | undefined = value && extend(value, this.ctx.path, line.line, value.built ? 'built into a string' : 'assigned to a variable');
          if (token.v === '+=') next = merge(previous, next) || previous;
          scope.assign(target.v, next);
        }
        return;
      }
    }
    this.expression(0, tokens.length, scope, roles);
  }

  override evaluate(start: number, stop: number, scope: Scope, roles: Roles | null): Value {
    const tokens = this.tokens;
    let result: Value = null;
    let concat = false;
    let sawString = false;
    let percent = false;
    let index = start;
    while (index < stop) {
      const token = tokens[index];
      if (!token) break;
      if (isWord(token, 'lambda')) {
        const colon = tokens.findIndex((t, i) => i > index && isPunc(t, ':'));
        index = colon > 0 ? colon + 1 : index + 1;
        continue;
      }
      if (token.t === 'tpl') {
        let value: Value = null;
        for (const expr of token.exprs) value = merge(value, this.child(expr).expression(0, expr.length, scope, roles));
        if (value) {
          const text = token.parts.join(' ');
          value = { ...value, built: true, sql: value.sql || SQL_WORDS.test(text), html: value.html || HTML_TEXT.test(text), whole: false };
        }
        result = merge(result, value);
        sawString = true;
        index += 1;
        continue;
      }
      if (token.t === 'str') {
        sawString = true;
        /* "...".format(x) and "..." % x */
        if (isPunc(tokens[index + 1], '.') && tokens[index + 2]?.v === 'format' && isPunc(tokens[index + 3], '(')) {
          const { args, close } = splitArgs(tokens, index + 3);
          let value: Value = null;
          for (const arg of args) value = merge(value, this.subExpression(arg, scope, roles));
          if (value) value = { ...value, built: true, sql: SQL_WORDS.test(token.v) || value.sql, html: HTML_TEXT.test(token.v) || value.html, whole: false };
          result = merge(result, value);
          index = close + 1;
          continue;
        }
        index += 1;
        continue;
      }
      if (isPunc(token, '+')) { concat = true; index += 1; continue; }
      if (isPunc(token, '%') && isStr(tokens[index - 1])) { percent = true; index += 1; continue; }
      if (token.t === 'id') {
        const chain = readChain(tokens, index, stop);
        if (chain) {
          result = merge(result, this.chain(chain, scope, roles));
          index = Math.max(chain.end, index + 1);
          continue;
        }
      }
      if (isPunc(token, '(') || isPunc(token, '[') || isPunc(token, '{')) {
        const close = matching(tokens, index);
        const value = this.expression(index + 1, close, scope, roles);
        result = merge(result, value && isPunc(token, '{') ? { ...value, whole: false, object: true } : value);
        index = close + 1;
        continue;
      }
      index += 1;
    }
    if (result && sawString && (concat || percent)) {
      const text = literalText(tokens.slice(start, stop));
      result = { ...result, built: true, sql: result.sql || SQL_WORDS.test(text), html: result.html || HTML_TEXT.test(text), whole: false };
    }
    return result;
  }

  /* A keyword argument's value, or a positional one, evaluated on its own. */
  subExpression(arg: Tokens, scope: Scope, roles: Roles | null): Value {
    const tokens = arg[0]?.t === 'id' && isPunc(arg[1], '=') ? arg.slice(2) : arg;
    return this.child(tokens).expression(0, tokens.length, scope, roles);
  }

  override argValue(arg: Tokens | undefined, scope: Scope, roles: Roles | null): Value {
    if (!arg || !arg.length) return null;
    if (isPunc(arg[0], '**')) {
      const value = this.subExpression(arg.slice(1), scope, roles);
      return value && { ...value, spreadKw: true };
    }
    return this.subExpression(arg, scope, roles);
  }

  override call(segments: readonly string[], call: CallStep | TaggedStep, receiver: Value, scope: Scope, roles: Roles | null): CallResult {
    if (call.tagged) return { value: null };
    const name = lastOf(segments);
    const line = call.line || 0;
    const root = segments[0] ?? '';
    const objectName = segments.length > 1 ? segments[segments.length - 2] ?? '' : '';
    const args = call.args.map(arg => this.argValue(arg, scope, roles));
    const kw = (key: string): Token[] | null => {
      const arg = call.args.find(a => a[0]?.t === 'id' && a[0].v === key && isPunc(a[1], '='));
      return arg || null;
    };
    const positional = call.args.map((arg, i) => ({ arg, value: args[i] ?? null })).filter(entry => !(entry.arg[0]?.t === 'id' && isPunc(entry.arg[1], '=')) && !isPunc(entry.arg[0], '**'));
    const first = positional[0] ? positional[0].value : null;
    const firstTokens = positional[0] ? positional[0].arg : [];
    const joined = segments.join('.');
    /* request.get_json(), request.args.get('x') */
    if (root === 'request' || (this.pyRoles && this.pyRoles.request && this.pyRoles.request.has(root))) {
      if (name === 'get_json' && segments.length === 2) return { value: taint('request body', this.ctx.path, line, { whole: true }) };
      if (receiver && /^(get|getlist|to_dict|items|values|keys)$/.test(name)) return { value: extend(receiver, this.ctx.path, line, 'read from the request') };
    }
    if (receiver && name === 'get' && this.pyRoles && this.pyRoles.lambda && root === this.pyRoles.lambda) return { value: receiver };
    /* Model replies. */
    if (MODEL_CHAINS.test(joined) || (/^(invoke|ainvoke|predict|run|generate)$/.test(name) && /^(llm|chain|model|agent|chat|qa|pipeline)$/i.test(objectName))) {
      return { value: taint('model reply', this.ctx.path, line, { note: 'a language model’s reply enters here' }) };
    }
    /* Sanitisers. */
    if (SANITISER.test(name) || /^(escape|quote|basename|secure_filename|UUID|int|float|bool|len|str\.isdigit)$/.test(name) || joined === 'os.path.basename' || joined === 're.escape' || joined === 'html.escape' || joined === 'shlex.quote' || joined === 'bleach.clean') {
      return { value: null };
    }
    const report = (kind: FlowSinkKind, value: Value | undefined): CallResult => { this.sink(kind, value, line); return { value: null }; };
    /* SQL: cursor.execute(built_string, params) */
    if (/^(execute|executemany|executescript|raw|exec_driver_sql)$/.test(name) && segments.length > 1 && first) {
      if (first.sql || (first.built && SQL_WORDS.test(literalText(firstTokens)))) return report('sql', first);
      if (/^text$/.test(root)) return report('sql', first);
    }
    if (name === 'text' && (root === 'sqlalchemy' || segments.length === 1) && first && first.built) return report('sql', first);
    /* Shell. */
    if ((joined === 'os.system' || joined === 'os.popen' || joined === 'commands.getoutput' || joined === 'subprocess.getoutput' || joined === 'subprocess.getstatusoutput') && first) return report('command', first);
    if (root === 'subprocess' && /^(run|call|Popen|check_output|check_call)$/.test(name) && first) {
      const shell = kw('shell');
      if (shell && !shell.some(t => t.v === 'False')) return report('command', first);
    }
    /* Code. */
    if (segments.length === 1 && (name === 'eval' || name === 'exec') && first) return report('code', first);
    /* Templates. */
    if ((name === 'render_template_string' || (name === 'Template' && /^(jinja2|Template|mako|string)$/.test(root)) || (joined === 'jinja2.Template')) && first) return report('template', first);
    if ((name === 'from_string' && /env|environment/i.test(objectName)) && first) return report('template', first);
    /* Outbound requests. */
    if ((/^(requests|httpx|aiohttp|urllib3|session|client|http)$/.test(root) && /^(get|post|put|patch|delete|head|request|options|urlopen)$/.test(name)) || name === 'urlopen' || joined === 'urllib.request.urlopen') {
      const target = name === 'request' ? positional[1] : positional[0];
      if (target && target.value) {
        const lead = leadingLiteral(target.arg);
        if (lead === null || !(ABSOLUTE_PREFIX.test(lead) || LOCAL_PATH_PREFIX.test(lead))) return report('ssrf', target.value);
      }
      return { value: null };
    }
    /* Files. */
    if ((segments.length === 1 && name === 'open') || /^(send_file|FileResponse)$/.test(name) || /^os\.(remove|unlink|rmdir|listdir|makedirs)$/.test(joined) || /^shutil\.(rmtree|copy|copyfile|move)$/.test(joined) || (name === 'read_text' || name === 'read_bytes' || name === 'write_text') && receiver) {
      const value = first || receiver;
      if (value) return report('path', value);
    }
    if (name === 'Path' && first) return { value: extend(first, this.ctx.path, line, 'made a path') };
    const joinedPart = joined === 'os.path.join' ? args.find(Boolean) : undefined;
    if (joinedPart) return { value: extend(joinedPart, this.ctx.path, line, 'joined into a path') };
    /* Redirects. */
    if ((name === 'redirect' || name === 'HttpResponseRedirect' || name === 'RedirectResponse') && first) {
      const lead = leadingLiteral(firstTokens);
      if (lead === null || !LOCAL_PATH_PREFIX.test(lead)) return report('redirect', first);
      return { value: null };
    }
    /* HTML. */
    if ((name === 'Markup' || name === 'mark_safe') && first) return report('html', first);
    if (/^(make_response|HttpResponse|HTMLResponse)$/.test(name) && first && first.html) return report('html', first);
    /* Deserialisers. */
    if ((/^(pickle|cPickle|_pickle|marshal|dill|shelve)$/.test(root) && /^loads?$/.test(name)) || joined === 'jsonpickle.decode' || joined === 'yaml.unsafe_load') {
      if (first) return report('deserialize', first);
    }
    if (joined === 'yaml.load' && first) {
      const loader = kw('Loader');
      if (!loader || !loader.some(t => /Safe|CSafe|Base/.test(t.v))) return report('deserialize', first);
    }
    /* lxml with a parser that resolves entities, loads DTDs or fetches from the network; xml.sax with external entities on */
    if (/^(fromstring|XML|parse|fromstringlist|parseString)$/.test(name) && /(^|\.)(etree|objectify|sax|lxml)(\.|$)/.test(joined) && first &&
      /XMLParser\s*\([^)]*(resolve_entities\s*=\s*True|load_dtd\s*=\s*True|no_network\s*=\s*False)|feature_external_ges\s*,\s*(True|1)/.test(this.ctx.text || '') &&
      !/defusedxml/.test(this.ctx.text || '')) return report('xxe', first);
    /* Regular expressions. */
    if (root === 're' && /^(compile|search|match|fullmatch|findall|finditer|sub|split)$/.test(name) && first) return report('regex', first);
    /* Document databases. */
    if (MONGO_METHODS.has(name) && segments.length > 1 && first && (first.whole || first.object)) return report('nosql', first);
    /* Records written as they arrived: Model(**request.json), Model.objects.create(**data). */
    const spread = args.find(value => value && value.spreadKw && value.whole);
    if (spread && (/^[A-Z]/.test(root) || /^(create|update|update_or_create|get_or_create|insert|add)$/.test(name))) return report('mass', spread);
    /* Helpers. */
    const summary = this.pySummary(segments);
    if (summary) {
      args.forEach((value, position) => {
        if (!value) return;
        for (const sink of summary.sinks.filter(entry => entry.param === position)) this.throughHelper(value, sink, line, null, scope, roles);
      });
      const returned = [...summary.returns].map(position => args[position]).find(Boolean);
      return { value: returned ? extend(returned, this.ctx.path, line, 'passed through a function') : null };
    }
    if (receiver) return { value: extend(receiver, this.ctx.path, line, 'transformed') };
    const any = args.find(Boolean);
    if (any && segments.length === 1 && !/^(print|len|isinstance|type|jsonify|abort|log|logger|range|enumerate|zip|sorted)$/.test(name)) return { value: extend(any, this.ctx.path, line, 'passed through a function') };
    if (any && joined === 'json.loads') return { value: any };
    if (any && /^(dumps|join|format|lower|upper|strip|replace|split|encode|decode|unquote|unquote_plus)$/.test(name)) return { value: extend(any, this.ctx.path, line, 'transformed') };
    return { value: null };
  }

  pySummary(segments: readonly string[]): Summary | null {
    const program = this.program;
    const only = segments.length === 1 ? segments[0] : undefined;
    if (only !== undefined) {
      const local = this.ctx.functions.get(only);
      if (local && local.summary) return local.summary;
      const imported = this.ctx.imports.get(only);
      if (imported) {
        const target = program.resolvePython(this.ctx.path, imported.module);
        if (target) return program.summary(target, imported.name);
      }
    }
    return null;
  }

  override chain(chain: Chain, scope: Scope, roles: Roles | null): Value {
    const segments = chain.segments;
    const line = this.tokens[chain.end - 1]?.line ?? 0;
    let value: Value = null;
    const found = this.pySource(segments);
    if (found) value = taint(found.kind, this.ctx.path, line, { whole: found.whole });
    else if (this.pyRoles && this.pyRoles.lambda && segments[0] === this.pyRoles.lambda) {
      /* event['body'] */
      value = null;
    } else {
      const held = scope.lookup(segments[0] ?? '');
      if (held) value = held;
    }
    for (const call of chain.calls) {
      if (call.computed) {
        const key = this.tokens.slice(call.open + 1, call.close);
        const only = key.length === 1 ? key[0] : undefined;
        if (this.pyRoles && this.pyRoles.lambda && segments[0] === this.pyRoles.lambda && isStr(only) && /^(body|queryStringParameters|pathParameters|headers)$/.test(only.v)) {
          value = taint(entryOf(REQUEST_FIELDS, only.v) || 'request body', this.ctx.path, line);
        }
        this.expression(call.open + 1, call.close, scope, roles);
        continue;
      }
      const result = this.call(segments.slice(0, call.index + 1), call, value, scope, roles);
      value = result ? result.value : value;
    }
    return value;
  }
}

function pyImports(lines: readonly LogicalLine[], ctx: FileContext): void {
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
    }
  }
}

function pyFunctions(lines: readonly LogicalLine[], ctx: FileContext): void {
  lines.forEach((line, index) => {
    const tokens = line.tokens;
    const defAt = isWord(tokens[0], 'def') ? 0 : isWord(tokens[0], 'async') && isWord(tokens[1], 'def') ? 1 : -1;
    const named = tokens[defAt + 1];
    if (defAt < 0 || !named) return;
    ctx.functions.set(named.v, { py: true, lineIndex: index, line: line.line, name: named.v, indent: line.indent, summary: null });
  });
}

/* ---- The program: every file, summaries across them -------------------------------- */

const JS_FILE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/;
const PY_FILE = /\.py$/;
const EXT_ORDER = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function normalise(parts: readonly string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

class Program {
  readonly files: Map<string, ReadableFile>;
  readonly contexts: Map<string, FileContext>;
  readonly summaries: Map<string, Summary>;
  readonly inProgress: Set<string>;
  hops: number;
  constructor(files: readonly ReadableFile[]) {
    this.files = new Map();
    for (const file of files) this.files.set(file.path, file);
    this.contexts = new Map();
    this.summaries = new Map();
    this.inProgress = new Set();
    this.hops = 0;
  }

  resolve(from: string, specifier: string): string | null {
    const dir = from.split('/').slice(0, -1);
    let base;
    if (specifier.startsWith('.')) base = normalise([...dir, ...specifier.split('/')]);
    else if (/^[@~]\//.test(specifier)) {
      const rest = specifier.slice(2);
      for (const prefix of ['', 'src/', 'app/']) {
        const found = this.find(normalise([...prefix.split('/'), ...rest.split('/')]));
        if (found) return found;
      }
      return null;
    } else return null;
    return this.find(base);
  }
  find(base: string): string | null {
    for (const ext of EXT_ORDER) {
      const candidate = `${base}${ext}`;
      if (this.files.has(candidate)) return candidate;
    }
    const stripped = base.replace(/\.(js|jsx|mjs)$/, '');
    if (stripped !== base) for (const ext of ['.ts', '.tsx']) if (this.files.has(`${stripped}${ext}`)) return `${stripped}${ext}`;
    return null;
  }
  resolvePython(from: string, module: string): string | null {
    const relative = /^\.+/.exec(module)?.[0];
    let parts;
    if (relative !== undefined) {
      const up = relative.length;
      const dir = from.split('/').slice(0, -1);
      parts = [...dir.slice(0, Math.max(0, dir.length - (up - 1))), ...module.slice(up).split('.').filter(Boolean)];
    } else parts = module.split('.');
    const base = parts.join('/');
    for (const candidate of [`${base}.py`, `${base}/__init__.py`]) if (this.files.has(candidate)) return candidate;
    /* A top-level package under src/ or app/. */
    for (const prefix of ['src/', 'app/', 'backend/', 'server/', 'api/']) {
      if (this.files.has(`${prefix}${base}.py`)) return `${prefix}${base}.py`;
    }
    return null;
  }

  context(path: string): FileContext | null {
    const known = this.contexts.get(path);
    if (known) return known;
    const file = this.files.get(path);
    if (!file) return null;
    let ctx: FileContext;
    if (JS_FILE.test(path)) {
      ctx = { ...fileContext(file, this), language: 'javascript', tokens: lexJs(file.text) };
      jsImports(ctx.tokens, ctx);
      jsExports(ctx.tokens, ctx);
      jsFunctions(ctx.tokens, ctx);
    } else if (PY_FILE.test(path)) {
      ctx = { ...fileContext(file, this), language: 'python', lines: lexPython(file.text) };
      pyImports(ctx.lines, ctx);
      pyFunctions(ctx.lines, ctx);
    } else return null;
    this.contexts.set(path, ctx);
    return ctx;
  }

  /* What a function's parameters reach, computed once and cached; a cycle reads as "nothing". */
  summary(path: string, name: string, local = false): Summary | null {
    const ctx = this.context(path);
    if (!ctx) return null;
    const own = local ? name : ctx.language === 'javascript' ? (ctx.exportsMap.get(name) || (name === 'default' ? null : name)) : name;
    return this.summaryOfLocal(ctx, path, own);
  }
  summaryOfLocal(ctx: FileContext, path: string, local: string | null): Summary | null {
    if (!local) return null;
    const key = `${path}#${local}`;
    const known = this.summaries.get(key);
    if (known) return known;
    if (this.inProgress.has(key)) return null;
    const entry = ctx.functions.get(local);
    if (!entry) return null;
    this.inProgress.add(key);
    const summary: Summary = { sinks: [], returns: new Set(), fn: 'fn' in entry ? entry.fn : undefined, name: local, line: 'py' in entry ? entry.line : undefined };
    if (ctx.language === 'javascript' && 'fn' in entry) {
      const walker = new JsWalker(ctx.tokens, { ...ctx, flows: [], routes: [], handlerHints: new Map(), namedHandlers: new Map() }, 'summary', this);
      walker.summaryOf = summary;
      walker.enterFunction(entry.fn, new Scope(null), null, local);
    } else if (ctx.language === 'python' && 'py' in entry) {
      const walker = new PyWalker(ctx.lines, { ...ctx, flows: [], routes: [] }, 'summary', this);
      walker.summaryOf = summary;
      const line = ctx.lines[entry.lineIndex];
      if (line) {
        const defAt = isWord(line.tokens[0], 'def') ? 0 : 1;
        const end = walker.blockEnd(entry.lineIndex + 1, ctx.lines.length, line.indent);
        walker.pyFunction(line, defAt, entry.lineIndex + 1, end, new Scope(null), null, []);
      }
    }
    this.inProgress.delete(key);
    entry.summary = summary;
    this.summaries.set(key, summary);
    this.hops += 1;
    return summary;
  }
}

/*
 * Every flow in a set of files. `files` are { path, text, client } with the
 * text already read; nothing here reads anything else.
 */
/*
 * Server code first when there is a time limit: what a caller reaches is
 * what an audit cut short should already have followed. Browser code last.
 */
const SERVER_PATH = /(^|\/)(api|server|servers|routes?|routers?|controllers?|handlers?|middlewares?|functions|backend|actions)\/|(^|\/)(server|app|main|index|routes?|router|api)\.(m?[jt]sx?|cjs|py)$|(^|\/)route\.(m?[jt]sx?)$|\.server\./;
const traceRank = (file: ReadableFile): number => (file.client ? 2 : SERVER_PATH.test(file.path) ? 0 : 1);

export interface FlowOptions {
  readonly maxBytes?: number;
  readonly deadline?: number;
  readonly heapCeiling?: number;
  readonly now?: () => number;
  readonly heapUsed?: () => number;
}
export interface FlowStats {
  javascript: number;
  python: number;
  go: number;
  java: number;
  php: number;
  functions: number;
  routes: number;
  flows: number;
  helpers: number;
  cut: number;
  failed?: number;
  deep?: number;
  limit?: 'time' | 'memory' | null;
}
export type TracedFlowRecord = FlowRecord | Flow;
export type TracedRoute = FlowRoute | CFamilyReading['routes'][number];
export interface FlowReading {
  readonly flows: TracedFlowRecord[];
  readonly routes: TracedRoute[];
  readonly settled: Settled[];
  readonly stats: FlowStats;
}

/*
 * `options.deadline` is a clock time after which no further file is
 * started, and `options.heapCeiling` a heap size in bytes past which none
 * is either. The files not reached are counted as `cut`, never guessed at,
 * `stats.limit` says which bound stopped the trace, and what was traced is
 * reported as it would have been. The output keeps the files' own order
 * whichever order they were walked in, so a run with room to spare is the
 * same run without a limit.
 */
function isReadable(file: FlowFile): file is ReadableFile {
  return typeof file.text === 'string';
}

export function analyseFlows(files: readonly FlowFile[], options: FlowOptions = {}): FlowReading {
  const maxBytes = options.maxBytes || 512 * 1024;
  const readable = files.filter(isReadable);
  const sources = readable.filter(file => (JS_FILE.test(file.path) || PY_FILE.test(file.path)) &&
    file.text.length <= maxBytes && !/\.min\.js$|\.d\.ts$/.test(file.path));
  /* Go, Java and PHP are read by their own tracer, under the same limits. */
  const cfamily = readable.filter(file => CFAMILY_FILE.test(file.path) && file.text.length <= maxBytes);
  const deadline = options.deadline !== undefined && Number.isFinite(options.deadline) ? options.deadline : Infinity;
  const ceiling = options.heapCeiling !== undefined && Number.isFinite(options.heapCeiling) ? options.heapCeiling : Infinity;
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const heapUsed = typeof options.heapUsed === 'function' ? options.heapUsed : () => getHeapStatistics().used_heap_size;
  let limit: 'time' | 'memory' | null = null;
  const late = () => {
    if (!limit && deadline !== Infinity && clock() > deadline) limit = 'time';
    if (!limit && ceiling !== Infinity && heapUsed() > ceiling) limit = 'memory';
    return Boolean(limit);
  };
  const program = new Program(sources);
  const stats: FlowStats = { javascript: 0, python: 0, go: 0, java: 0, php: 0, functions: 0, routes: 0, flows: 0, helpers: 0, cut: 0 };
  const counted = new Map<string, { language: FileContext['language']; functions: number }>();
  /* Summaries for every local function first, so a call reads its callee's summary. */
  for (const file of sources) {
    if (late()) break;
    const ctx = program.context(file.path);
    if (!ctx) continue;
    stats[ctx.language] += 1;
    counted.set(file.path, { language: ctx.language, functions: ctx.functions.size });
    stats.functions += ctx.functions.size;
    for (const name of ctx.functions.keys()) program.summary(file.path, name, true);
  }
  /* Go, Java and PHP are server code: traced before the browser code is walked. */
  let other: Pick<CFamilyReading, 'flows' | 'routes'> & { readonly settled?: CFamilyReading['settled'] } = { flows: [], routes: [] };
  if (cfamily.length) {
    try {
      const reading = analyseCFamily(cfamily, { late, maxBytes });
      other = reading;
      for (const key of ['go', 'java', 'php', 'functions', 'cut'] as const) stats[key] += reading.stats[key] || 0;
      if (reading.stats.failed) stats.failed = (stats.failed || 0) + reading.stats.failed;
    } catch {
      stats.failed = (stats.failed || 0) + cfamily.length;
    }
  }
  const order = sources.map((file, index) => ({ file, index })).sort((a, b) => traceRank(a.file) - traceRank(b.file) || a.index - b.index);
  const walked: (FileContext | undefined)[] = new Array(sources.length);
  for (const { file, index } of order) {
    if (!counted.has(file.path) || late()) {
      /* A file summarised but not walked was not traced: it is counted as cut, not as read. */
      const summarised = counted.get(file.path);
      if (summarised) { stats[summarised.language] -= 1; stats.functions -= summarised.functions; }
      stats.cut += 1;
      continue;
    }
    const ctx = program.context(file.path);
    if (!ctx) continue;
    const flowCtx: FileContext = { ...ctx, flows: [], routes: [], settled: [], client: file.client };
    try {
      if (flowCtx.language === 'javascript') {
        jsRoutes(flowCtx.tokens, flowCtx);
        fileRoutes(flowCtx.tokens, flowCtx);
        const walker = new JsWalker(flowCtx.tokens, flowCtx, 'flow', program);
        walker.walk(0, flowCtx.tokens.length, new Scope(null), null);
      } else {
        const walker = new PyWalker(flowCtx.lines, flowCtx, 'flow', program);
        walker.run();
      }
    } catch {
      /* A file the walker cannot follow is reported as read but not traced. */
      stats.failed = (stats.failed || 0) + 1;
      continue;
    }
    /* Followed, but with expressions nested past what the walker reads: said, not hidden. */
    if (flowCtx.tooDeep) stats.deep = (stats.deep || 0) + 1;
    for (const route of flowCtx.routes) {
      const { bodyStart, bodyEnd, bodyStartLine, bodyEndLine } = route;
      if (flowCtx.language === 'javascript' && typeof bodyStart === 'number' && typeof bodyEnd === 'number') {
        route.bodyText = flowCtx.tokens.slice(bodyStart, bodyEnd).map(t => (t.t === 'tpl' ? t.parts.join(' ') : t.v)).join(' ');
        route.startLine = flowCtx.tokens[bodyStart]?.line ?? route.line;
        route.endLine = flowCtx.tokens[bodyEnd]?.line ?? route.line;
      }
      if (flowCtx.language === 'python' && bodyStartLine !== undefined && bodyEndLine !== undefined) {
        route.bodyText = flowCtx.lines.filter(l => l.line >= bodyStartLine && l.line <= bodyEndLine).map(l => l.tokens.map(t => (t.t === 'tpl' ? t.parts.join(' ') : t.v)).join(' ')).join('\n');
        route.startLine = bodyStartLine;
        route.endLine = bodyEndLine;
      }
      route.uses = flowCtx.uses || [];
    }
    walked[index] = flowCtx;
  }
  let flows: TracedFlowRecord[] = [];
  let routes: TracedRoute[] = [];
  /* names a check settled, with the lines over which it holds: what makes a pattern lead on them moot */
  const settled: Settled[] = [...(other.settled || [])];
  for (const flowCtx of walked) {
    if (!flowCtx) continue;
    routes.push(...flowCtx.routes);
    flows.push(...flowCtx.flows);
    for (const entry of flowCtx.settled || []) settled.push({ path: flowCtx.path, ...entry });
  }
  if (other.flows.length || other.routes.length) {
    /* In the files' own order, whichever tracer read them. */
    const position = new Map(files.map((file, index) => [file.path, index]));
    const byFile = (a: { readonly path: string }, b: { readonly path: string }): number => (position.get(a.path) ?? 0) - (position.get(b.path) ?? 0);
    flows = [...flows, ...other.flows].sort(byFile);
    routes = [...routes, ...other.routes].sort(byFile);
  }
  stats.routes = routes.length;
  stats.flows = flows.length;
  stats.helpers = flows.filter(flow => flow.viaHelper).length;
  if (stats.cut) stats.limit = limit;
  return { flows: dedupe(flows), routes, settled, stats };
}

/* One flow per rule and sink line: several sources into one call are one finding with the first trace. */
function dedupe<T extends { readonly rule: string; readonly path: string; readonly line: number; readonly verdict: string }>(flows: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const flow of flows) {
    const key = `${flow.rule}\0${flow.path}\0${flow.line}`;
    const existing = seen.get(key);
    if (!existing || (existing.verdict !== 'confirmed' && flow.verdict === 'confirmed')) seen.set(key, flow);
  }
  return [...seen.values()];
}
